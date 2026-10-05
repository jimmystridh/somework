//! Lease keep-alive: extends the lease (and with it the task grant) well before it expires, and reports loss of the
//! lease (stale fencing token, expiry) or a cooperative cancellation request to the running work.

use std::{sync::Arc, time::Duration};

use somework_client::Client;
use somework_core::ErrorCode;
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
pub struct LeaseHandle {
    pub fencing_token: u64,
    stop: CancellationToken,
    lost: watch::Receiver<bool>,
    cancel_requested: watch::Receiver<bool>,
}

impl LeaseHandle {
    pub fn stop(&self) {
        self.stop.cancel();
    }

    pub fn is_lost(&self) -> bool {
        *self.lost.borrow()
    }

    pub fn is_cancel_requested(&self) -> bool {
        *self.cancel_requested.borrow()
    }

    pub async fn lost(&self) {
        let mut rx = self.lost.clone();
        while !*rx.borrow() {
            if rx.changed().await.is_err() {
                std::future::pending::<()>().await;
            }
        }
    }

    pub async fn cancel_requested(&self) {
        let mut rx = self.cancel_requested.clone();
        while !*rx.borrow() {
            if rx.changed().await.is_err() {
                std::future::pending::<()>().await;
            }
        }
    }
}

fn is_lease_loss(code: ErrorCode) -> bool {
    matches!(
        code,
        ErrorCode::StaleFencingToken
            | ErrorCode::LeaseExpired
            | ErrorCode::TaskTerminal
            | ErrorCode::InvalidTransition
            | ErrorCode::NotFound
            | ErrorCode::PolicyDenied
    )
}

pub fn spawn_keepalive(client: Client, task_id: String, fencing_token: u64, lease_seconds: i64, ratio: f64) -> LeaseHandle {
    let stop = CancellationToken::new();
    let (lost_tx, lost_rx) = watch::channel(false);
    let (cancel_tx, cancel_rx) = watch::channel(false);
    let handle = LeaseHandle { fencing_token, stop: stop.clone(), lost: lost_rx, cancel_requested: cancel_rx };
    let interval = Duration::from_millis(((lease_seconds as f64 * ratio.clamp(0.05, 0.9)) * 1000.0).max(100.0) as u64);
    let token = stop.clone();
    tokio::spawn(async move {
        let lease = Duration::from_secs(lease_seconds.max(1) as u64);
        let mut last_ok = tokio::time::Instant::now();
        loop {
            tokio::select! {
                _ = token.cancelled() => break,
                _ = tokio::time::sleep(interval) => {},
            }
            match client.heartbeat_task(&task_id, fencing_token, Some(lease_seconds)).await {
                Ok(resp) => {
                    last_ok = tokio::time::Instant::now();
                    if resp["cancelRequested"].as_bool().unwrap_or(false) {
                        let _ = cancel_tx.send(true);
                    }
                }
                Err(e) if is_lease_loss(e.code) => {
                    tracing::warn!(task = %task_id, code = ?e.code, "lease lost");
                    let _ = lost_tx.send(true);
                    break;
                }
                Err(e) => {
                    tracing::warn!(task = %task_id, error = %e, "heartbeat failed; will retry");
                    if last_ok.elapsed() >= lease {
                        let _ = lost_tx.send(true);
                        break;
                    }
                }
            }
        }
    });
    handle
}

pub type Leases = Arc<std::sync::Mutex<std::collections::HashMap<String, LeaseHandle>>>;

use std::sync::{Arc, Mutex};

use chrono::{DateTime, Duration, SecondsFormat, Utc};

pub trait Clock: Send + Sync + 'static {
    fn now(&self) -> DateTime<Utc>;
}

#[derive(Debug, Default, Clone, Copy)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> DateTime<Utc> {
        Utc::now()
    }
}

/// Deterministic clock for tests: lease expiry, deadlines and token expiry can be exercised without sleeping.
#[derive(Debug, Clone)]
pub struct ManualClock {
    inner: Arc<Mutex<DateTime<Utc>>>,
}

impl ManualClock {
    pub fn new(start: DateTime<Utc>) -> Self {
        Self { inner: Arc::new(Mutex::new(start)) }
    }

    pub fn advance(&self, by: Duration) {
        let mut guard = self.inner.lock().expect("clock mutex poisoned");
        *guard += by;
    }

    pub fn set(&self, to: DateTime<Utc>) {
        *self.inner.lock().expect("clock mutex poisoned") = to;
    }
}

impl Clock for ManualClock {
    fn now(&self) -> DateTime<Utc> {
        *self.inner.lock().expect("clock mutex poisoned")
    }
}

pub type SharedClock = Arc<dyn Clock>;

pub fn system_clock() -> SharedClock {
    Arc::new(SystemClock)
}

/// All timestamps are stored and exchanged as RFC 3339 UTC with millisecond precision. The fixed width keeps
/// lexicographic order identical to chronological order, which SQLite comparisons rely on.
pub fn ts(at: DateTime<Utc>) -> String {
    at.to_rfc3339_opts(SecondsFormat::Millis, true)
}

pub fn parse_ts(raw: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(raw).ok().map(|d| d.with_timezone(&Utc))
}

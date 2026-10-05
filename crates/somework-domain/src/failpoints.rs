//! Fault injection for chaos tests. Failpoints are inert unless armed through `SOMEWORK_FAILPOINTS`
//! (`name=action[;name=action]`, action: `exit`, `sleep:<ms>`, `error`) or programmatically in-process.

use std::{collections::HashMap, sync::Arc, time::Duration};

use parking_lot::RwLock;
use somework_core::Error;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FailAction {
    /// Hard-kill the process, simulating a pod dying at a precisely chosen point.
    Exit,
    Sleep(Duration),
    Error,
}

#[derive(Clone, Default)]
pub struct Failpoints {
    inner: Arc<RwLock<HashMap<String, FailAction>>>,
}

impl Failpoints {
    pub fn from_env() -> Self {
        let fp = Self::default();
        if let Ok(spec) = std::env::var("SOMEWORK_FAILPOINTS") {
            fp.arm_from_spec(&spec);
        }
        fp
    }

    pub fn arm_from_spec(&self, spec: &str) {
        for item in spec.split(';').filter(|s| !s.trim().is_empty()) {
            if let Some((name, action)) = item.split_once('=') {
                let action = match action.trim() {
                    "exit" => FailAction::Exit,
                    "error" => FailAction::Error,
                    other => match other.strip_prefix("sleep:").and_then(|ms| ms.parse().ok()) {
                        Some(ms) => FailAction::Sleep(Duration::from_millis(ms)),
                        None => continue,
                    },
                };
                self.arm(name.trim(), action);
            }
        }
    }

    pub fn arm(&self, name: &str, action: FailAction) {
        self.inner.write().insert(name.to_string(), action);
    }

    pub fn disarm(&self, name: &str) {
        self.inner.write().remove(name);
    }

    pub fn clear(&self) {
        self.inner.write().clear();
    }

    pub async fn hit(&self, name: &str) -> Result<(), Error> {
        let action = self.inner.read().get(name).cloned();
        match action {
            None => Ok(()),
            Some(FailAction::Exit) => {
                eprintln!("failpoint {name}: exiting");
                std::process::exit(137)
            }
            Some(FailAction::Sleep(d)) => {
                tokio::time::sleep(d).await;
                Ok(())
            }
            Some(FailAction::Error) => Err(Error::internal(format!("failpoint {name} triggered"))),
        }
    }
}

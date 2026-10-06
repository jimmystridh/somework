use chrono::DateTime;

pub mod somework;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Fleet {
    pub observed_at: Option<String>,
    pub error: Option<String>,
    pub machines: Vec<Machine>,
    pub storage: Vec<Storage>,
    pub agents: Vec<Agent>,
    pub server_time: String,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Machine {
    pub id: String,
    pub vm_id: Option<u64>,
    pub name: String,
    pub kind: String,
    pub node: String,
    pub role: String,
    pub status: String,
    pub cpu_percent: Option<f64>,
    pub cores: Option<u64>,
    pub memory_bytes: Option<f64>,
    pub memory_limit: Option<f64>,
    pub memory_percent: Option<f64>,
    pub disk_provisioned: Option<f64>,
    pub uptime_seconds: Option<f64>,
    pub network_in: Option<f64>,
    pub network_out: Option<f64>,
    pub history: Vec<Sample>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Sample {
    pub time: f64,
    pub cpu_percent: Option<f64>,
    pub memory_bytes: Option<f64>,
    pub network_in: Option<f64>,
    pub network_out: Option<f64>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Storage {
    pub name: String,
    pub used: Option<f64>,
    pub total: Option<f64>,
    pub status: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentState {
    Idle,
    Working,
    Offline,
    #[default]
    Unknown,
}

impl AgentState {
    pub fn label(&self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Working => "working",
            Self::Offline => "offline",
            Self::Unknown => "unknown",
        }
    }
    pub fn online(&self) -> bool {
        matches!(self, Self::Idle | Self::Working)
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Heartbeat {
    pub id: String,
    pub state: AgentState,
    pub observed_at: String,
    pub model: Option<String>,
    pub provider: Option<String>,
    pub thinking: Option<String>,
    pub session_id: Option<String>,
    pub version: Option<String>,
    pub cpu_percent: Option<f64>,
    pub memory_bytes: Option<f64>,
    pub memory_limit: Option<f64>,
    pub uptime_seconds: Option<f64>,
    pub messages: Option<u64>,
    pub tokens: Option<u64>,
    pub cost: Option<f64>,
    pub last_activity_at: Option<String>,
}

impl Heartbeat {
    pub fn validate(&mut self, now_ms: i64) -> Result<(), &'static str> {
        if self.id != "pi-demo" {
            return Err("Invalid agent");
        }
        let timestamp = timestamp_ms(&self.observed_at).ok_or("Invalid timestamp")?;
        if now_ms.abs_diff(timestamp) > 120_000 {
            return Err("Heartbeat outside allowed time window");
        }
        for text in [
            &mut self.model,
            &mut self.provider,
            &mut self.thinking,
            &mut self.session_id,
            &mut self.version,
        ]
        .into_iter()
        .flatten()
        {
            *text = text.chars().take(120).collect();
        }
        if self
            .last_activity_at
            .as_deref()
            .and_then(timestamp_ms)
            .is_none()
        {
            self.last_activity_at = None;
        }
        for value in [
            &mut self.cpu_percent,
            &mut self.memory_bytes,
            &mut self.memory_limit,
            &mut self.uptime_seconds,
            &mut self.cost,
        ] {
            *value = value.filter(|number| number.is_finite() && *number >= 0.0);
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Agent {
    #[serde(flatten)]
    pub heartbeat: Heartbeat,
    pub name: String,
    pub host: String,
    pub vm_id: u64,
    pub workspace: String,
    pub browser: String,
    pub channel: String,
    pub stale: bool,
}

impl Agent {
    pub fn from_heartbeat(heartbeat: Option<Heartbeat>, now_ms: i64) -> Self {
        let mut heartbeat = heartbeat.unwrap_or_else(|| Heartbeat {
            id: "pi-demo".into(),
            ..Default::default()
        });
        let stale = timestamp_ms(&heartbeat.observed_at)
            .is_none_or(|time| now_ms.saturating_sub(time) > 60_000);
        if stale {
            heartbeat.state = AgentState::Unknown;
        }
        Self {
            heartbeat,
            name: "Pi".into(),
            host: "admin-cloud-agents".into(),
            vm_id: 102,
            workspace: "/workspace".into(),
            browser: "Lightpanda 1.0.0".into(),
            channel: "Telegram".into(),
            stale,
        }
    }
}

pub fn timestamp_ms(value: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|time| time.timestamp_millis())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn heartbeat() -> Heartbeat {
        serde_json::from_str(r#"{"id":"pi-demo","state":"idle","observedAt":"2026-10-03T15:00:00Z","prompt":"PRIVATE","token":"SECRET"}"#).unwrap()
    }
    #[test]
    fn content_and_credentials_are_not_in_the_schema() {
        let mut value = heartbeat();
        value
            .validate(timestamp_ms("2026-10-03T15:00:00Z").unwrap())
            .unwrap();
        let encoded = serde_json::to_string(&value).unwrap();
        assert!(!encoded.contains("PRIVATE"));
        assert!(!encoded.contains("SECRET"));
    }
    #[test]
    fn stale_readings_never_claim_idle() {
        let time = timestamp_ms("2026-10-03T15:00:00Z").unwrap();
        assert_eq!(
            Agent::from_heartbeat(Some(heartbeat()), time + 59_000)
                .heartbeat
                .state,
            AgentState::Idle
        );
        assert_eq!(
            Agent::from_heartbeat(Some(heartbeat()), time + 61_000)
                .heartbeat
                .state,
            AgentState::Unknown
        );
        assert!(Agent::from_heartbeat(None, time).stale);
    }
    #[test]
    fn rejects_invalid_identity_and_time() {
        let time = timestamp_ms("2026-10-03T15:00:00Z").unwrap();
        assert!(heartbeat().validate(time + 121_000).is_err());
        let mut value = heartbeat();
        value.id = "other".into();
        assert!(value.validate(time).is_err());
        assert!(
            serde_json::from_str::<Heartbeat>(
                r#"{"id":"pi-demo","state":"running","observedAt":"x"}"#
            )
            .is_err()
        );
    }
}

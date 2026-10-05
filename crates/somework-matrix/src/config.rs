use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default)]
pub struct MatrixConfig {
    pub homeserver_url: String,
    /// Matrix server name used in user ids and room aliases (`@_agent_x:<server_name>`).
    pub server_name: String,
    /// Token the bridge presents to the homeserver (registration `as_token`).
    pub as_token: String,
    /// Token the homeserver presents to the bridge (registration `hs_token`).
    pub hs_token: String,
    /// Additional tokens accepted during a rotation window.
    pub previous_hs_tokens: Vec<String>,
    pub sender_localpart: String,
    /// Prefix of virtual agent localparts; the registration's exclusive user namespace is `@<prefix>.*`.
    pub agent_prefix: String,
    /// Room power levels applied at creation (bot is admin; everybody else may talk).
    pub default_users_power_level: i64,
    /// Public URL of this appservice as configured in the homeserver registration.
    pub appservice_url: String,
    pub progress_throttle_ms: u64,
    /// Matrix federation limit is 65 536 bytes for a complete event; larger projections are replaced by a reference.
    pub max_event_bytes: usize,
    /// Events older than this are ignored on ingestion (stale replays).
    pub ignore_events_older_than_secs: i64,
    /// Observer account invited to E2EE rooms in the `encrypted_with_observer` profile.
    pub observer_user: Option<String>,
    pub request_timeout_ms: u64,
    pub crypto: CryptoSettings,
}

/// Megolm/Olm lifecycle limits for the encrypted profiles.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default)]
pub struct CryptoSettings {
    /// Rotate an outbound Megolm session after this many messages.
    pub max_messages: i64,
    /// ... or after this age.
    pub max_age_secs: u64,
    /// How long a queried device list is trusted before re-querying.
    pub device_cache_ms: u64,
}

impl Default for CryptoSettings {
    fn default() -> Self {
        Self { max_messages: 100, max_age_secs: 7 * 24 * 3600, device_cache_ms: 10_000 }
    }
}

impl Default for MatrixConfig {
    fn default() -> Self {
        Self {
            homeserver_url: String::new(),
            server_name: "localhost".into(),
            as_token: String::new(),
            hs_token: String::new(),
            previous_hs_tokens: vec![],
            sender_localpart: "somework".into(),
            agent_prefix: "_agent_".into(),
            default_users_power_level: 0,
            appservice_url: "http://127.0.0.1:8080".into(),
            progress_throttle_ms: 750,
            max_event_bytes: 65_536,
            ignore_events_older_than_secs: 3600,
            observer_user: None,
            request_timeout_ms: 10_000,
            crypto: CryptoSettings::default(),
        }
    }
}

impl MatrixConfig {
    pub fn bot_user_id(&self) -> String {
        format!("@{}:{}", self.sender_localpart, self.server_name)
    }

    /// `@_agent_` + reversible slug of the agent id (`/` and other special characters become `=xx`).
    pub fn agent_user_id(&self, agent_id: &str) -> String {
        format!("@{}{}:{}", self.agent_prefix, slug(agent_id), self.server_name)
    }

    pub fn agent_id_from_user(&self, user_id: &str) -> Option<String> {
        let local = user_id.strip_prefix('@')?.split(':').next()?;
        let slug = local.strip_prefix(self.agent_prefix.as_str())?;
        unslug(slug)
    }

    pub fn is_virtual_user(&self, user_id: &str) -> bool {
        user_id.strip_prefix('@').is_some_and(|rest| rest.starts_with(self.agent_prefix.as_str()))
    }

    pub fn is_bot(&self, user_id: &str) -> bool {
        user_id == self.bot_user_id()
    }
}

pub fn slug(raw: &str) -> String {
    let mut out = String::new();
    for b in raw.bytes() {
        if b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'.' | b'_' | b'-') {
            out.push(b as char);
        } else {
            out.push_str(&format!("={b:02x}"));
        }
    }
    out
}

pub fn unslug(slug: &str) -> Option<String> {
    let bytes = slug.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'=' {
            out.push(u8::from_str_radix(slug.get(i + 1..i + 3)?, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// `registration.yaml` for the homeserver (spec: AppService with an exclusive agent namespace).
pub fn registration_yaml(cfg: &MatrixConfig) -> String {
    let server = regex_escape(&cfg.server_name);
    format!(
        "id: somework\nurl: {url}\nas_token: {as_token}\nhs_token: {hs_token}\nsender_localpart: {sender}\nrate_limited: false\nnamespaces:\n  users:\n    - exclusive: true\n      regex: \"@{prefix}.*:{server}\"\n  aliases:\n    - exclusive: true\n      regex: \"#somework-.*:{server}\"\n  rooms: []\n",
        url = cfg.appservice_url,
        as_token = cfg.as_token,
        hs_token = cfg.hs_token,
        sender = cfg.sender_localpart,
        prefix = regex_escape(&cfg.agent_prefix),
    )
}

fn regex_escape(s: &str) -> String {
    s.chars().flat_map(|c| if c == '.' { vec!['\\', '\\', '.'] } else { vec![c] }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_ids_roundtrip_through_virtual_user_ids() {
        let cfg = MatrixConfig::default();
        for id in ["agent/dev-investigator", "agent/Reviewer.v2", "x"] {
            let user = cfg.agent_user_id(id);
            assert!(cfg.is_virtual_user(&user));
            assert_eq!(cfg.agent_id_from_user(&user).as_deref(), Some(id));
        }
        assert!(!cfg.is_virtual_user("@alice:localhost"));
    }

    #[test]
    fn registration_reserves_the_exclusive_agent_namespace() {
        let yaml = registration_yaml(&MatrixConfig { as_token: "a".into(), hs_token: "h".into(), ..Default::default() });
        assert!(yaml.contains("exclusive: true"));
        assert!(yaml.contains("@_agent_.*:localhost"));
        assert!(yaml.contains("sender_localpart: somework"));
    }
}

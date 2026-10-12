//! The reconcile loop (every 15 seconds): read each agent's `/profile`, remember what it reports as applied, and send what is missing.
//!
//! The document is the complete desired state, so a missed or repeated message does not matter; the loop only has to make sure the
//! latest one arrives. A revision is sent at once when it was never sent; it is sent again at most once a minute while the agent reports an
//! older one; a failure is retried with a growing pause and shown, never dropped.

use super::{
    contract,
    delivery::{Deliverer, Document},
    store::{DeliveryRow, Store},
};
use crate::{events::AgentTarget, setup, somework::identifier};
use chrono::{DateTime, Utc};
use fleet_shared::operations::*;
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
    time::Duration,
};
use tokio::sync::{Mutex, Notify, RwLock};

pub const TICK: Duration = Duration::from_secs(15);
const RESEND_AFTER_SECONDS: i64 = 60;
const SEND_TIMEOUT: Duration = Duration::from_secs(30);

/// What the last read of an agent's profile showed.
#[derive(Clone, Debug)]
pub struct Observation {
    /// The profile answered in the last read.
    pub reachable: bool,
    /// The profile carries a `setup` report.
    pub reports_setup: bool,
    pub role: Option<String>,
    pub reported: ReportedSetup,
    pub defaults: Option<RoleDefaults>,
    pub checked_at: DateTime<Utc>,
}

pub type Observations = RwLock<BTreeMap<String, Observation>>;

pub fn observe_profile(profile: &Value, now: DateTime<Utc>) -> Observation {
    let reported = setup::reported_setup(profile);
    Observation { reachable: true, reports_setup: reported.is_some(), role: identifier(profile.get("role")), reported: reported.unwrap_or_default(), defaults: setup::role_defaults(profile), checked_at: now }
}

/// Everything the decision to send depends on, for one agent and one kind of document.
#[derive(Clone, Debug)]
pub struct Facts {
    /// The newest revision saved (0: nothing to send).
    pub saved: u64,
    /// The revision the agent reports as applied.
    pub applied: Option<u64>,
    /// Can the effect be seen: the profile answered and reports `setup`.
    pub observable: bool,
    /// The revision the agent reports having rejected.
    pub rejected: Option<u64>,
    pub sent: Option<u64>,
    pub sent_at: Option<DateTime<Utc>>,
    pub failures: u64,
    pub failed_at: Option<DateTime<Utc>>,
    /// An operator asked for a re-send.
    pub force: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Plan {
    Nothing,
    /// `again` is `None` for the first send of a revision, and a token for a deliberate re-send.
    Send { again: Option<u64> },
}

/// The pause after `failures` failures in a row: 15 s, 30 s, then a minute.
fn backoff_seconds(failures: u64) -> i64 {
    (15i64 << failures.saturating_sub(1).min(2)).min(60)
}

pub fn plan(facts: &Facts, now: DateTime<Utc>) -> Plan {
    if facts.saved == 0 || facts.applied.is_some_and(|applied| applied >= facts.saved) {
        return Plan::Nothing;
    }
    let waiting_after_failure = facts.failures > 0 && facts.failed_at.is_some_and(|at| (now - at).num_seconds() < backoff_seconds(facts.failures));
    if waiting_after_failure && !facts.force {
        return Plan::Nothing;
    }
    if facts.sent.is_none_or(|sent| sent < facts.saved) {
        return Plan::Send { again: None };
    }
    let token = Some(now.timestamp().max(0) as u64);
    if facts.force {
        return Plan::Send { again: token };
    }
    // the revision was accepted by the domain: only an agent that is seen to lag, and has not refused it, is told again
    if !facts.observable || facts.rejected.is_some_and(|rejected| rejected >= facts.saved) {
        return Plan::Nothing;
    }
    if facts.sent_at.is_some_and(|at| (now - at).num_seconds() < RESEND_AFTER_SECONDS) {
        return Plan::Nothing;
    }
    Plan::Send { again: token }
}

pub struct Reconciler {
    pub store: Store,
    pub deliverer: Option<Arc<Deliverer>>,
    pub targets: Vec<AgentTarget>,
    pub http: reqwest::Client,
    pub observations: Arc<Observations>,
    pub nudge: Arc<Notify>,
    gate: Mutex<()>,
    forced: Mutex<BTreeSet<String>>,
}

impl Reconciler {
    pub fn new(store: Store, deliverer: Option<Arc<Deliverer>>, targets: Vec<AgentTarget>, http: reqwest::Client, observations: Arc<Observations>, nudge: Arc<Notify>) -> Self {
        Self { store, deliverer, targets, http, observations, nudge, gate: Mutex::new(()), forced: Mutex::new(BTreeSet::new()) }
    }

    /// Runs until the process ends: every tick, and at once when somebody saved.
    pub async fn run(self: Arc<Self>) {
        let mut interval = tokio::time::interval(TICK);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tokio::select! { _ = interval.tick() => {}, _ = self.nudge.notified() => {} }
            self.tick().await;
        }
    }

    pub async fn force(&self, agent: &str) {
        self.forced.lock().await.insert(agent.to_string());
        self.nudge.notify_one();
    }

    pub async fn tick(&self) {
        let _one_at_a_time = self.gate.lock().await;
        self.observe().await;
        if let Err(error) = self.deliver().await {
            eprintln!("Operations delivery could not read the database: {error:?}");
        }
    }

    async fn observe(&self) {
        let mut reads = tokio::task::JoinSet::new();
        for target in &self.targets {
            let (http, id, url) = (self.http.clone(), target.id.clone(), crate::events::profile_url(&target.url));
            reads.spawn(async move {
                let profile = match url {
                    Some(url) => crate::events::fetch_json(&http, &url).await,
                    None => None,
                };
                (id, profile)
            });
        }
        let now = Utc::now();
        while let Some(Ok((id, profile))) = reads.join_next().await {
            let observation = match &profile {
                Some(profile) => observe_profile(profile, now),
                None => {
                    // keep what was last seen for display, but say it could not be read now
                    let mut old = self.observations.read().await.get(&id).cloned().unwrap_or(Observation { reachable: false, reports_setup: false, role: None, reported: ReportedSetup::default(), defaults: None, checked_at: now });
                    old.reachable = false;
                    old
                }
            };
            if observation.reachable && observation.reports_setup {
                let rejected = |kind: &str| observation.reported.rejected.as_ref().filter(|r| r.kind == kind).map(|r| (r.revision, r.reason.clone(), r.at.as_deref().and_then(|at| DateTime::parse_from_rfc3339(at).ok()).map(|at| at.with_timezone(&Utc))));
                for (kind, revision) in [("override", observation.reported.override_revision), ("limits", observation.reported.limits_revision)] {
                    let rejection = rejected(kind);
                    let outcome = self.store.record_reported(&id, kind, revision, rejection.as_ref().map(|(n, reason, at)| (*n, reason.as_str(), *at))).await;
                    if outcome.is_err() {
                        eprintln!("Operations could not record what {id} reports");
                    }
                }
            }
            self.observations.write().await.insert(id, observation);
        }
    }

    async fn deliver(&self) -> Result<(), super::store::StoreError> {
        let Some(deliverer) = self.deliverer.clone() else { return Ok(()) };
        let saved = self.store.latest_setups().await?;
        let limits = self.store.latest_limits().await?;
        let rows = self.store.delivery_rows().await?;
        let forced = std::mem::take(&mut *self.forced.lock().await);
        let mut agents: BTreeSet<String> = self.targets.iter().map(|target| target.id.clone()).collect();
        agents.extend(saved.keys().cloned());
        agents.extend(rows.iter().map(|row| row.agent.clone()));
        let now = Utc::now();
        for agent in agents {
            let observation = self.observations.read().await.get(&agent).cloned();
            let row = |kind: &str| rows.iter().find(|row| row.agent == agent && row.kind == kind);
            let facts = |kind: &str, saved: u64, applied: Option<u64>| {
                let row: Option<&DeliveryRow> = row(kind);
                Facts {
                    saved,
                    applied,
                    observable: observation.as_ref().is_some_and(|o| o.reachable && o.reports_setup),
                    rejected: observation.as_ref().and_then(|o| o.reported.rejected.as_ref()).filter(|r| r.kind == kind).map(|r| r.revision),
                    sent: row.and_then(|r| r.revision_sent),
                    sent_at: row.and_then(|r| r.last_sent_at),
                    failures: row.map_or(0, |r| r.failures),
                    failed_at: row.and_then(|r| r.last_error_at),
                    force: forced.contains(&agent),
                }
            };
            let applied = |pick: fn(&ReportedSetup) -> Option<u64>| observation.as_ref().filter(|o| o.reachable && o.reports_setup).and_then(|o| pick(&o.reported));
            if let Some(revision) = saved.get(&agent)
                && let Plan::Send { again } = plan(&facts("override", revision.revision, applied(|r| r.override_revision)), now)
            {
                let outcome = match self.compose_override(revision).await {
                    Ok(document) => tokio::time::timeout(SEND_TIMEOUT, deliverer.send(&agent, Document::Override(&document), again)).await.unwrap_or_else(|_| Err("the domain did not answer in time".into())),
                    Err(reason) => Err(reason),
                };
                self.record(&agent, "override", revision.revision, outcome).await;
            }
            if let Some(limits) = &limits
                && let Plan::Send { again } = plan(&facts("limits", limits.revision, applied(|r| r.limits_revision)), now)
            {
                let document = contract::compose_limits(limits);
                let outcome = tokio::time::timeout(SEND_TIMEOUT, deliverer.send(&agent, Document::Limits(&document), again)).await.unwrap_or_else(|_| Err("the domain did not answer in time".into()));
                self.record(&agent, "limits", limits.revision, outcome).await;
            }
        }
        Ok(())
    }

    async fn record(&self, agent: &str, kind: &str, revision: u64, outcome: Result<(), String>) {
        let written = match outcome {
            Ok(()) => self.store.record_sent(agent, kind, revision).await,
            Err(reason) => {
                eprintln!("Operations could not deliver {kind} revision {revision} to {agent}: {reason}");
                self.store.record_failure(agent, kind, &reason).await.map(|_| ())
            }
        };
        if written.is_err() {
            eprintln!("Operations could not record the delivery to {agent}");
        }
    }

    pub async fn compose_override(&self, revision: &SetupRevision) -> Result<SetupOverride, String> {
        let library = self.store.resolve_library(&revision.form.library_skills).await.map_err(|_| "the database could not be read".to_string())?;
        let catalog = self.store.resolve_catalog(&revision.form.mcp).await.map_err(|_| "the database could not be read".to_string())?;
        contract::compose_override(revision, &contract::Resolved { library: &library, catalog: &catalog }).map_err(|invalid| format!("the document cannot be composed: {}", invalid.message))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn now() -> DateTime<Utc> {
        Utc.timestamp_opt(1_790_000_000, 0).unwrap()
    }

    fn ago(seconds: i64) -> Option<DateTime<Utc>> {
        Some(now() - chrono::Duration::seconds(seconds))
    }

    fn facts() -> Facts {
        Facts { saved: 5, applied: Some(4), observable: true, rejected: None, sent: Some(5), sent_at: ago(120), failures: 0, failed_at: None, force: false }
    }

    #[test]
    fn nothing_saved_or_already_applied_sends_nothing() {
        assert_eq!(plan(&Facts { saved: 0, ..facts() }, now()), Plan::Nothing);
        assert_eq!(plan(&Facts { applied: Some(5), ..facts() }, now()), Plan::Nothing);
        assert_eq!(plan(&Facts { applied: Some(6), ..facts() }, now()), Plan::Nothing);
    }

    #[test]
    fn a_revision_that_was_never_sent_goes_out_at_once() {
        assert_eq!(plan(&Facts { sent: None, sent_at: None, ..facts() }, now()), Plan::Send { again: None });
        assert_eq!(plan(&Facts { sent: Some(4), sent_at: ago(1), applied: None, ..facts() }, now()), Plan::Send { again: None });
        assert_eq!(plan(&Facts { observable: false, sent: None, ..facts() }, now()), Plan::Send { again: None }, "an agent that cannot be observed still gets its first send");
    }

    #[test]
    fn an_older_reported_revision_gets_the_latest_again_at_most_once_a_minute() {
        assert!(matches!(plan(&facts(), now()), Plan::Send { again: Some(_) }));
        assert_eq!(plan(&Facts { sent_at: ago(59), ..facts() }, now()), Plan::Nothing);
        assert!(matches!(plan(&Facts { sent_at: ago(60), ..facts() }, now()), Plan::Send { .. }));
        assert!(matches!(plan(&Facts { applied: None, ..facts() }, now()), Plan::Send { .. }), "an agent that reports none yet lags too");
    }

    #[test]
    fn an_agent_that_cannot_be_seen_is_not_pestered() {
        assert_eq!(plan(&Facts { observable: false, ..facts() }, now()), Plan::Nothing, "the message is durable and waits for it");
    }

    #[test]
    fn a_rejected_revision_is_not_sent_again_until_an_operator_asks() {
        let rejected = Facts { rejected: Some(5), ..facts() };
        assert_eq!(plan(&rejected, now()), Plan::Nothing);
        assert!(matches!(plan(&Facts { force: true, ..rejected }, now()), Plan::Send { again: Some(_) }));
        assert!(matches!(plan(&Facts { rejected: Some(4), ..facts() }, now()), Plan::Send { .. }), "a refusal of an older revision says nothing about this one");
    }

    #[test]
    fn failures_are_retried_with_a_growing_pause() {
        let failed = |failures, seconds| Facts { sent: None, sent_at: None, failures, failed_at: ago(seconds), ..facts() };
        assert_eq!(plan(&failed(1, 14), now()), Plan::Nothing);
        assert_eq!(plan(&failed(1, 15), now()), Plan::Send { again: None });
        assert_eq!(plan(&failed(2, 29), now()), Plan::Nothing);
        assert_eq!(plan(&failed(2, 30), now()), Plan::Send { again: None });
        assert_eq!(plan(&failed(9, 59), now()), Plan::Nothing, "never longer than a minute");
        assert_eq!(plan(&failed(9, 60), now()), Plan::Send { again: None });
        assert!(matches!(plan(&Facts { force: true, ..failed(9, 1) }, now()), Plan::Send { .. }), "an operator can retry at once");
    }

    #[test]
    fn a_profile_becomes_an_observation() {
        let profile = serde_json::json!({"schema": 1, "role": "developer", "setup": {"override": {"revision": 3, "appliedAt": "2026-10-10T10:00:00.000Z"}, "limits": null}});
        let seen = observe_profile(&profile, now());
        assert!(seen.reachable && seen.reports_setup);
        assert_eq!((seen.role.as_deref(), seen.reported.override_revision, seen.reported.limits_revision), (Some("developer"), Some(3), None));
        let old = observe_profile(&serde_json::json!({"schema": 1, "role": "developer"}), now());
        assert!(!old.reports_setup, "an old kit has no setup report");
    }

    // ------------------------------------------------------------------------------- against Postgres, a fake domain and fake agents

    use crate::ops::{
        delivery::tests::{deliverer, fake_domain},
        testing::{fake_agent, postgres, profile},
    };
    use axum::http::StatusCode;
    use serde_json::json;

    fn form(instructions: &str) -> SetupForm {
        SetupForm { instructions: Some(instructions.into()), ..Default::default() }
    }

    async fn backdate(store: &Store, column: &str, seconds: i64) {
        sqlx::query(&format!("UPDATE delivery_state SET {column} = now() - make_interval(secs => $1)")).bind(seconds as f64).execute(store.pool()).await.unwrap();
    }

    fn reconciler(store: &Store, base: &str, targets: Vec<AgentTarget>) -> Arc<Reconciler> {
        Arc::new(Reconciler::new(store.clone(), Some(Arc::new(deliverer(base))), targets, crate::events::agent_http_client().unwrap(), Arc::new(Observations::default()), Arc::new(Notify::new())))
    }

    #[tokio::test]
    async fn the_latest_revision_is_sent_at_once_and_again_after_a_minute_while_the_agent_lags() {
        let Some(pg) = postgres("the_latest_revision_is_sent_at_once_and_again_after_a_minute_while_the_agent_lags") else { return };
        let store = pg.store("reconcile_resend").await;
        let (base, domain) = fake_domain().await;
        let (target, profile_slot) = fake_agent("agent/pi-agent", Some(profile("developer", None, None))).await;
        let reconciler = reconciler(&store, &base, vec![target]);
        reconciler.tick().await;
        assert!(domain.messages.lock().unwrap().is_empty(), "nothing saved, nothing sent");
        store.save_setup("agent/pi-agent", 0, &form("one"), "", "ed@example.com", "setup.save").await.unwrap();
        reconciler.tick().await;
        assert_eq!(domain.messages.lock().unwrap().len(), 1);
        reconciler.tick().await;
        assert_eq!(domain.messages.lock().unwrap().len(), 1, "a second tick within the minute sends nothing");
        let row = store.delivery_rows().await.unwrap().into_iter().find(|r| r.kind == "override").unwrap();
        assert_eq!((row.revision_sent, row.failures), (Some(1), 0));
        backdate(&store, "last_sent_at", 61).await;
        reconciler.tick().await;
        let keys: Vec<String> = domain.messages.lock().unwrap().iter().map(|m| m.1.clone().unwrap()).collect();
        assert_eq!(keys.len(), 2, "the agent still reports nothing applied");
        assert_eq!(keys[0], "setup:agent/pi-agent:1");
        assert!(keys[1].starts_with("setup:agent/pi-agent:1:again:"), "{keys:?}");
        *profile_slot.lock().unwrap() = Some(profile("developer", Some(1), None));
        backdate(&store, "last_sent_at", 61).await;
        reconciler.tick().await;
        assert_eq!(domain.messages.lock().unwrap().len(), 2, "applied: nothing more to send");
        store.save_setup("agent/pi-agent", 1, &form("two"), "", "ed@example.com", "setup.save").await.unwrap();
        reconciler.tick().await;
        assert_eq!(domain.messages.lock().unwrap().len(), 3, "a new revision goes out at once");
        assert_eq!(domain.messages.lock().unwrap()[2].0["labels"]["setup.revision"], "2");
    }

    #[tokio::test]
    async fn a_failing_send_is_retried_with_a_pause_and_shown_never_dropped() {
        let Some(pg) = postgres("a_failing_send_is_retried_with_a_pause_and_shown_never_dropped") else { return };
        let store = pg.store("reconcile_failure").await;
        let (base, domain) = fake_domain().await;
        let (target, _) = fake_agent("agent/pi-agent", Some(profile("developer", None, None))).await;
        let reconciler = reconciler(&store, &base, vec![target]);
        store.save_setup("agent/pi-agent", 0, &form("one"), "", "ed@example.com", "setup.save").await.unwrap();
        *domain.fail_messages.lock().unwrap() = Some(StatusCode::SERVICE_UNAVAILABLE);
        reconciler.tick().await;
        let row = store.delivery_rows().await.unwrap().into_iter().find(|r| r.kind == "override").unwrap();
        assert_eq!((row.failures, row.revision_sent), (1, None));
        let reason = row.last_error.clone().unwrap();
        assert!(reason.contains("503") && !reason.contains("PRIVATE"), "{reason}");
        let attempts = *domain.attempts.lock().unwrap();
        reconciler.tick().await;
        assert_eq!(*domain.attempts.lock().unwrap(), attempts, "it waits before trying again");
        backdate(&store, "last_error_at", 16).await;
        reconciler.tick().await;
        assert_eq!(*domain.attempts.lock().unwrap(), attempts + 1);
        let summary = crate::ops::api::summarize("agent/pi-agent", None, reconciler.observations.read().await.get("agent/pi-agent"), &store.delivery_rows().await.unwrap(), Default::default());
        assert_eq!((summary.override_delivery.failures, summary.override_delivery.error.is_some(), summary.override_delivery.sent_revision), (2, true, None), "the failure is on the agent's row");
        *domain.fail_messages.lock().unwrap() = None;
        backdate(&store, "last_error_at", 31).await;
        reconciler.tick().await;
        let row = store.delivery_rows().await.unwrap().into_iter().find(|r| r.kind == "override").unwrap();
        assert_eq!((row.failures, row.revision_sent, row.last_error), (0, Some(1), None));
        assert_eq!(domain.messages.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn an_unreachable_domain_is_a_failure_on_the_row_too() {
        let Some(pg) = postgres("an_unreachable_domain_is_a_failure_on_the_row_too") else { return };
        let store = pg.store("reconcile_unreachable").await;
        let (target, _) = fake_agent("agent/pi-agent", Some(profile("developer", None, None))).await;
        let reconciler = reconciler(&store, "http://127.0.0.1:9", vec![target]);
        store.save_setup("agent/pi-agent", 0, &form("one"), "", "ed@example.com", "setup.save").await.unwrap();
        reconciler.tick().await;
        let row = store.delivery_rows().await.unwrap().into_iter().find(|r| r.kind == "override").unwrap();
        assert!(row.last_error.unwrap().contains("unreachable"));
    }

    #[tokio::test]
    async fn a_rejected_revision_is_shown_and_left_alone_until_an_operator_resends() {
        let Some(pg) = postgres("a_rejected_revision_is_shown_and_left_alone_until_an_operator_resends") else { return };
        let store = pg.store("reconcile_rejected").await;
        let (base, domain) = fake_domain().await;
        let (target, profile_slot) = fake_agent("agent/pi-agent", Some(profile("developer", None, None))).await;
        let reconciler = reconciler(&store, &base, vec![target]);
        store.save_setup("agent/pi-agent", 0, &form("one"), "", "ed@example.com", "setup.save").await.unwrap();
        reconciler.tick().await;
        let mut refused = profile("developer", None, None);
        refused["setup"]["rejected"] = json!({"kind": "override", "revision": 1, "reason": "the MCP entry docs needs a command", "at": "2026-10-10T10:01:00.000Z"});
        *profile_slot.lock().unwrap() = Some(refused);
        backdate(&store, "last_sent_at", 120).await;
        reconciler.tick().await;
        assert_eq!(domain.messages.lock().unwrap().len(), 1, "the same document is not sent again to an agent that refused it");
        let rows = store.delivery_rows().await.unwrap();
        let summary = crate::ops::api::summarize("agent/pi-agent", None, reconciler.observations.read().await.get("agent/pi-agent"), &rows, Default::default());
        let rejected = summary.rejected.unwrap();
        assert_eq!((rejected.kind.as_str(), rejected.revision, rejected.reason.as_str()), ("override", 1, "the MCP entry docs needs a command"));
        reconciler.force("agent/pi-agent").await;
        reconciler.tick().await;
        assert_eq!(domain.messages.lock().unwrap().len(), 2, "an operator can ask for it again");
        store.save_setup("agent/pi-agent", 1, &form("fixed"), "", "ed@example.com", "setup.save").await.unwrap();
        reconciler.tick().await;
        assert_eq!(domain.messages.lock().unwrap().len(), 3, "a new revision is sent whatever happened to the last");
    }

    #[tokio::test]
    async fn fleet_limits_go_to_every_agent_and_only_to_those_that_lag() {
        let Some(pg) = postgres("fleet_limits_go_to_every_agent_and_only_to_those_that_lag") else { return };
        let store = pg.store("reconcile_limits").await;
        let (base, domain) = fake_domain().await;
        let (one, _) = fake_agent("agent/one", Some(profile("developer", None, None))).await;
        let (two, _) = fake_agent("agent/two", Some(profile("qa", None, Some(1)))).await;
        let (three, _) = fake_agent("agent/three", None).await;
        let reconciler = reconciler(&store, &base, vec![one, two, three]);
        reconciler.tick().await;
        assert!(domain.messages.lock().unwrap().is_empty(), "no limits saved");
        let values = LimitsValues { max_tokens_cap: 5, max_minutes_cap: 6, daily_token_limit: 7, budget_raise_ceiling: 8, global_prompt: None, model: None };
        store.save_limits(0, &values, "", "admin@example.com").await.unwrap();
        reconciler.tick().await;
        let mut recipients: Vec<String> = domain.messages.lock().unwrap().iter().map(|m| m.0["recipients"][0]["id"].as_str().unwrap().to_string()).collect();
        recipients.sort();
        assert_eq!(recipients, vec!["agent/one", "agent/three"], "agent/two already reports revision 1; agent/three cannot be seen but still gets its first send");
        let first = domain.messages.lock().unwrap()[0].0.clone();
        assert_eq!((first["labels"]["setup.kind"].as_str(), first["labels"]["setup.revision"].as_str()), (Some("limits"), Some("1")));
        let uploads = domain.uploads.lock().unwrap();
        let document: serde_json::Value = serde_json::from_slice(&uploads[0].1).unwrap();
        assert_eq!((document["kind"].as_str(), document["maxTokensCap"].as_u64(), document["budgetRaiseCeiling"].as_u64()), (Some("limits"), Some(5), Some(8)));
    }

    #[tokio::test]
    async fn an_agent_that_cannot_be_seen_gets_each_revision_once_and_is_not_pestered() {
        let Some(pg) = postgres("an_agent_that_cannot_be_seen_gets_each_revision_once_and_is_not_pestered") else { return };
        let store = pg.store("reconcile_down").await;
        let (base, domain) = fake_domain().await;
        let (down, _) = fake_agent("agent/down", None).await;
        let reconciler = reconciler(&store, &base, vec![down]);
        store.save_setup("agent/down", 0, &form("one"), "", "ed@example.com", "setup.save").await.unwrap();
        reconciler.tick().await;
        backdate(&store, "last_sent_at", 600).await;
        reconciler.tick().await;
        assert_eq!(domain.messages.lock().unwrap().len(), 1, "the message is durable: it waits for the agent");
        let observation = reconciler.observations.read().await.get("agent/down").cloned().unwrap();
        assert!(!observation.reachable);
    }

    #[tokio::test]
    async fn an_old_kit_without_a_setup_report_gets_each_revision_once() {
        let Some(pg) = postgres("an_old_kit_without_a_setup_report_gets_each_revision_once") else { return };
        let store = pg.store("reconcile_old").await;
        let (base, domain) = fake_domain().await;
        let (old, _) = fake_agent("agent/old", Some(json!({"schema": 1, "role": "developer", "hash": "abc"}))).await;
        let reconciler = reconciler(&store, &base, vec![old]);
        store.save_setup("agent/old", 0, &form("one"), "", "ed@example.com", "setup.save").await.unwrap();
        reconciler.tick().await;
        backdate(&store, "last_sent_at", 600).await;
        reconciler.tick().await;
        assert_eq!(domain.messages.lock().unwrap().len(), 1);
        let observation = reconciler.observations.read().await.get("agent/old").cloned().unwrap();
        assert!(observation.reachable && !observation.reports_setup);
    }

    #[tokio::test]
    async fn what_the_agent_reports_is_kept_in_the_database() {
        let Some(pg) = postgres("what_the_agent_reports_is_kept_in_the_database") else { return };
        let store = pg.store("reconcile_reported").await;
        let (base, _) = fake_domain().await;
        let mut refused = profile("developer", Some(2), Some(1));
        refused["setup"]["rejected"] = json!({"kind": "override", "revision": 3, "reason": "too big", "at": "2026-10-10T10:01:00.000Z"});
        let (target, _) = fake_agent("agent/pi-agent", Some(refused)).await;
        reconciler(&store, &base, vec![target]).tick().await;
        let rows = store.delivery_rows().await.unwrap();
        let over = rows.iter().find(|r| r.kind == "override").unwrap();
        assert_eq!((over.last_reported_revision, over.rejected.clone().map(|r| (r.0, r.1))), (Some(2), Some((3, "too big".to_string()))));
        assert_eq!(rows.iter().find(|r| r.kind == "limits").unwrap().last_reported_revision, Some(1));
        // a restarted server shows the last known state of an agent it cannot read right now
        let summary = crate::ops::api::summarize("agent/pi-agent", None, None, &rows, Default::default());
        assert_eq!((summary.applied_revision, summary.rejected.map(|r| r.revision)), (Some(2), Some(3)));
    }

    #[tokio::test]
    async fn a_document_that_cannot_be_composed_is_a_visible_failure_not_a_silent_skip() {
        let Some(pg) = postgres("a_document_that_cannot_be_composed_is_a_visible_failure_not_a_silent_skip") else { return };
        let store = pg.store("reconcile_compose").await;
        let (base, domain) = fake_domain().await;
        let (target, _) = fake_agent("agent/pi-agent", Some(profile("developer", None, None))).await;
        let reconciler = reconciler(&store, &base, vec![target]);
        let docs = McpEntry { name: "docs".into(), description: None, transport: McpTransport::Stdio, command: Some("npx".into()), args: None, env: None, url: None, headers: None, secrets: None, approval: McpApproval::Ask, downloads: None, timeout_seconds: None };
        store.save_catalog(&docs, 0, "", "ed@example.com").await.unwrap();
        store.save_setup("agent/pi-agent", 0, &SetupForm { mcp: vec!["docs".into()], ..Default::default() }, "", "ed@example.com", "setup.save").await.unwrap();
        sqlx::query("UPDATE catalog_entries SET deleted_at = now()").execute(store.pool()).await.unwrap();
        reconciler.tick().await;
        let row = store.delivery_rows().await.unwrap().into_iter().find(|r| r.kind == "override").unwrap();
        assert!(row.last_error.unwrap().contains("cannot be composed"), "the reason is on the agent's row");
        assert!(domain.messages.lock().unwrap().is_empty());
    }
}

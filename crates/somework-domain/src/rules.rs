//! Rules: durable event subscriptions with optional reactions. A rule is a `topic` subscription owned by one principal
//! plus filters and, for reactions, a task template. Matching events write a firing row and an outbox row (see
//! [`Domain::queue_reaction`]); the reaction worker settles each firing exactly once by submitting the task as the owner.

use std::sync::Arc;

use async_trait::async_trait;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Value, json};
use somework_core::{Error, ErrorCode, contracts::CapabilityRef, ids, template, trace::TraceContext};
use sqlx::{Connection, SqliteConnection};
use tokio_util::sync::CancellationToken;

use crate::{
    audit::AuditRecord,
    config::SINK_REACTION,
    db::{DbResultExt, icol, jcol, jcol_opt, scol, scol_opt},
    domain::{Ctx, Domain},
    events::EventSpec,
    outbox::{OutboxConfig, OutboxItem, OutboxSink, SinkError, StepReport},
    policy::AuthzRequest,
    tasks::SubmitTask,
};

pub const DEFAULT_MAX_DEPTH: u32 = 3;
pub const DEFAULT_MAX_FIRINGS_PER_HOUR: u32 = 30;
const MAX_WHERE_CLAUSES: usize = 20;

/// Where a task came from when a reaction (not a person or an agent) submitted it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskOrigin {
    /// `reaction` (a rule submitted the task) or `event` (an agent submitted it while handling an event).
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rule: Option<String>,
    pub event_id: String,
    pub depth: i64,
}

impl TaskOrigin {
    pub fn reaction(rule: &str, event_id: &str, depth: i64) -> Self {
        Self { kind: "reaction".into(), rule: Some(rule.into()), event_id: event_id.into(), depth }
    }

    pub fn event(event_id: &str, depth: i64) -> Self {
        Self { kind: "event".into(), rule: None, event_id: event_id.into(), depth }
    }
}

/// How many hops produced a stored event: published events carry their depth, task events inherit the origin depth of the task
/// plus one, everything else starts a chain.
pub(crate) fn stored_event_depth(has_task: bool, payload: &Value) -> i64 {
    if let Some(depth) = payload.get("depth").and_then(Value::as_i64) {
        return depth;
    }
    if has_task {
        return payload.get("originDepth").and_then(Value::as_i64).map_or(0, |d| d + 1);
    }
    0
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WhereClause {
    /// JSON pointer into the event payload, for example `/data/draft`.
    pub path: String,
    pub equals: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReactionBudget {
    pub max_tokens: u64,
    pub max_minutes: u64,
}

fn version_as_string<'de, D: Deserializer<'de>>(deserializer: D) -> Result<String, D::Error> {
    match Value::deserialize(deserializer)? {
        Value::String(text) => Ok(text),
        Value::Number(number) => Ok(number.to_string()),
        other => Err(serde::de::Error::custom(format!("capability version must be a string or a number, got {other}"))),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ReactionCapability {
    pub id: String,
    #[serde(deserialize_with = "version_as_string")]
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReactionSpec {
    pub capability: ReactionCapability,
    #[serde(default)]
    pub input: Value,
    /// Merged into `input.budget` unless the template sets one itself.
    #[serde(default)]
    pub budget: Option<ReactionBudget>,
    #[serde(default)]
    pub max_depth: Option<u32>,
    #[serde(default)]
    pub max_firings_per_hour: Option<u32>,
}

impl ReactionSpec {
    fn normalized(mut self) -> Result<Self, Error> {
        if self.capability.id.trim().is_empty() || self.capability.version.trim().is_empty() {
            return Err(Error::invalid("reaction.capability needs an id and a version"));
        }
        if self.input.is_null() {
            self.input = json!({});
        }
        if !self.input.is_object() {
            return Err(Error::invalid("reaction.input must be a JSON object"));
        }
        if let Some(b) = &self.budget
            && (b.max_tokens == 0 || b.max_minutes == 0)
        {
            return Err(Error::invalid("reaction.budget needs positive maxTokens and maxMinutes"));
        }
        let depth = self.max_depth.unwrap_or(DEFAULT_MAX_DEPTH);
        if !(1..=10).contains(&depth) {
            return Err(Error::invalid("reaction.maxDepth must be between 1 and 10"));
        }
        let rate = self.max_firings_per_hour.unwrap_or(DEFAULT_MAX_FIRINGS_PER_HOUR);
        if !(1..=3600).contains(&rate) {
            return Err(Error::invalid("reaction.maxFiringsPerHour must be between 1 and 3600"));
        }
        for pointer in template::references(&self.input) {
            if pointer.len() > 200 {
                return Err(Error::invalid("template pointers are limited to 200 characters"));
            }
        }
        self.max_depth = Some(depth);
        self.max_firings_per_hour = Some(rate);
        Ok(self)
    }

    fn max_depth(&self) -> i64 {
        i64::from(self.max_depth.unwrap_or(DEFAULT_MAX_DEPTH))
    }

    fn max_firings_per_hour(&self) -> i64 {
        i64::from(self.max_firings_per_hour.unwrap_or(DEFAULT_MAX_FIRINGS_PER_HOUR))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct RuleSpec {
    pub description: Option<String>,
    /// Handle of the owning principal, for example `automation/pr-review` or an agent id.
    pub owner: Option<String>,
    pub selector: Option<String>,
    #[serde(rename = "where")]
    pub where_filters: Vec<WhereClause>,
    pub wake: bool,
    pub reaction: Option<ReactionSpec>,
    /// `active` (default) or `paused`.
    pub status: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SkippedCounters {
    pub duplicate: i64,
    pub depth: i64,
    pub rate: i64,
    pub denied: i64,
    pub approval: i64,
    pub error: i64,
    pub paused: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RuleCounters {
    pub fired: i64,
    pub skipped: SkippedCounters,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleView {
    pub name: String,
    pub description: String,
    pub owner: String,
    pub selector: String,
    #[serde(rename = "where")]
    pub where_filters: Vec<WhereClause>,
    pub wake: bool,
    pub reaction: Option<ReactionSpec>,
    pub status: String,
    pub subscription_id: String,
    pub created_at: String,
    pub updated_at: String,
    pub last_fired_at: Option<String>,
    pub counters: RuleCounters,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FiringView {
    pub rule: String,
    pub event_id: String,
    pub event_seq: i64,
    pub depth: i64,
    pub status: String,
    pub reason: Option<String>,
    pub detail: Option<String>,
    pub task_id: Option<String>,
    pub approval_id: Option<String>,
    pub created_at: String,
    pub decided_at: Option<String>,
}

pub fn valid_rule_name(name: &str) -> bool {
    (1..=64).contains(&name.len())
        && name.chars().next().is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '_' | '-'))
}

fn valid_selector(selector: &str) -> bool {
    !selector.is_empty() && selector.len() <= 200 && selector.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '_' | '*'))
}

/// All `where` clauses must hold against the event payload.
pub(crate) fn filters_hold(filters: &Value, payload: &Value) -> bool {
    filters.as_array().is_none_or(|clauses| {
        clauses.iter().all(|clause| match (clause.get("path").and_then(Value::as_str), clause.get("equals")) {
            (Some(path), Some(expected)) => payload.pointer(path) == Some(expected),
            _ => false,
        })
    })
}

fn rule_view(row: &sqlx::sqlite::SqliteRow) -> RuleView {
    RuleView {
        name: scol(row, "rule_name"),
        description: scol(row, "description"),
        owner: scol(row, "owner"),
        selector: scol(row, "selector"),
        where_filters: serde_json::from_value(jcol(row, "where_filters")).unwrap_or_default(),
        wake: icol(row, "wake") != 0,
        reaction: jcol_opt(row, "reaction").and_then(|v| serde_json::from_value(v).ok()),
        status: scol(row, "status"),
        subscription_id: scol(row, "subscription_id"),
        created_at: scol(row, "created_at"),
        updated_at: scol(row, "updated_at"),
        last_fired_at: scol_opt(row, "last_fired_at"),
        counters: RuleCounters {
            fired: icol(row, "fired"),
            skipped: SkippedCounters {
                duplicate: icol(row, "skipped_duplicate"),
                depth: icol(row, "skipped_depth"),
                rate: icol(row, "skipped_rate"),
                denied: icol(row, "skipped_denied"),
                approval: icol(row, "skipped_approval"),
                error: icol(row, "skipped_error"),
                paused: icol(row, "skipped_paused"),
            },
        },
    }
}

macro_rules! rule_select {
    ($tail:literal) => {
        concat!("SELECT r.*, s.selector AS selector, s.wake AS wake FROM rules r JOIN subscriptions s ON s.subscription_id = r.subscription_id ", $tail)
    };
}

fn counter_column(reason: &str) -> &'static str {
    match reason {
        "duplicate" => "skipped_duplicate",
        "depth" => "skipped_depth",
        "rate" => "skipped_rate",
        "denied" => "skipped_denied",
        "approval" => "skipped_approval",
        "paused" => "skipped_paused",
        _ => "skipped_error",
    }
}

impl Domain {
    // ---- management ---------------------------------------------------------------------------------------------------

    async fn require_rules_read(&self, ctx: &Ctx) -> Result<(), Error> {
        let permissions = &ctx.actor.permissions;
        if ["rules.manage", "rules.control", "ops.read"].iter().any(|action| permissions.allows_action(action)) {
            return Ok(());
        }
        self.enforce_read(ctx, AuthzRequest::new("rules.manage")).await.map(|_| ())
    }

    pub async fn list_rules(&self, ctx: &Ctx) -> Result<Vec<RuleView>, Error> {
        self.require_rules_read(ctx).await?;
        let rows = sqlx::query(rule_select!("WHERE r.domain_id = ? ORDER BY r.rule_name")).bind(&self.cfg.domain_id).fetch_all(self.db.pool()).await.db()?;
        Ok(rows.iter().map(rule_view).collect())
    }

    pub async fn get_rule(&self, ctx: &Ctx, name: &str) -> Result<RuleView, Error> {
        self.require_rules_read(ctx).await?;
        let row = sqlx::query(rule_select!("WHERE r.domain_id = ? AND r.rule_name = ?"))
            .bind(&self.cfg.domain_id)
            .bind(name)
            .fetch_optional(self.db.pool())
            .await
            .db()?
            .ok_or_else(|| Error::not_found("rule"))?;
        Ok(rule_view(&row))
    }

    pub async fn list_firings(&self, ctx: &Ctx, name: &str, limit: i64) -> Result<Vec<FiringView>, Error> {
        self.require_rules_read(ctx).await?;
        let rows = sqlx::query("SELECT * FROM reaction_firings WHERE domain_id = ? AND rule_name = ? ORDER BY created_at DESC, event_seq DESC LIMIT ?")
            .bind(&self.cfg.domain_id)
            .bind(name)
            .bind(limit.clamp(1, 500))
            .fetch_all(self.db.pool())
            .await
            .db()?;
        Ok(rows
            .iter()
            .map(|r| FiringView {
                rule: scol(r, "rule_name"),
                event_id: scol(r, "event_id"),
                event_seq: icol(r, "event_seq"),
                depth: icol(r, "depth"),
                status: scol(r, "status"),
                reason: scol_opt(r, "reason"),
                detail: scol_opt(r, "detail"),
                task_id: scol_opt(r, "task_id"),
                approval_id: scol_opt(r, "approval_id"),
                created_at: scol(r, "created_at"),
                decided_at: scol_opt(r, "decided_at"),
            })
            .collect())
    }

    /// Creates or replaces a rule. Returns the stored rule and whether it was created; an identical repeat changes nothing.
    pub async fn put_rule(&self, ctx: &Ctx, name: &str, spec: RuleSpec) -> Result<(RuleView, bool), Error> {
        self.run(ctx, "rule.put", async {
            if !valid_rule_name(name) {
                return Err(Error::invalid("rule name must be 1-64 characters of lowercase letters, digits, '.', '_' or '-'"));
            }
            let owner = spec.owner.clone().filter(|o| !o.is_empty()).ok_or_else(|| Error::invalid("owner is required"))?;
            let selector = spec.selector.clone().filter(|s| valid_selector(s)).ok_or_else(|| Error::invalid("selector must be a topic glob of lowercase letters, digits, '.', '_' and '*'"))?;
            if spec.where_filters.len() > MAX_WHERE_CLAUSES || spec.where_filters.iter().any(|c| !c.path.starts_with('/') || c.path.len() > 200) {
                return Err(Error::invalid(format!("where takes at most {MAX_WHERE_CLAUSES} clauses, each with a JSON pointer path")));
            }
            let status = match spec.status.as_deref() {
                None | Some("active") => None,
                Some("paused") => Some("paused"),
                Some(other) => return Err(Error::invalid(format!("status must be active or paused, not {other}"))),
            };
            let reaction = spec.reaction.clone().map(ReactionSpec::normalized).transpose()?;
            let description = spec.description.clone().unwrap_or_default();
            if description.len() > 1000 {
                return Err(Error::invalid("description is limited to 1000 characters"));
            }
            let where_json = serde_json::to_value(&spec.where_filters)?;
            let reaction_json = reaction.as_ref().map(serde_json::to_value).transpose()?;
            let name = name.to_string();
            let wake = spec.wake;
            let this = self.clone();
            let ctx = ctx.clone();
            self.write(move |tx| {
                Box::pin(async move {
                    let conn = &mut **tx;
                    let decision = this.enforce(conn, &ctx, AuthzRequest::new("rules.manage").resource(format!("rule://{name}"))).await?;
                    let principal_row = sqlx::query(
                        "SELECT * FROM principals WHERE domain_id = ? AND external_id = ? AND kind IN ('agent','service') AND status = 'active' ORDER BY kind ASC LIMIT 1",
                    )
                    .bind(&this.cfg.domain_id)
                    .bind(&owner)
                    .fetch_optional(&mut *conn)
                    .await
                    .db()?
                    .ok_or_else(|| Error::invalid(format!("owner {owner} is not an active agent or service principal")))?;
                    let owner_principal = crate::auth::principal_from_row(&principal_row);
                    if let Some(r) = &reaction
                        && !owner_principal.permissions.may_invoke(&r.capability.id)
                    {
                        return Err(Error::invalid(format!("owner {owner} may not invoke {}", r.capability.id)));
                    }
                    let now = this.now_ts();
                    let existing = sqlx::query(rule_select!("WHERE r.domain_id = ? AND r.rule_name = ?"))
                        .bind(&this.cfg.domain_id)
                        .bind(&name)
                        .fetch_optional(&mut *conn)
                        .await
                        .db()?;
                    let created = existing.is_none();
                    if let Some(row) = &existing {
                        let current = rule_view(row);
                        let unchanged = current.owner == owner
                            && scol(row, "owner_principal_id") == owner_principal.principal_id
                            && current.selector == selector
                            && current.wake == wake
                            && current.description == description
                            && serde_json::to_value(&current.where_filters)? == where_json
                            && current.reaction == reaction
                            && status.is_none_or(|s| current.status == s);
                        if unchanged {
                            return Ok((current, false));
                        }
                        sqlx::query("UPDATE subscriptions SET principal_id = ?, selector = ?, wake = ? WHERE subscription_id = ?")
                            .bind(&owner_principal.principal_id)
                            .bind(&selector)
                            .bind(wake as i64)
                            .bind(&current.subscription_id)
                            .execute(&mut *conn)
                            .await
                            .db()?;
                        sqlx::query("UPDATE rules SET owner_principal_id = ?, owner = ?, description = ?, where_filters = ?, reaction = ?, status = COALESCE(?, status), updated_at = ? WHERE domain_id = ? AND rule_name = ?")
                            .bind(&owner_principal.principal_id)
                            .bind(&owner)
                            .bind(&description)
                            .bind(where_json.to_string())
                            .bind(reaction_json.as_ref().map(Value::to_string))
                            .bind(status)
                            .bind(&now)
                            .bind(&this.cfg.domain_id)
                            .bind(&name)
                            .execute(&mut *conn)
                            .await
                            .db()?;
                    } else {
                        let subscription_id = ids::subscription_id();
                        sqlx::query("INSERT INTO subscriptions(subscription_id, domain_id, principal_id, kind, selector, wake, status, created_at) VALUES (?, ?, ?, 'topic', ?, ?, 'active', ?)")
                            .bind(&subscription_id)
                            .bind(&this.cfg.domain_id)
                            .bind(&owner_principal.principal_id)
                            .bind(&selector)
                            .bind(wake as i64)
                            .bind(&now)
                            .execute(&mut *conn)
                            .await
                            .db()?;
                        sqlx::query("INSERT INTO rules(domain_id, rule_name, subscription_id, owner_principal_id, owner, description, where_filters, reaction, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
                            .bind(&this.cfg.domain_id)
                            .bind(&name)
                            .bind(&subscription_id)
                            .bind(&owner_principal.principal_id)
                            .bind(&owner)
                            .bind(&description)
                            .bind(where_json.to_string())
                            .bind(reaction_json.as_ref().map(Value::to_string))
                            .bind(status.unwrap_or("active"))
                            .bind(&now)
                            .bind(&now)
                            .execute(&mut *conn)
                            .await
                            .db()?;
                    }
                    this.audit(
                        conn,
                        &ctx,
                        AuditRecord::new("rule.put", Some(format!("rule://{name}")), "success")
                            .decision(&decision)
                            .detail(json!({"owner": owner, "selector": selector, "wake": wake, "reaction": reaction_json, "created": created})),
                    )
                    .await?;
                    let row = sqlx::query(rule_select!("WHERE r.domain_id = ? AND r.rule_name = ?"))
                        .bind(&this.cfg.domain_id)
                        .bind(&name)
                        .fetch_one(&mut *conn)
                        .await
                        .db()?;
                    Ok((rule_view(&row), created))
                })
            })
            .await
        })
        .await
    }

    pub async fn delete_rule(&self, ctx: &Ctx, name: &str) -> Result<(), Error> {
        self.run(ctx, "rule.delete", async {
            let name = name.to_string();
            let this = self.clone();
            let ctx = ctx.clone();
            self.write(move |tx| {
                Box::pin(async move {
                    let conn = &mut **tx;
                    let decision = this.enforce(conn, &ctx, AuthzRequest::new("rules.manage").resource(format!("rule://{name}"))).await?;
                    let subscription_id: String = sqlx::query_scalar("SELECT subscription_id FROM rules WHERE domain_id = ? AND rule_name = ?")
                        .bind(&this.cfg.domain_id)
                        .bind(&name)
                        .fetch_optional(&mut *conn)
                        .await
                        .db()?
                        .ok_or_else(|| Error::not_found("rule"))?;
                    sqlx::query("UPDATE subscriptions SET status = 'deleted', deleted_at = ? WHERE subscription_id = ?")
                        .bind(this.now_ts())
                        .bind(&subscription_id)
                        .execute(&mut *conn)
                        .await
                        .db()?;
                    sqlx::query("DELETE FROM rules WHERE domain_id = ? AND rule_name = ?")
                        .bind(&this.cfg.domain_id)
                        .bind(&name)
                        .execute(&mut *conn)
                        .await
                        .db()?;
                    this.audit(conn, &ctx, AuditRecord::new("rule.delete", Some(format!("rule://{name}")), "success").decision(&decision)).await?;
                    Ok(())
                })
            })
            .await
        })
        .await
    }

    pub async fn set_rule_status(&self, ctx: &Ctx, name: &str, status: &'static str) -> Result<RuleView, Error> {
        self.run(ctx, "rule.status", async {
            let name = name.to_string();
            let this = self.clone();
            let ctx = ctx.clone();
            self.write(move |tx| {
                Box::pin(async move {
                    let conn = &mut **tx;
                    // runtime control is all `rules.control` allows; `rules.manage` may do this as well as everything else
                    let action = if ctx.actor.permissions.allows_action("rules.manage") { "rules.manage" } else { "rules.control" };
                    let decision = this.enforce(conn, &ctx, AuthzRequest::new(action).resource(format!("rule://{name}"))).await?;
                    let changed = sqlx::query("UPDATE rules SET status = ?, updated_at = ? WHERE domain_id = ? AND rule_name = ?")
                        .bind(status)
                        .bind(this.now_ts())
                        .bind(&this.cfg.domain_id)
                        .bind(&name)
                        .execute(&mut *conn)
                        .await
                        .db()?
                        .rows_affected();
                    if changed == 0 {
                        return Err(Error::not_found("rule"));
                    }
                    this.audit(
                        conn,
                        &ctx,
                        AuditRecord::new("rule.status", Some(format!("rule://{name}")), "success").decision(&decision).detail(json!({"status": status})),
                    )
                    .await?;
                    let row = sqlx::query(rule_select!("WHERE r.domain_id = ? AND r.rule_name = ?"))
                        .bind(&this.cfg.domain_id)
                        .bind(&name)
                        .fetch_one(&mut *conn)
                        .await
                        .db()?;
                    Ok(rule_view(&row))
                })
            })
            .await
        })
        .await
    }

    // ---- matching -----------------------------------------------------------------------------------------------------

    /// Records that `rule` matched an event: one ledger row (unique per rule and event) and one outbox row.
    pub(crate) async fn queue_reaction(&self, conn: &mut SqliteConnection, rule: &str, event_seq: i64, event_id: &str, depth: i64) -> Result<(), Error> {
        let now = self.now_ts();
        let inserted = sqlx::query(
            "INSERT OR IGNORE INTO reaction_firings(domain_id, rule_name, event_id, event_seq, depth, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)",
        )
        .bind(&self.cfg.domain_id)
        .bind(rule)
        .bind(event_id)
        .bind(event_seq)
        .bind(depth)
        .bind(&now)
        .execute(&mut *conn)
        .await
        .db()?
        .rows_affected();
        if inserted == 1 {
            let payload = json!({"rule": rule, "eventId": event_id, "eventSeq": event_seq, "depth": depth});
            self.insert_outbox(conn, event_seq, SINK_REACTION, &format!("reaction.{rule}"), &format!("{rule}:{event_id}"), None, &payload).await?;
        }
        Ok(())
    }

    /// `causedByEvent` is never trusted: the event must exist and have been addressed to the submitting principal. Both
    /// failures look the same so event ids cannot be probed.
    pub(crate) async fn verified_event_origin(&self, conn: &mut SqliteConnection, ctx: &Ctx, event_id: &str) -> Result<TaskOrigin, Error> {
        let row = sqlx::query(
            "SELECT e.payload, e.task_id FROM events e JOIN event_recipients r ON r.event_seq = e.seq
             WHERE e.event_id = ? AND e.domain_id = ? AND r.principal_id = ?",
        )
        .bind(event_id)
        .bind(&self.cfg.domain_id)
        .bind(&ctx.actor.principal_id)
        .fetch_optional(&mut *conn)
        .await
        .db()?
        .ok_or_else(|| Error::invalid("causedByEvent does not name an event that was addressed to the caller"))?;
        let depth = stored_event_depth(scol_opt(&row, "task_id").is_some(), &jcol(&row, "payload"));
        Ok(TaskOrigin::event(event_id, depth + 1))
    }

    /// Depth recorded on a task that a reaction started, `None` for every other task.
    pub(crate) async fn reaction_depth_of_task(&self, conn: &mut SqliteConnection, task_id: &str) -> Result<Option<i64>, Error> {
        let origin: Option<Option<String>> =
            sqlx::query_scalar("SELECT origin FROM tasks WHERE task_id = ?").bind(task_id).fetch_optional(&mut *conn).await.db()?;
        Ok(origin.flatten().and_then(|raw| serde_json::from_str::<Value>(&raw).ok()).and_then(|o| o.get("depth").and_then(Value::as_i64)))
    }

    // ---- reaction worker ----------------------------------------------------------------------------------------------

    /// One pass of the reaction worker; also what the server's background task runs.
    pub async fn reaction_step(&self, worker_id: &str) -> Result<StepReport, Error> {
        self.outbox_step(&ReactionSink::new(self.clone()), worker_id, &OutboxConfig::default()).await
    }

    pub fn spawn_reactions(&self, shutdown: CancellationToken) -> tokio::task::JoinHandle<()> {
        self.spawn_outbox(Arc::new(ReactionSink::new(self.clone())), OutboxConfig::default(), shutdown)
    }

    /// Settles one firing: checks depth and rate, renders the template and submits the task as the rule's owner, all in one
    /// transaction that also records the outcome. Safe to call again for the same row.
    pub async fn process_reaction(&self, item: &OutboxItem) -> Result<ReactionOutcome, Error> {
        let rule_name = item.payload.get("rule").and_then(Value::as_str).ok_or_else(|| Error::internal("reaction row has no rule"))?.to_string();
        let event_id = item.payload.get("eventId").and_then(Value::as_str).ok_or_else(|| Error::internal("reaction row has no event id"))?.to_string();
        let this = self.clone();
        let (outcome, denial) = self
            .write(move |tx| {
                Box::pin(async move {
                    let conn = &mut **tx;
                    this.settle_firing(conn, &rule_name, &event_id).await
                })
            })
            .await?;
        match &outcome {
            ReactionOutcome::Fired { .. } => self.metrics.reactions_fired.inc(),
            ReactionOutcome::Skipped { reason, .. } => self.metrics.reactions_skipped.with_label_values(&[reason.as_str()]).inc(),
            ReactionOutcome::Gone => {}
        }
        if let Some((ctx, err)) = denial
            && let Err(record_err) = self.record_denial(&ctx, "task.submit", &err).await
        {
            tracing::warn!(error = %record_err, "failed to record the denial of a reaction");
        }
        Ok(outcome)
    }

    async fn settle_firing(&self, conn: &mut SqliteConnection, rule_name: &str, event_id: &str) -> Result<(ReactionOutcome, Option<(Ctx, Error)>), Error> {
        let Some(firing) = sqlx::query("SELECT * FROM reaction_firings WHERE domain_id = ? AND rule_name = ? AND event_id = ?")
            .bind(&self.cfg.domain_id)
            .bind(rule_name)
            .bind(event_id)
            .fetch_optional(&mut *conn)
            .await
            .db()?
        else {
            return Ok((ReactionOutcome::Gone, None));
        };
        let system = self.system_ctx();
        let depth = icol(&firing, "depth");
        let rule = sqlx::query("SELECT * FROM rules WHERE domain_id = ? AND rule_name = ?")
            .bind(&self.cfg.domain_id)
            .bind(rule_name)
            .fetch_optional(&mut *conn)
            .await
            .db()?;
        if scol(&firing, "status") != "pending" {
            if rule.is_some() {
                self.bump_counter(conn, rule_name, "duplicate").await?;
            }
            return Ok((ReactionOutcome::Skipped { reason: "duplicate".into(), detail: "the firing was already settled".into() }, None));
        }
        let skip = |reason: &str, detail: String| ReactionOutcome::Skipped { reason: reason.into(), detail };
        let Some(rule) = rule else {
            let outcome = skip("error", "the rule no longer exists".into());
            self.record_skip(conn, &system, rule_name, event_id, depth, &outcome).await?;
            return Ok((outcome, None));
        };
        let Some(reaction) = jcol_opt(&rule, "reaction").and_then(|v| serde_json::from_value::<ReactionSpec>(v).ok()) else {
            let outcome = skip("error", "the rule has no reaction".into());
            self.record_skip(conn, &system, rule_name, event_id, depth, &outcome).await?;
            return Ok((outcome, None));
        };
        let outcome = if scol(&rule, "status") != "active" {
            Some(skip("paused", "the rule is paused".into()))
        } else if depth >= reaction.max_depth() {
            Some(skip("depth", format!("event depth {depth} reached the rule's maxDepth {}", reaction.max_depth())))
        } else {
            let since = somework_core::clock::ts(self.now() - chrono::Duration::hours(1));
            let recent: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM reaction_firings WHERE domain_id = ? AND rule_name = ? AND status = 'fired' AND decided_at >= ?")
                    .bind(&self.cfg.domain_id)
                    .bind(rule_name)
                    .bind(&since)
                    .fetch_one(&mut *conn)
                    .await
                    .db()?;
            (recent >= reaction.max_firings_per_hour())
                .then(|| skip("rate", format!("{recent} firings in the last hour; the rule allows {}", reaction.max_firings_per_hour())))
        };
        if let Some(outcome) = outcome {
            self.record_skip(conn, &system, rule_name, event_id, depth, &outcome).await?;
            return Ok((outcome, None));
        }

        let event = sqlx::query("SELECT payload, traceparent FROM events WHERE event_id = ?").bind(event_id).fetch_optional(&mut *conn).await.db()?;
        let Some(event) = event else {
            let outcome = skip("error", "the event no longer exists".into());
            self.record_skip(conn, &system, rule_name, event_id, depth, &outcome).await?;
            return Ok((outcome, None));
        };
        let payload = jcol(&event, "payload");
        let mut input = match template::render(&reaction.input, &payload) {
            Ok(input) => input,
            Err(err) => {
                let outcome = skip("error", err.to_string());
                self.record_skip(conn, &system, rule_name, event_id, depth, &outcome).await?;
                return Ok((outcome, None));
            }
        };
        if let (Some(object), Some(budget)) = (input.as_object_mut(), &reaction.budget) {
            object.entry("budget").or_insert_with(|| json!({"maxTokens": budget.max_tokens, "maxMinutes": budget.max_minutes}));
        }

        let owner_id = scol(&rule, "owner_principal_id");
        let owner = self.principal_by_id(conn, &owner_id).await?.filter(|p| p.status == "active");
        let Some(owner) = owner else {
            let outcome = skip("denied", "the rule's owner is missing or disabled".into());
            self.record_skip(conn, &system, rule_name, event_id, depth, &outcome).await?;
            return Ok((outcome, None));
        };
        let actor = self.actor_for_principal(&owner, None).await;
        let trace = scol_opt(&event, "traceparent").and_then(|t| TraceContext::parse(&t)).map(|t| t.child()).unwrap_or_else(TraceContext::new_root);
        let ctx = Ctx::new(actor)
            .with_trace(trace)
            .with_transport("reaction")
            .with_idempotency(format!("reaction:{rule_name}:{event_id}"))
            .with_origin(TaskOrigin::reaction(rule_name, event_id, depth));
        let request = SubmitTask {
            capability: Some(CapabilityRef { id: reaction.capability.id.clone(), version: reaction.capability.version.clone() }),
            input: Some(input),
            idempotency_key: Some(format!("reaction:{rule_name}:{event_id}")),
            ..Default::default()
        };

        let mut savepoint = Connection::begin(&mut *conn).await.db()?;
        let submitted = self.submit_task_in_tx(&mut savepoint, &ctx, request).await;
        match submitted {
            Ok(response) => {
                savepoint.commit().await.db()?;
                let now = self.now_ts();
                sqlx::query("UPDATE reaction_firings SET status = 'fired', task_id = ?, approval_id = ?, decided_at = ? WHERE domain_id = ? AND rule_name = ? AND event_id = ?")
                    .bind(&response.task.task.task_id)
                    .bind(&response.approval_id)
                    .bind(&now)
                    .bind(&self.cfg.domain_id)
                    .bind(rule_name)
                    .bind(event_id)
                    .execute(&mut *conn)
                    .await
                    .db()?;
                sqlx::query("UPDATE rules SET fired = fired + 1, last_fired_at = ? WHERE domain_id = ? AND rule_name = ?")
                    .bind(&now)
                    .bind(&self.cfg.domain_id)
                    .bind(rule_name)
                    .execute(&mut *conn)
                    .await
                    .db()?;
                let task_id = response.task.task.task_id.clone();
                let fired = json!({"rule": rule_name, "eventId": event_id, "depth": depth, "taskId": task_id, "approvalId": response.approval_id, "awaitingApproval": response.approval_id.is_some(), "state": response.task.task.state.as_str()});
                self.emit(conn, &system, EventSpec::new("reaction.fired", fired)).await?;
                self.audit(
                    conn,
                    &ctx,
                    AuditRecord::new("reaction.fire", Some(format!("rule://{rule_name}")), "success")
                        .task(Some(task_id.clone()))
                        .detail(json!({"eventId": event_id, "depth": depth})),
                )
                .await?;
                Ok((ReactionOutcome::Fired { task_id, approval_id: response.approval_id }, None))
            }
            Err(err) => {
                savepoint.rollback().await.db()?;
                let denied = err.code == ErrorCode::PolicyDenied;
                let outcome = skip(if denied { "denied" } else { "error" }, err.to_string());
                self.record_skip(conn, &system, rule_name, event_id, depth, &outcome).await?;
                Ok((outcome, denied.then_some((ctx, err))))
            }
        }
    }

    async fn bump_counter(&self, conn: &mut SqliteConnection, rule_name: &str, reason: &str) -> Result<(), Error> {
        let column = counter_column(reason);
        sqlx::query(sqlx::AssertSqlSafe(format!("UPDATE rules SET {column} = {column} + 1 WHERE domain_id = ? AND rule_name = ?")))
            .bind(&self.cfg.domain_id)
            .bind(rule_name)
            .execute(conn)
            .await
            .db()?;
        Ok(())
    }

    async fn record_skip(
        &self,
        conn: &mut SqliteConnection,
        system: &Ctx,
        rule_name: &str,
        event_id: &str,
        depth: i64,
        outcome: &ReactionOutcome,
    ) -> Result<(), Error> {
        let ReactionOutcome::Skipped { reason, detail } = outcome else { return Ok(()) };
        sqlx::query(
            "UPDATE reaction_firings SET status = 'skipped', reason = ?, detail = ?, decided_at = ? WHERE domain_id = ? AND rule_name = ? AND event_id = ?",
        )
        .bind(reason)
        .bind(detail)
        .bind(self.now_ts())
        .bind(&self.cfg.domain_id)
        .bind(rule_name)
        .bind(event_id)
        .execute(&mut *conn)
        .await
        .db()?;
        self.bump_counter(conn, rule_name, reason).await?;
        let payload = json!({"rule": rule_name, "eventId": event_id, "depth": depth, "reason": reason, "detail": detail});
        self.emit(conn, system, EventSpec::new("reaction.skipped", payload)).await?;
        self.audit(
            conn,
            system,
            AuditRecord::new("reaction.skip", Some(format!("rule://{rule_name}")), "skipped")
                .detail(json!({"eventId": event_id, "reason": reason, "detail": detail})),
        )
        .await?;
        Ok(())
    }

    /// A task that a reaction started was rejected because its approval was denied or expired: count it against the rule.
    pub(crate) async fn reaction_approval_closed(&self, conn: &mut SqliteConnection, row: &crate::tasks::TaskRow, outcome: &str) -> Result<(), Error> {
        let Some((origin, rule)) = row
            .origin
            .as_ref()
            .and_then(|o| serde_json::from_value::<TaskOrigin>(o.clone()).ok())
            .filter(|o| o.kind == "reaction")
            .and_then(|o| o.rule.clone().map(|rule| (o, rule)))
        else {
            return Ok(());
        };
        self.bump_counter(conn, &rule, "approval").await?;
        self.metrics.reactions_skipped.with_label_values(&["approval"]).inc();
        let payload = json!({"rule": rule, "eventId": origin.event_id, "depth": origin.depth, "reason": "approval", "detail": format!("approval {outcome}"), "taskId": row.task_id});
        self.emit(conn, &self.system_ctx(), EventSpec::new("reaction.skipped", payload)).await?;
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReactionOutcome {
    Fired {
        task_id: String,
        approval_id: Option<String>,
    },
    Skipped {
        reason: String,
        detail: String,
    },
    /// The ledger row is missing (the event was purged); nothing to do.
    Gone,
}

pub struct ReactionSink {
    domain: Domain,
}

impl ReactionSink {
    pub fn new(domain: Domain) -> Self {
        Self { domain }
    }
}

#[async_trait]
impl OutboxSink for ReactionSink {
    fn name(&self) -> &'static str {
        SINK_REACTION
    }

    async fn deliver(&self, item: &OutboxItem) -> Result<(), SinkError> {
        self.domain.process_reaction(item).await.map(|_| ()).map_err(|e| SinkError::transient(e.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn rule_names_are_restricted() {
        assert!(valid_rule_name("pr-review"));
        assert!(valid_rule_name("a.b_c-1"));
        assert!(!valid_rule_name(""));
        assert!(!valid_rule_name("-x"));
        assert!(!valid_rule_name("Pr"));
        assert!(!valid_rule_name("a b"));
    }

    #[test]
    fn filters_compare_typed_values_at_pointers() {
        let payload = json!({"data": {"draft": false, "action": "opened", "n": 3}});
        assert!(filters_hold(&json!([]), &payload));
        assert!(filters_hold(&json!([{"path": "/data/draft", "equals": false}, {"path": "/data/action", "equals": "opened"}]), &payload));
        assert!(!filters_hold(&json!([{"path": "/data/draft", "equals": true}]), &payload));
        assert!(!filters_hold(&json!([{"path": "/data/missing", "equals": null}]), &payload));
        assert!(!filters_hold(&json!([{"path": "/data/n", "equals": "3"}]), &payload));
    }

    #[test]
    fn reaction_defaults_and_validation() {
        let spec: ReactionSpec = serde_json::from_value(json!({"capability": {"id": "code.review", "version": 3}, "input": {"a": "${/data/x}"}})).unwrap();
        assert_eq!(spec.capability.version, "3");
        let normalized = spec.normalized().unwrap();
        assert_eq!(normalized.max_depth, Some(3));
        assert_eq!(normalized.max_firings_per_hour, Some(30));
        let bad: ReactionSpec = serde_json::from_value(json!({"capability": {"id": "x", "version": "1"}, "input": [], "maxDepth": 0})).unwrap();
        assert!(bad.normalized().is_err());
    }
}

//! Agent catalog: self-registration (CAT-01), policy-filtered search (CAT-02/03/04), logical agents vs runtime
//! instances (CAT-05) and external card import (CAT-06, see [`crate::interop`]).

use std::collections::{BTreeMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use somework_core::{Error, ErrorCode, canonical::digest_json, clock::parse_ts, contracts::*, ids, schema, subjects};
use sqlx::{Row, SqliteConnection, sqlite::SqliteRow};

use crate::{
    audit::AuditRecord,
    db::{DbResultExt, icol, jcol, scol, scol_opt},
    domain::{Ctx, Domain},
    events::EventSpec,
    policy::AuthzRequest,
};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct RegisterAgent {
    pub card: Value,
    #[serde(default)]
    pub visibility: Option<Visibility>,
    #[serde(default)]
    pub source: Option<Source>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ApproveEntry {
    pub status: Option<ApprovalStatus>,
    pub visibility: Option<Visibility>,
    pub exported_capabilities: Option<Vec<String>>,
    pub trust_tier: Option<TrustTier>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct SearchConstraints {
    pub side_effects_at_most: Option<SideEffects>,
    pub data_classification: Option<String>,
    pub allowed_domains: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct SearchRequest {
    pub query: Option<String>,
    pub required_capabilities: Vec<String>,
    pub tags: Vec<String>,
    /// A sample input the caller intends to send; capabilities whose input schema rejects it are excluded.
    pub input: Option<Value>,
    /// Schema of the data the caller can supply: every required property of the capability must be covered.
    pub input_schema: Option<Value>,
    /// Properties the caller needs in the result.
    pub output_schema: Option<Value>,
    pub constraints: Option<SearchConstraints>,
    pub availability: Vec<AvailabilityState>,
    pub trust_tiers: Vec<TrustTier>,
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatch {
    pub entry_id: String,
    pub agent_id: String,
    pub domain_id: String,
    pub score: f64,
    pub availability: AvailabilityState,
    pub matched_capabilities: Vec<CapabilityRef>,
    pub why: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResponse {
    pub matches: Vec<SearchMatch>,
}

const STOPWORDS: &[&str] = &[
    "a",
    "an",
    "and",
    "the",
    "to",
    "of",
    "for",
    "in",
    "on",
    "with",
    "this",
    "that",
    "is",
    "are",
    "be",
    "by",
    "it",
    "me",
    "my",
    "i",
    "we",
    "can",
    "who",
    "which",
    "please",
    "need",
    "find",
    "someone",
    "something",
];

fn fts_query(text: &str) -> Option<String> {
    let tokens: Vec<String> = text
        .split(|c: char| !c.is_alphanumeric())
        .filter(|t| t.len() > 1 && !STOPWORDS.contains(&t.to_lowercase().as_str()))
        .map(|t| format!("\"{}\"", t.to_lowercase()))
        .collect();
    if tokens.is_empty() { None } else { Some(tokens.join(" OR ")) }
}

pub fn search_text_for(card: &AgentCard) -> String {
    let mut parts = vec![card.display_name.clone(), card.description.clone(), card.agent_id.replace(['/', '.', '-', '_'], " ")];
    for cap in &card.capabilities {
        parts.push(cap.id.replace(['.', '-', '_'], " "));
        parts.push(cap.name.clone());
        parts.push(cap.description.clone());
        parts.extend(cap.tags.iter().cloned());
    }
    parts.extend(card.labels.values().cloned());
    let text = parts.join(" ");
    text.chars().take(8192).collect()
}

/// Structural compatibility: the caller can supply every property the capability requires.
pub fn input_schema_compatible(capability_input: &Value, caller_supplies: &Value) -> bool {
    let required: Vec<&str> =
        capability_input.get("required").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
    let supplied = caller_supplies.get("properties").and_then(Value::as_object);
    let cap_props = capability_input.get("properties").and_then(Value::as_object);
    required.iter().all(|prop| {
        let Some(supplied) = supplied else { return false };
        let Some(have) = supplied.get(*prop) else { return false };
        match (cap_props.and_then(|p| p.get(*prop)).and_then(|p| p.get("type")), have.get("type")) {
            (Some(a), Some(b)) => a == b,
            _ => true,
        }
    })
}

/// Structural compatibility: the capability's output schema describes every property the caller needs.
pub fn output_schema_compatible(capability_output: &Value, caller_needs: &Value) -> bool {
    let needed: Vec<&str> = caller_needs
        .get("required")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).collect())
        .or_else(|| caller_needs.get("properties").and_then(Value::as_object).map(|o| o.keys().map(String::as_str).collect()))
        .unwrap_or_default();
    let offered = capability_output.get("properties").and_then(Value::as_object);
    needed.iter().all(|prop| {
        let Some(have) = offered.and_then(|o| o.get(*prop)) else { return false };
        match (caller_needs.get("properties").and_then(|p| p.get(*prop)).and_then(|p| p.get("type")), have.get("type")) {
            (Some(a), Some(b)) => a == b,
            _ => true,
        }
    })
}

struct EntryRow {
    entry_id: String,
    agent_id: String,
    domain_id: String,
    visibility: Visibility,
    exported: Vec<String>,
    trust_tier: Option<TrustTier>,
    approval: ApprovalStatus,
    card: AgentCard,
    row: SqliteRow,
}

fn parse_visibility(raw: &str) -> Visibility {
    match raw {
        "private" => Visibility::Private,
        "exported" => Visibility::Exported,
        "public" => Visibility::Public,
        _ => Visibility::Domain,
    }
}

fn parse_approval(raw: &str) -> ApprovalStatus {
    match raw {
        "approved" => ApprovalStatus::Approved,
        "suspended" => ApprovalStatus::Suspended,
        "revoked" => ApprovalStatus::Revoked,
        _ => ApprovalStatus::Draft,
    }
}

fn parse_trust(raw: Option<String>) -> Option<TrustTier> {
    raw.and_then(|r| match r.as_str() {
        "local" => Some(TrustTier::Local),
        "partner" => Some(TrustTier::Partner),
        "external" => Some(TrustTier::External),
        "untrusted" => Some(TrustTier::Untrusted),
        _ => None,
    })
}

fn parse_source(raw: &str) -> SourceType {
    match raw {
        "a2a" => SourceType::A2a,
        "manual" => SourceType::Manual,
        _ => SourceType::Native,
    }
}

fn entry_from_row(row: SqliteRow) -> Result<EntryRow, Error> {
    let card: AgentCard = serde_json::from_value(jcol(&row, "card")).map_err(|e| Error::internal(format!("stored agent card is invalid: {e}")))?;
    Ok(EntryRow {
        entry_id: scol(&row, "entry_id"),
        agent_id: scol(&row, "agent_id"),
        domain_id: scol(&row, "domain_id"),
        visibility: parse_visibility(&scol(&row, "visibility")),
        exported: serde_json::from_value(jcol(&row, "exported_capabilities")).unwrap_or_default(),
        trust_tier: parse_trust(scol_opt(&row, "trust_tier")),
        approval: parse_approval(&scol(&row, "approval_status")),
        card,
        row,
    })
}

impl Domain {
    pub async fn agent_availability(
        &self,
        conn: &mut SqliteConnection,
        agent_id: &str,
        agent_status: &str,
        capability_ids: &[String],
    ) -> Result<Availability, Error> {
        let cutoff = somework_core::clock::ts(self.now() - chrono::Duration::seconds(self.cfg.runtime_ttl_seconds));
        let active: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM runtime_instances WHERE agent_id = ? AND status = 'active' AND last_seen_at >= ?")
            .bind(agent_id)
            .bind(&cutoff)
            .fetch_one(&mut *conn)
            .await
            .db()?;
        let ever: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM runtime_instances WHERE agent_id = ?").bind(agent_id).fetch_one(&mut *conn).await.db()?;
        let mut queue: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM tasks WHERE state = 'queued' AND target_agent_id = ?").bind(agent_id).fetch_one(&mut *conn).await.db()?;
        for cap in capability_ids {
            let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM tasks WHERE state = 'queued' AND target_agent_id IS NULL AND capability_id = ?")
                .bind(cap)
                .fetch_one(&mut *conn)
                .await
                .db()?;
            queue += n;
        }
        let state = if agent_status == "disabled" {
            AvailabilityState::Offline
        } else if active > 0 {
            if queue >= active * 4 { AvailabilityState::Busy } else { AvailabilityState::Available }
        } else if ever > 0 {
            AvailabilityState::Queueable
        } else {
            AvailabilityState::Unknown
        };
        Ok(Availability { state, active_instances: Some(active as u64), queue_depth: Some(queue as u64), observed_at: Some(self.now_ts()) })
    }

    fn actor_is_owner_or_admin(&self, ctx: &Ctx, agent_id: &str) -> bool {
        (ctx.actor.kind == ActorKind::Agent && ctx.actor.id == agent_id)
            || ctx.actor.permissions.allows_action("catalog.approve")
            || ctx.actor.permissions.allows_action("catalog.write.any")
    }

    /// CAT-03: the single visibility gate used by every read path *before* anything is assembled for the caller.
    /// Returns the capabilities of `entry` the caller may see, or `None` when the entry itself is hidden.
    fn visible_capabilities(&self, ctx: &Ctx, entry: &EntryRow) -> Option<Vec<Capability>> {
        let owner_or_admin = self.actor_is_owner_or_admin(ctx, &entry.agent_id) && ctx.actor.peer_domain.is_none();
        if owner_or_admin {
            return Some(entry.card.capabilities.clone());
        }
        if entry.approval != ApprovalStatus::Approved || entry.card.status == Some(AgentStatus::Disabled) {
            return None;
        }
        if let Some(peer) = &ctx.actor.peer_domain {
            let _ = peer;
            if !matches!(entry.visibility, Visibility::Exported | Visibility::Public) {
                return None;
            }
            let caps: Vec<Capability> = entry
                .card
                .capabilities
                .iter()
                .filter(|c| entry.exported.iter().any(|e| e == &c.id) && ctx.actor.permissions.may_discover(&c.id))
                .cloned()
                .collect();
            return if caps.is_empty() { None } else { Some(caps) };
        }
        match entry.visibility {
            Visibility::Private => return None,
            Visibility::Domain | Visibility::Exported | Visibility::Public => {}
        }
        let caps: Vec<Capability> = entry.card.capabilities.iter().filter(|c| ctx.actor.permissions.may_discover(&c.id)).cloned().collect();
        if caps.is_empty() { None } else { Some(caps) }
    }

    pub async fn register_agent(&self, ctx: &Ctx, req: RegisterAgent) -> Result<CatalogEntry, Error> {
        self.run(ctx, "catalog.register", async {
            schema::validate_contract("AgentCard", &req.card)?;
            let card: AgentCard = serde_json::from_value(req.card.clone())?;
            if card.domain_id != self.cfg.domain_id {
                return Err(Error::invalid(format!("card domainId must be {}", self.cfg.domain_id)));
            }
            let admin = ctx.actor.permissions.allows_action("catalog.write.any");
            if !(admin || ctx.actor.kind == ActorKind::Agent && ctx.actor.id == card.agent_id) {
                return Err(Error::new(ErrorCode::SenderMismatch, "an agent may only register its own card"));
            }
            for cap in &card.capabilities {
                schema::check_schema(&cap.input_schema, &format!("capability {} inputSchema", cap.id))?;
                schema::check_schema(&cap.output_schema, &format!("capability {} outputSchema", cap.id))?;
            }
            if let Some(source) = &req.source
                && source.kind != SourceType::Native
                && !admin
            {
                return Err(Error::denied("only administrators may register non-native catalog sources"));
            }
            let this = self.clone();
            let ctx2 = ctx.clone();
            self.write(move |tx| {
                Box::pin(async move {
                    this.enforce(tx, &ctx2, AuthzRequest::new("catalog.register").resource(format!("agent://{}", card.agent_id))).await?;
                    this.register_agent_tx(tx, &ctx2, card, req.visibility, req.source, admin).await
                })
            })
            .await
        })
        .await
    }

    pub(crate) async fn register_agent_tx(
        &self,
        conn: &mut SqliteConnection,
        ctx: &Ctx,
        card: AgentCard,
        visibility: Option<Visibility>,
        source: Option<Source>,
        admin: bool,
    ) -> Result<CatalogEntry, Error> {
        let now = self.now_ts();
        let policy = self.active_policy(conn).await?;
        let principal = self.principal_by_label(conn, ActorKind::Agent, &card.agent_id).await?;
        let agent_max = principal.as_ref().map(|p| p.permissions.side_effects_max()).unwrap_or(SideEffects::Read);
        let is_native = source.as_ref().is_none_or(|s| s.kind == SourceType::Native);
        if is_native {
            if principal.is_none() {
                return Err(Error::not_found("agent principal (enroll the agent before registering its card)"));
            }
            for cap in &card.capabilities {
                if cap.side_effects > agent_max {
                    return Err(Error::denied(format!(
                        "capability {} declares {} side effects, above the agent's maximum authority ({})",
                        cap.id,
                        cap.side_effects.as_str(),
                        agent_max.as_str()
                    )));
                }
            }
        }

        // Capability contracts are immutable per version.
        for cap in &card.capabilities {
            let value = serde_json::to_value(cap)?;
            let digest = digest_json(&value);
            let existing: Option<String> = sqlx::query_scalar("SELECT digest FROM capabilities WHERE domain_id = ? AND capability_id = ? AND version = ?")
                .bind(&self.cfg.domain_id)
                .bind(&cap.id)
                .bind(&cap.version)
                .fetch_optional(&mut *conn)
                .await
                .db()?;
            match existing {
                Some(d) if d == digest => {}
                Some(_) => {
                    return Err(Error::new(
                        ErrorCode::Conflict,
                        format!("capability {}@{} already exists with a different contract; publish a new version", cap.id, cap.version),
                    ));
                }
                None => {
                    sqlx::query("INSERT INTO capabilities(domain_id, capability_id, version, definition, digest, side_effects, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
                        .bind(&self.cfg.domain_id)
                        .bind(&cap.id)
                        .bind(&cap.version)
                        .bind(value.to_string())
                        .bind(digest)
                        .bind(cap.side_effects.as_str())
                        .bind(&now)
                        .execute(&mut *conn)
                        .await
                        .db()?;
                }
            }
        }

        let existing = sqlx::query("SELECT a.card_version, a.card, c.approval_status, c.visibility, c.entry_id FROM agents a LEFT JOIN catalog_entries c ON c.agent_id = a.agent_id WHERE a.agent_id = ?")
            .bind(&card.agent_id)
            .fetch_optional(&mut *conn)
            .await
            .db()?;
        let mut stored_card = card.clone();
        stored_card.card_version = Some(1);
        stored_card.updated_at = Some(now.clone());
        let entry_id = format!("catalog/{}", card.agent_id.trim_start_matches("agent/"));
        let auto_approve = policy.catalog_auto_approve;
        let visibility_requested = visibility.unwrap_or(Visibility::Domain);
        let visibility_effective = if admin {
            visibility_requested
        } else if matches!(visibility_requested, Visibility::Private) {
            Visibility::Private
        } else {
            Visibility::Domain
        };
        let pool = card.pool_id();

        let (approval_status, change_summary): (ApprovalStatus, &str) = match &existing {
            None => {
                stored_card.card_version = Some(1);
                sqlx::query("INSERT INTO agents(agent_id, domain_id, principal_id, display_name, description, owner, status, card_version, pool_id, card, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)")
                    .bind(&card.agent_id)
                    .bind(&self.cfg.domain_id)
                    .bind(principal.as_ref().map(|p| p.principal_id.clone()))
                    .bind(&card.display_name)
                    .bind(&card.description)
                    .bind(serde_json::to_string(&card.owner)?)
                    .bind(match card.status.unwrap_or(AgentStatus::Active) { AgentStatus::Active => "active", AgentStatus::Degraded => "degraded", AgentStatus::Offline => "offline", AgentStatus::Disabled => "disabled" })
                    .bind(&pool)
                    .bind(serde_json::to_string(&stored_card)?)
                    .bind(&now)
                    .bind(&now)
                    .execute(&mut *conn)
                    .await
                    .db()?;
                let status = if auto_approve { ApprovalStatus::Approved } else { ApprovalStatus::Draft };
                let src = source.clone().unwrap_or(Source { kind: SourceType::Native, uri: None, digest: None });
                sqlx::query("INSERT INTO catalog_entries(entry_id, domain_id, agent_id, visibility, exported_capabilities, trust_tier, approval_status, approved_by, approved_at, policy_version, source_type, source_uri, source_digest, search_text, labels, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, '[]', 'local', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
                    .bind(&entry_id)
                    .bind(&self.cfg.domain_id)
                    .bind(&card.agent_id)
                    .bind(match visibility_effective { Visibility::Private => "private", Visibility::Domain => "domain", Visibility::Exported => "exported", Visibility::Public => "public" })
                    .bind(status.as_str())
                    .bind(if auto_approve { Some("policy:auto") } else { None })
                    .bind(if auto_approve { Some(now.clone()) } else { None })
                    .bind(&policy.version)
                    .bind(match src.kind { SourceType::Native => "native", SourceType::A2a => "a2a", SourceType::Manual => "manual" })
                    .bind(&src.uri)
                    .bind(&src.digest)
                    .bind(search_text_for(&card))
                    .bind(serde_json::to_string(&card.labels)?)
                    .bind(&ctx.actor.principal_id)
                    .bind(&now)
                    .bind(&now)
                    .execute(&mut *conn)
                    .await
                    .db()?;
                (status, "registered")
            }
            Some(row) => {
                let old_card: AgentCard = serde_json::from_value(jcol(row, "card"))?;
                let version = icol(row, "card_version") as u64;
                let mut new_card = card.clone();
                let materially_changed = old_card.capabilities.iter().map(|c| (c.id.clone(), c.version.clone(), c.side_effects)).collect::<Vec<_>>()
                    != card.capabilities.iter().map(|c| (c.id.clone(), c.version.clone(), c.side_effects)).collect::<Vec<_>>();
                let mut compare_old = old_card.clone();
                compare_old.card_version = None;
                compare_old.updated_at = None;
                let mut compare_new = card.clone();
                compare_new.card_version = None;
                compare_new.updated_at = None;
                let unchanged = compare_old == compare_new;
                new_card.card_version = Some(if unchanged { version } else { version + 1 });
                new_card.updated_at = Some(now.clone());
                let prior_status = parse_approval(&scol(row, "approval_status"));
                let status = if unchanged {
                    prior_status
                } else if prior_status == ApprovalStatus::Revoked {
                    ApprovalStatus::Revoked
                } else if materially_changed && !auto_approve {
                    ApprovalStatus::Draft
                } else {
                    prior_status
                };
                if !unchanged {
                    sqlx::query("UPDATE agents SET display_name = ?, description = ?, owner = ?, status = ?, card_version = ?, pool_id = ?, card = ?, updated_at = ? WHERE agent_id = ?")
                        .bind(&card.display_name)
                        .bind(&card.description)
                        .bind(serde_json::to_string(&card.owner)?)
                        .bind(match card.status.unwrap_or(AgentStatus::Active) { AgentStatus::Active => "active", AgentStatus::Degraded => "degraded", AgentStatus::Offline => "offline", AgentStatus::Disabled => "disabled" })
                        .bind(new_card.card_version.unwrap_or(1) as i64)
                        .bind(&pool)
                        .bind(serde_json::to_string(&new_card)?)
                        .bind(&now)
                        .bind(&card.agent_id)
                        .execute(&mut *conn)
                        .await
                        .db()?;
                    sqlx::query("UPDATE catalog_entries SET approval_status = ?, search_text = ?, labels = ?, updated_at = ?, visibility = CASE WHEN ? THEN ? ELSE visibility END WHERE agent_id = ?")
                        .bind(status.as_str())
                        .bind(search_text_for(&card))
                        .bind(serde_json::to_string(&card.labels)?)
                        .bind(&now)
                        .bind(visibility.is_some())
                        .bind(match visibility_effective { Visibility::Private => "private", Visibility::Domain => "domain", Visibility::Exported => "exported", Visibility::Public => "public" })
                        .bind(&card.agent_id)
                        .execute(&mut *conn)
                        .await
                        .db()?;
                }
                (status, if unchanged { "unchanged" } else { "updated" })
            }
        };

        sqlx::query("DELETE FROM agent_capabilities WHERE agent_id = ?").bind(&card.agent_id).execute(&mut *conn).await.db()?;
        for cap in &card.capabilities {
            sqlx::query("INSERT INTO agent_capabilities(agent_id, capability_id, capability_version, domain_id) VALUES (?, ?, ?, ?)")
                .bind(&card.agent_id)
                .bind(&cap.id)
                .bind(&cap.version)
                .bind(&self.cfg.domain_id)
                .execute(&mut *conn)
                .await
                .db()?;
        }
        sqlx::query("DELETE FROM catalog_fts WHERE entry_id = ?").bind(&entry_id).execute(&mut *conn).await.db()?;
        sqlx::query("INSERT INTO catalog_fts(entry_id, body) VALUES (?, ?)").bind(&entry_id).bind(search_text_for(&card)).execute(&mut *conn).await.db()?;

        if change_summary != "unchanged" {
            let payload = json!({"entryId": entry_id, "agentId": card.agent_id, "change": change_summary, "approval": approval_status.as_str()});
            let spec = EventSpec::new("catalog.changed", payload.clone())
                .nats(subjects::EVENT_CATALOG_CHANGED.to_string(), payload)
                .recipient(ctx.actor.principal_id.clone(), false);
            self.emit(conn, ctx, spec).await?;
        }
        self.audit(
            conn,
            ctx,
            AuditRecord::new("catalog.register", Some(format!("agent://{}", card.agent_id)), "success")
                .request(digest_json(&serde_json::to_value(&card)?))
                .detail(json!({"change": change_summary, "approval": approval_status.as_str()})),
        )
        .await?;
        self.entry_by_id(conn, &entry_id).await
    }

    async fn entry_row(&self, conn: &mut SqliteConnection, key: &str) -> Result<Option<EntryRow>, Error> {
        let row = sqlx::query("SELECT c.*, a.card AS card, a.status AS agent_status FROM catalog_entries c JOIN agents a ON a.agent_id = c.agent_id WHERE c.entry_id = ? OR c.agent_id = ?")
            .bind(key)
            .bind(key)
            .fetch_optional(conn)
            .await
            .db()?;
        row.map(entry_from_row).transpose()
    }

    async fn entry_view(&self, conn: &mut SqliteConnection, e: &EntryRow, capabilities: Option<Vec<Capability>>) -> Result<CatalogEntry, Error> {
        let agent_status = scol(&e.row, "agent_status");
        let cap_ids: Vec<String> = e.card.capabilities.iter().map(|c| c.id.clone()).collect();
        let availability = self.agent_availability(conn, &e.agent_id, &agent_status, &cap_ids).await?;
        let mut card = e.card.clone();
        if let Some(caps) = capabilities {
            card.capabilities = caps;
        }
        Ok(CatalogEntry {
            entry_id: e.entry_id.clone(),
            agent_card: card,
            visibility: e.visibility,
            exported_capabilities: e.exported.clone(),
            trust_tier: e.trust_tier,
            approval: Approval {
                status: e.approval,
                approved_by: scol_opt(&e.row, "approved_by"),
                approved_at: scol_opt(&e.row, "approved_at"),
                policy_version: scol_opt(&e.row, "policy_version"),
            },
            availability,
            source: Source { kind: parse_source(&scol(&e.row, "source_type")), uri: scol_opt(&e.row, "source_uri"), digest: scol_opt(&e.row, "source_digest") },
            search_text: None,
            labels: serde_json::from_value::<BTreeMap<String, String>>(jcol(&e.row, "labels")).unwrap_or_default(),
        })
    }

    pub(crate) async fn entry_by_id(&self, conn: &mut SqliteConnection, key: &str) -> Result<CatalogEntry, Error> {
        let e = self.entry_row(conn, key).await?.ok_or_else(|| Error::not_found("catalog entry"))?;
        self.entry_view(conn, &e, None).await
    }

    /// `GET /v1/agents/{agentId}`: the caller sees an AgentCard restricted to the capabilities it may discover, or
    /// a plain `not_found` that is indistinguishable from an agent that does not exist.
    pub async fn get_agent(&self, ctx: &Ctx, agent_id: &str) -> Result<CatalogEntry, Error> {
        self.enforce_read(ctx, AuthzRequest::new("catalog.read").resource(format!("agent://{agent_id}"))).await?;
        let mut conn = self.db.pool().acquire().await.db()?;
        let e = self.entry_row(&mut conn, agent_id).await?.ok_or_else(|| Error::not_found("agent"))?;
        let Some(caps) = self.visible_capabilities(ctx, &e) else { return Err(Error::not_found("agent")) };
        let mut view = self.entry_view(&mut conn, &e, Some(caps)).await?;
        if ctx.actor.peer_domain.is_some() {
            sanitize_for_peer(&mut view);
        }
        Ok(view)
    }

    pub async fn get_capability(&self, ctx: &Ctx, id: &str, version: &str) -> Result<Capability, Error> {
        self.enforce_read(ctx, AuthzRequest::new("catalog.read").resource(format!("capability://{id}/{version}"))).await?;
        let mut conn = self.db.pool().acquire().await.db()?;
        let rows = sqlx::query("SELECT c.*, a.card AS card, a.status AS agent_status FROM agent_capabilities ac JOIN catalog_entries c ON c.agent_id = ac.agent_id JOIN agents a ON a.agent_id = c.agent_id WHERE ac.capability_id = ? AND ac.capability_version = ?")
            .bind(id)
            .bind(version)
            .fetch_all(&mut *conn)
            .await
            .db()?;
        for row in rows {
            let e = entry_from_row(row)?;
            if let Some(caps) = self.visible_capabilities(ctx, &e)
                && let Some(cap) = caps.into_iter().find(|c| c.id == id && c.version == version)
            {
                return Ok(cap);
            }
        }
        Err(Error::not_found("capability"))
    }

    pub async fn list_catalog(&self, ctx: &Ctx) -> Result<Vec<CatalogEntry>, Error> {
        self.enforce_read(ctx, AuthzRequest::new("catalog.read")).await?;
        let mut conn = self.db.pool().acquire().await.db()?;
        let rows = sqlx::query("SELECT c.*, a.card AS card, a.status AS agent_status FROM catalog_entries c JOIN agents a ON a.agent_id = c.agent_id WHERE c.domain_id = ? ORDER BY c.entry_id")
            .bind(&self.cfg.domain_id)
            .fetch_all(&mut *conn)
            .await
            .db()?;
        let mut out = Vec::new();
        for row in rows {
            let e = entry_from_row(row)?;
            if let Some(caps) = self.visible_capabilities(ctx, &e) {
                let mut view = self.entry_view(&mut conn, &e, Some(caps)).await?;
                if ctx.actor.peer_domain.is_some() {
                    sanitize_for_peer(&mut view);
                }
                out.push(view);
            }
        }
        Ok(out)
    }

    pub async fn approve_entry(&self, ctx: &Ctx, entry_id: &str, req: ApproveEntry) -> Result<CatalogEntry, Error> {
        self.run(ctx, "catalog.approve", async {
            let this = self.clone();
            let ctx2 = ctx.clone();
            let entry_id = entry_id.to_string();
            self.write(move |tx| {
                Box::pin(async move {
                    let decision = this.enforce(tx, &ctx2, AuthzRequest::new("catalog.approve").resource(format!("catalog://{entry_id}"))).await?;
                    let e = this.entry_row(tx, &entry_id).await?.ok_or_else(|| Error::not_found("catalog entry"))?;
                    let now = this.now_ts();
                    let policy = this.active_policy(tx).await?;
                    if e.approval == ApprovalStatus::Revoked {
                        return Err(Error::new(ErrorCode::InvalidTransition, "revoked catalog entries cannot be changed"));
                    }
                    let new_status = req.status.unwrap_or(e.approval);
                    if let Some(exported) = &req.exported_capabilities {
                        for id in exported {
                            if !e.card.capabilities.iter().any(|c| &c.id == id) {
                                return Err(Error::invalid(format!("exported capability {id} is not offered by this agent")));
                            }
                        }
                    }
                    sqlx::query("UPDATE catalog_entries SET approval_status = ?, visibility = COALESCE(?, visibility), exported_capabilities = COALESCE(?, exported_capabilities), trust_tier = COALESCE(?, trust_tier), approved_by = ?, approved_at = ?, policy_version = ?, updated_at = ? WHERE entry_id = ?")
                        .bind(new_status.as_str())
                        .bind(req.visibility.map(|v| match v { Visibility::Private => "private", Visibility::Domain => "domain", Visibility::Exported => "exported", Visibility::Public => "public" }))
                        .bind(req.exported_capabilities.as_ref().map(|v| serde_json::to_string(v).unwrap_or_default()))
                        .bind(req.trust_tier.map(|t| match t { TrustTier::Local => "local", TrustTier::Partner => "partner", TrustTier::External => "external", TrustTier::Untrusted => "untrusted" }))
                        .bind(ctx2.actor.label())
                        .bind(&now)
                        .bind(&policy.version)
                        .bind(&now)
                        .bind(&e.entry_id)
                        .execute(&mut **tx)
                        .await
                        .db()?;
                    let payload = json!({"entryId": e.entry_id, "agentId": e.agent_id, "change": "approval", "approval": new_status.as_str()});
                    let spec = EventSpec::new("catalog.changed", payload.clone()).nats(subjects::EVENT_CATALOG_CHANGED.to_string(), payload).recipient(ctx2.actor.principal_id.clone(), false);
                    this.emit(tx, &ctx2, spec).await?;
                    this.audit(tx, &ctx2, AuditRecord::new("catalog.approve", Some(format!("catalog://{}", e.entry_id)), "success").decision(&decision).detail(json!({"from": e.approval.as_str(), "to": new_status.as_str()}))).await?;
                    this.entry_by_id(tx, &e.entry_id).await
                })
            })
            .await
        })
        .await
    }

    pub async fn search_catalog(&self, ctx: &Ctx, req: SearchRequest) -> Result<SearchResponse, Error> {
        let started = std::time::Instant::now();
        let out = self.search_inner(ctx, req).await;
        self.metrics.catalog_search_latency.observe(started.elapsed().as_secs_f64());
        self.metrics.catalog_searches.inc();
        if let Ok(resp) = &out
            && resp.matches.is_empty()
        {
            self.metrics.catalog_no_match.inc();
        }
        out
    }

    async fn search_inner(&self, ctx: &Ctx, req: SearchRequest) -> Result<SearchResponse, Error> {
        self.enforce_read(ctx, AuthzRequest::new("catalog.read")).await?;
        let mut conn = self.db.pool().acquire().await.db()?;
        let limit = req.limit.unwrap_or(10).clamp(1, 50);

        let mut lexical: BTreeMap<String, f64> = BTreeMap::new();
        let query_text = req.query.as_deref().and_then(fts_query);
        if let Some(q) = &query_text {
            let rows = sqlx::query("SELECT entry_id, bm25(catalog_fts) AS score FROM catalog_fts WHERE catalog_fts MATCH ?")
                .bind(q)
                .fetch_all(&mut *conn)
                .await
                .db()?;
            for r in rows {
                let raw: f64 = r.try_get("score").unwrap_or(0.0);
                lexical.insert(scol(&r, "entry_id"), 1.0 / (1.0 + raw.abs().min(1000.0) / 5.0).max(1.0));
            }
        }

        let rows = sqlx::query(
            "SELECT c.*, a.card AS card, a.status AS agent_status FROM catalog_entries c JOIN agents a ON a.agent_id = c.agent_id WHERE c.domain_id = ?",
        )
        .bind(&self.cfg.domain_id)
        .fetch_all(&mut *conn)
        .await
        .db()?;

        let required: Vec<(String, Option<String>)> = req
            .required_capabilities
            .iter()
            .map(|r| match r.split_once('@') {
                Some((id, v)) => (id.to_string(), Some(v.to_string())),
                None => (r.clone(), None),
            })
            .collect();
        let constraints = req.constraints.clone().unwrap_or_default();
        let scale = self.active_policy(&mut conn).await?.scale();
        let mut matches = Vec::new();

        for row in rows {
            let e = entry_from_row(row)?;
            // Policy filtering happens first; nothing below can observe a capability the caller may not see.
            let Some(visible) = self.visible_capabilities(ctx, &e) else { continue };
            if e.agent_id == ctx.actor.id && ctx.actor.kind == ActorKind::Agent && e.approval != ApprovalStatus::Approved {
                continue; // an agent's own drafts are inspectable via get_agent, but never offered as collaborators
            }
            if e.approval != ApprovalStatus::Approved {
                continue;
            }
            if let Some(domains) = &constraints.allowed_domains
                && !domains.iter().any(|d| d == &e.domain_id)
            {
                continue;
            }
            if !req.trust_tiers.is_empty() && !e.trust_tier.is_some_and(|t| req.trust_tiers.contains(&t)) {
                continue;
            }
            if query_text.is_some() && req.required_capabilities.is_empty() && !lexical.contains_key(&e.entry_id) {
                continue;
            }

            let mut matched: Vec<&Capability> = Vec::new();
            let mut why: Vec<String> = Vec::new();
            for cap in &visible {
                if !required.is_empty() {
                    let hit = required.iter().any(|(id, v)| &cap.id == id && v.as_ref().is_none_or(|v| &cap.version == v));
                    if !hit {
                        continue;
                    }
                }
                if let Some(max) = constraints.side_effects_at_most
                    && cap.side_effects > max
                {
                    continue;
                }
                if let Some(class) = &constraints.data_classification
                    && !cap.data_classes.is_empty()
                {
                    let max_rank = cap.data_classes.iter().filter_map(|c| scale.rank(c)).max();
                    match (max_rank, scale.rank(class)) {
                        (Some(m), Some(r)) if r <= m => {}
                        _ => continue,
                    }
                }
                if !req.tags.iter().all(|t| cap.tags.contains(t)) {
                    continue;
                }
                if let Some(input) = &req.input
                    && schema::validate_against(&cap.input_schema, input, "input").is_err()
                {
                    continue;
                }
                if let Some(supplies) = &req.input_schema
                    && !input_schema_compatible(&cap.input_schema, supplies)
                {
                    continue;
                }
                if let Some(needs) = &req.output_schema
                    && !output_schema_compatible(&cap.output_schema, needs)
                {
                    continue;
                }
                matched.push(cap);
            }
            if matched.is_empty() {
                continue;
            }

            let availability = {
                let status = scol(&e.row, "agent_status");
                let ids: Vec<String> = e.card.capabilities.iter().map(|c| c.id.clone()).collect();
                self.agent_availability(&mut conn, &e.agent_id, &status, &ids).await?
            };
            if !req.availability.is_empty() && !req.availability.contains(&availability.state) {
                continue;
            }

            let mut score = 0.0;
            if let Some(l) = lexical.get(&e.entry_id) {
                score += 0.5 * l.min(1.0);
                why.push("Matches the natural-language request".to_string());
            }
            if !required.is_empty() {
                score += 0.3;
                why.push(match matched.first() {
                    Some(c) => format!("Exact capability match ({})", c.id),
                    None => "Exact capability match".into(),
                });
            }
            if req.input.is_some() {
                score += 0.05;
                why.push("Input schema accepts the supplied input".to_string());
            } else if req.input_schema.is_some() {
                score += 0.05;
                why.push("Input schema is satisfiable from the supplied properties".to_string());
            }
            if constraints.side_effects_at_most.is_some() {
                why.push(format!("Side-effect class satisfies the limit ({})", matched.iter().map(|c| c.side_effects.as_str()).max().unwrap_or("none")));
            }
            score += match availability.state {
                AvailabilityState::Available => 0.15,
                AvailabilityState::Busy => 0.08,
                AvailabilityState::Queueable => 0.05,
                _ => 0.0,
            };
            why.push(format!(
                "Availability: {}",
                match availability.state {
                    AvailabilityState::Available => "available",
                    AvailabilityState::Busy => "busy",
                    AvailabilityState::Queueable => "queueable",
                    AvailabilityState::Offline => "offline",
                    AvailabilityState::Unknown => "unknown",
                }
            ));
            why.push("Caller is authorized to see this capability".to_string());
            matches.push(SearchMatch {
                entry_id: e.entry_id.clone(),
                agent_id: e.agent_id.clone(),
                domain_id: e.domain_id.clone(),
                score: (score.clamp(0.0, 0.99) * 100.0).round() / 100.0,
                availability: availability.state,
                matched_capabilities: matched.iter().map(|c| CapabilityRef { id: c.id.clone(), version: c.version.clone() }).collect(),
                why,
            });
        }
        matches.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal).then_with(|| a.agent_id.cmp(&b.agent_id)));
        matches.truncate(limit);
        Ok(SearchResponse { matches })
    }

    /// Agents (not capabilities) currently allowed to claim work for `capability` in the caller-independent sense.
    pub async fn eligible_agents(&self, conn: &mut SqliteConnection, capability_id: &str, version: &str) -> Result<Vec<(String, String)>, Error> {
        let rows = sqlx::query("SELECT a.agent_id, a.pool_id FROM agent_capabilities ac JOIN agents a ON a.agent_id = ac.agent_id JOIN catalog_entries c ON c.agent_id = a.agent_id WHERE ac.capability_id = ? AND ac.capability_version = ? AND c.approval_status = 'approved' AND a.status <> 'disabled' ORDER BY a.agent_id")
            .bind(capability_id)
            .bind(version)
            .fetch_all(conn)
            .await
            .db()?;
        Ok(rows.iter().map(|r| (scol(r, "agent_id"), scol(r, "pool_id"))).collect())
    }

    pub fn capability_ids_of(card: &AgentCard) -> HashSet<String> {
        card.capabilities.iter().map(|c| c.id.clone()).collect()
    }

    pub fn parse_expiry(raw: &str) -> Option<chrono::DateTime<chrono::Utc>> {
        parse_ts(raw)
    }

    pub fn unused_id() -> String {
        ids::event_id()
    }
}

/// Disclosure filter for federated callers: no internal interfaces, contacts or labels (DOM-04).
pub fn sanitize_for_peer(entry: &mut CatalogEntry) {
    entry.agent_card.interfaces = vec![];
    entry.agent_card.owner.contact = None;
    entry.agent_card.owner.service = None;
    entry.agent_card.labels.clear();
    entry.agent_card.auth_schemes.clear();
    entry.labels.clear();
    entry.search_text = None;
    entry.approval.approved_by = None;
    for cap in &mut entry.agent_card.capabilities {
        cap.cost_hint = None;
        cap.required_permissions.clear();
    }
}

impl Domain {
    /// Whether `ctx` may see capability `id@version` (optionally only as offered by `agent_id`). Used by task
    /// submission so that hidden capabilities are indistinguishable from nonexistent ones (CAT-03).
    pub(crate) async fn caller_can_see_capability(
        &self,
        conn: &mut SqliteConnection,
        ctx: &Ctx,
        agent_id: Option<&str>,
        id: &str,
        version: &str,
    ) -> Result<bool, Error> {
        let rows = sqlx::query("SELECT c.*, a.card AS card, a.status AS agent_status FROM agent_capabilities ac JOIN catalog_entries c ON c.agent_id = ac.agent_id JOIN agents a ON a.agent_id = c.agent_id WHERE ac.capability_id = ? AND ac.capability_version = ? AND (? IS NULL OR ac.agent_id = ?)")
            .bind(id)
            .bind(version)
            .bind(agent_id)
            .bind(agent_id)
            .fetch_all(conn)
            .await
            .db()?;
        for row in rows {
            let e = entry_from_row(row)?;
            if e.approval != ApprovalStatus::Approved {
                continue;
            }
            if let Some(caps) = self.visible_capabilities(ctx, &e)
                && caps.iter().any(|c| c.id == id && c.version == version)
            {
                return Ok(true);
            }
        }
        Ok(false)
    }
}

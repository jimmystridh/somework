//! Rules: durable event subscriptions. A rule is a `topic` subscription owned by one principal plus payload filters:
//! a matching event reaches the owner (and wakes it when `wake` is set). What the owner does with the event is its own decision.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use somework_core::{Error, ids};

use crate::{
    audit::AuditRecord,
    db::{DbResultExt, icol, jcol, scol},
    domain::{Ctx, Domain},
    policy::AuthzRequest,
};

const MAX_WHERE_CLAUSES: usize = 20;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WhereClause {
    /// JSON pointer into the event payload, for example `/data/draft`.
    pub path: String,
    pub equals: Value,
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
    /// Reactions no longer exist; the field is read only to refuse a rule that still carries one.
    pub reaction: Option<Value>,
    /// `active` (default) or `paused`.
    pub status: Option<String>,
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
    pub status: String,
    pub subscription_id: String,
    pub created_at: String,
    pub updated_at: String,
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
        status: scol(row, "status"),
        subscription_id: scol(row, "subscription_id"),
        created_at: scol(row, "created_at"),
        updated_at: scol(row, "updated_at"),
    }
}

macro_rules! rule_select {
    ($tail:literal) => {
        concat!("SELECT r.*, s.selector AS selector, s.wake AS wake FROM rules r JOIN subscriptions s ON s.subscription_id = r.subscription_id ", $tail)
    };
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
            if spec.reaction.is_some() {
                return Err(Error::invalid("reactions are removed: a rule only delivers matching events to its owner"));
            }
            let description = spec.description.clone().unwrap_or_default();
            if description.len() > 1000 {
                return Err(Error::invalid("description is limited to 1000 characters"));
            }
            let where_json = serde_json::to_value(&spec.where_filters)?;
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
                        sqlx::query("UPDATE rules SET owner_principal_id = ?, owner = ?, description = ?, where_filters = ?, status = COALESCE(?, status), updated_at = ? WHERE domain_id = ? AND rule_name = ?")
                            .bind(&owner_principal.principal_id)
                            .bind(&owner)
                            .bind(&description)
                            .bind(where_json.to_string())
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
                        sqlx::query("INSERT INTO rules(domain_id, rule_name, subscription_id, owner_principal_id, owner, description, where_filters, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
                            .bind(&this.cfg.domain_id)
                            .bind(&name)
                            .bind(&subscription_id)
                            .bind(&owner_principal.principal_id)
                            .bind(&owner)
                            .bind(&description)
                            .bind(where_json.to_string())
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
                            .detail(json!({"owner": owner, "selector": selector, "wake": wake, "created": created})),
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
}

#[cfg(test)]
mod tests {
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
}

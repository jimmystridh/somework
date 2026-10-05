//! Durable event subscriptions (SUB-01/02). Every subscription must state explicitly whether matching events may
//! wake (invoke) the subscriber; there is no default.

use serde::{Deserialize, Serialize};
use serde_json::json;
use somework_core::{Error, ErrorCode, contracts::*, ids, subjects};

use crate::{
    audit::AuditRecord,
    db::{DbResultExt, icol, scol},
    domain::{Ctx, Domain},
    policy::AuthzRequest,
};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct CreateSubscription {
    /// `topic`, `capability_queue`, `conversation` or `task`.
    pub kind: Option<String>,
    pub selector: Option<String>,
    /// Required: whether matching events may wake the subscriber's runtime.
    pub wake_on_match: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionView {
    pub subscription_id: String,
    pub kind: String,
    pub selector: String,
    pub wake_on_match: bool,
    pub status: String,
    pub subject: String,
    pub created_at: String,
}

fn view(r: &sqlx::sqlite::SqliteRow) -> SubscriptionView {
    SubscriptionView {
        subscription_id: scol(r, "subscription_id"),
        kind: scol(r, "kind"),
        selector: scol(r, "selector"),
        wake_on_match: icol(r, "wake") != 0,
        status: scol(r, "status"),
        subject: subjects::subscription(&scol(r, "subscription_id")),
        created_at: scol(r, "created_at"),
    }
}

impl Domain {
    pub async fn create_subscription(&self, ctx: &Ctx, req: CreateSubscription) -> Result<SubscriptionView, Error> {
        self.run(ctx, "subscription.create", async {
            let kind = req.kind.clone().ok_or_else(|| Error::invalid("kind is required"))?;
            let selector = req.selector.clone().filter(|s| !s.is_empty()).ok_or_else(|| Error::invalid("selector is required"))?;
            let wake = req.wake_on_match.ok_or_else(|| Error::new(ErrorCode::ValidationFailed, "wakeOnMatch must be stated explicitly (true or false); subscriptions have no implicit wake behaviour"))?;
            if !matches!(kind.as_str(), "topic" | "capability_queue" | "conversation" | "task") {
                return Err(Error::invalid("kind must be topic, capability_queue, conversation or task"));
            }
            let this = self.clone();
            let ctx = ctx.clone();
            self.write(move |tx| {
                Box::pin(async move {
                    let conn = &mut **tx;
                    let action = if kind == "task" || kind == "capability_queue" { Action::TaskRead } else { Action::MessageRead };
                    let decision = this.enforce(conn, &ctx, AuthzRequest::action(action).resource(format!("{kind}://{selector}"))).await?;
                    match kind.as_str() {
                        "conversation" => {
                            if !this.is_member(conn, &selector, &ctx.actor.principal_id).await? {
                                return Err(Error::not_found("conversation"));
                            }
                        }
                        "task" => {
                            this.require_task_participant(conn, &ctx, &selector).await?;
                        }
                        "capability_queue" => {
                            if ctx.actor.kind != ActorKind::Agent {
                                return Err(Error::denied("only agents subscribe to capability queues"));
                            }
                            let offers: Option<i64> = sqlx::query_scalar("SELECT 1 FROM agent_capabilities WHERE agent_id = ? AND (capability_id = ? OR ? LIKE REPLACE(capability_id, '*', '%'))").bind(&ctx.actor.id).bind(&selector).bind(&selector).fetch_optional(&mut *conn).await.db()?;
                            if offers.is_none() {
                                return Err(Error::denied("the agent does not offer that capability"));
                            }
                        }
                        _ => {}
                    }
                    let id = ids::subscription_id();
                    sqlx::query("INSERT INTO subscriptions(subscription_id, domain_id, principal_id, kind, selector, wake, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'active', ?)")
                        .bind(&id)
                        .bind(&this.cfg.domain_id)
                        .bind(&ctx.actor.principal_id)
                        .bind(&kind)
                        .bind(&selector)
                        .bind(wake as i64)
                        .bind(this.now_ts())
                        .execute(&mut *conn)
                        .await
                        .db()?;
                    this.audit(conn, &ctx, AuditRecord::new("subscription.create", Some(format!("subscription://{id}")), "success").decision(&decision).detail(json!({"kind": kind, "selector": selector, "wakeOnMatch": wake}))).await?;
                    let row = sqlx::query("SELECT * FROM subscriptions WHERE subscription_id = ?").bind(&id).fetch_one(&mut *conn).await.db()?;
                    Ok(view(&row))
                })
            })
            .await
        })
        .await
    }

    pub async fn delete_subscription(&self, ctx: &Ctx, subscription_id: &str) -> Result<(), Error> {
        self.run(ctx, "subscription.delete", async {
            let res =
                sqlx::query("UPDATE subscriptions SET status = 'deleted', deleted_at = ? WHERE subscription_id = ? AND principal_id = ? AND status = 'active'")
                    .bind(self.now_ts())
                    .bind(subscription_id)
                    .bind(&ctx.actor.principal_id)
                    .execute(self.db.writer())
                    .await
                    .db()?;
            if res.rows_affected() == 0 {
                return Err(Error::not_found("subscription"));
            }
            Ok(())
        })
        .await
    }

    pub async fn list_subscriptions(&self, ctx: &Ctx) -> Result<Vec<SubscriptionView>, Error> {
        let rows = sqlx::query("SELECT * FROM subscriptions WHERE principal_id = ? AND status = 'active' ORDER BY created_at")
            .bind(&ctx.actor.principal_id)
            .fetch_all(self.db.pool())
            .await
            .db()?;
        Ok(rows.iter().map(view).collect())
    }
}

use serde_json::{Value, json};
use somework_core::Error;

use crate::{
    db::{DbResultExt, icol, scol_opt},
    domain::{Ctx, Domain},
    policy::AuthzRequest,
};

impl Domain {
    /// Compact conversation overview (member list, counts, last activity) exposed as an MCP resource.
    pub async fn conversation_summary(&self, ctx: &Ctx, conversation_id: &str) -> Result<Value, Error> {
        self.enforce_read(ctx, AuthzRequest::action(somework_core::contracts::Action::MessageRead).resource(format!("conversation://{conversation_id}")))
            .await?;
        let mut conn = self.db.pool().acquire().await.db()?;
        if !self.is_member(&mut conn, conversation_id, &ctx.actor.principal_id).await? && !ctx.actor.permissions.allows_action("message.read.any") {
            return Err(Error::not_found("conversation"));
        }
        let view = self.conversation_view(&mut conn, conversation_id).await?;
        let row = sqlx::query("SELECT COUNT(*) AS n, MAX(created_at) AS last FROM messages WHERE conversation_id = ?")
            .bind(conversation_id)
            .fetch_one(&mut *conn)
            .await
            .db()?;
        let tasks: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM tasks WHERE conversation_id = ?").bind(conversation_id).fetch_one(&mut *conn).await.db()?;
        Ok(json!({
            "conversationId": view.conversation_id,
            "kind": view.kind,
            "title": view.title,
            "classification": view.classification,
            "members": view.members,
            "messageCount": icol(&row, "n"),
            "lastMessageAt": scol_opt(&row, "last"),
            "taskCount": tasks,
            "createdAt": view.created_at,
        }))
    }
}

impl Domain {
    /// Conversations the caller is a member of, newest first.
    pub async fn list_conversations(&self, ctx: &Ctx, include_open: bool) -> Result<Vec<crate::messages::ConversationView>, Error> {
        self.enforce_read(ctx, AuthzRequest::action(somework_core::contracts::Action::MessageRead)).await?;
        let mut conn = self.db.pool().acquire().await.db()?;
        let ids: Vec<String> = sqlx::query_scalar(
            "SELECT c.conversation_id FROM conversations c WHERE c.kind <> 'task' AND (EXISTS (SELECT 1 FROM conversation_members m WHERE m.conversation_id = c.conversation_id AND m.principal_id = ?)
               OR (? = 1 AND c.kind = 'room' AND json_extract(c.metadata, '$.open') = 1)) ORDER BY c.created_at DESC LIMIT 200",
        )
            .bind(&ctx.actor.principal_id)
            .bind(include_open as i64)
            .fetch_all(&mut *conn)
            .await
            .db()?;
        let mut out = Vec::new();
        for id in ids {
            out.push(self.conversation_view(&mut conn, &id).await?);
        }
        Ok(out)
    }

    /// Joins an open room (a channel) the caller is cleared for.
    pub async fn join_conversation(&self, ctx: &Ctx, conversation_id: &str) -> Result<crate::messages::ConversationView, Error> {
        self.run(ctx, "conversation.join", async {
            let this = self.clone();
            let ctx = ctx.clone();
            let conversation_id = conversation_id.to_string();
            self.write(move |tx| {
                Box::pin(async move {
                    let conn = &mut **tx;
                    let row = sqlx::query("SELECT kind, classification, metadata FROM conversations WHERE conversation_id = ?")
                        .bind(&conversation_id)
                        .fetch_optional(&mut *conn)
                        .await
                        .db()?
                        .ok_or_else(|| Error::not_found("conversation"))?;
                    let open = crate::db::jcol(&row, "metadata")["open"].as_bool().unwrap_or(false);
                    if !open || crate::db::scol(&row, "kind") != "room" {
                        return Err(Error::not_found("conversation"));
                    }
                    let classification = crate::db::scol(&row, "classification");
                    this.enforce(
                        conn,
                        &ctx,
                        AuthzRequest::action(somework_core::contracts::Action::MessageSend)
                            .classification(&classification)
                            .resource(format!("conversation://{conversation_id}")),
                    )
                    .await?;
                    this.add_member(conn, &conversation_id, &ctx.actor.principal_id, "member").await?;
                    this.audit(
                        conn,
                        &ctx,
                        crate::audit::AuditRecord::new("conversation.join", Some(format!("conversation://{conversation_id}")), "success")
                            .conversation(Some(conversation_id.clone())),
                    )
                    .await?;
                    this.conversation_view(conn, &conversation_id).await
                })
            })
            .await
        })
        .await
    }

    pub async fn leave_conversation(&self, ctx: &Ctx, conversation_id: &str) -> Result<(), Error> {
        let res = sqlx::query("DELETE FROM conversation_members WHERE conversation_id = ? AND principal_id = ? AND role <> 'owner'")
            .bind(conversation_id)
            .bind(&ctx.actor.principal_id)
            .execute(self.db.writer())
            .await
            .db()?;
        if res.rows_affected() == 0 {
            return Err(Error::not_found("membership"));
        }
        Ok(())
    }
}

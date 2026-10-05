use axum::{
    Router,
    extract::{Path, Query, State},
    routing::{get, post},
};
use serde::Deserialize;
use serde_json::json;
use somework_domain::messages::{CreateConversation, MemberRef, SendMessage};

use crate::{http::*, state::AppState};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/v1/messages", post(send))
        .route("/v1/messages/read", post(mark_read))
        .route("/v1/messages/{id}", get(get_message))
        .route("/v1/conversations", post(create_conversation).get(list_conversations))
        .route("/v1/conversations/{id}/join", post(join_conversation))
        .route("/v1/conversations/{id}/leave", post(leave_conversation))
        .route("/v1/conversations/{id}", get(get_conversation))
        .route("/v1/conversations/{id}/members", post(add_member))
        .route("/v1/conversations/{id}/messages", get(list_messages))
        .route("/v1/conversations/{id}/summary", get(summary))
        .route("/v1/inbox", get(inbox))
}

async fn send(State(s): State<AppState>, Auth(ctx): Auth, Body(req): Body<SendMessage>) -> ApiResult {
    created(s.domain.send_message(&ctx, req).await?)
}

async fn get_message(State(s): State<AppState>, Auth(ctx): Auth, Path(id): Path<String>) -> ApiResult {
    ok(s.domain.get_message(&ctx, &id).await?)
}

async fn create_conversation(State(s): State<AppState>, Auth(ctx): Auth, Body(req): Body<CreateConversation>) -> ApiResult {
    created(s.domain.create_conversation(&ctx, req).await?)
}

async fn get_conversation(State(s): State<AppState>, Auth(ctx): Auth, Path(id): Path<String>) -> ApiResult {
    ok(s.domain.get_conversation(&ctx, &id).await?)
}

async fn add_member(State(s): State<AppState>, Auth(ctx): Auth, Path(id): Path<String>, Body(member): Body<MemberRef>) -> ApiResult {
    ok(s.domain.add_conversation_member(&ctx, &id, member).await?)
}

#[derive(Deserialize)]
struct PageQuery {
    cursor: Option<i64>,
    limit: Option<i64>,
}

async fn list_messages(State(s): State<AppState>, Auth(ctx): Auth, Path(id): Path<String>, Query(q): Query<PageQuery>) -> ApiResult {
    ok(s.domain.list_messages(&ctx, &id, q.cursor.unwrap_or(0), q.limit.unwrap_or(50)).await?)
}

#[derive(Deserialize)]
struct InboxQuery {
    unread: Option<bool>,
    limit: Option<i64>,
}

async fn inbox(State(s): State<AppState>, Auth(ctx): Auth, Query(q): Query<InboxQuery>) -> ApiResult {
    ok(json!({"messages": s.domain.inbox(&ctx, q.unread.unwrap_or(false), q.limit.unwrap_or(100)).await?}))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReadBody {
    message_ids: Vec<String>,
}

async fn mark_read(State(s): State<AppState>, Auth(ctx): Auth, Body(body): Body<ReadBody>) -> ApiResult {
    ok(json!({"updated": s.domain.mark_messages_read(&ctx, &body.message_ids).await?}))
}

async fn summary(State(s): State<AppState>, Auth(ctx): Auth, Path(id): Path<String>) -> ApiResult {
    ok(s.domain.conversation_summary(&ctx, &id).await?)
}

#[derive(Deserialize)]
struct ListQuery {
    /// Also list open rooms (channels) the caller has not joined yet.
    open: Option<bool>,
}

async fn list_conversations(State(s): State<AppState>, Auth(ctx): Auth, Query(q): Query<ListQuery>) -> ApiResult {
    ok(json!({"conversations": s.domain.list_conversations(&ctx, q.open.unwrap_or(false)).await?}))
}

async fn join_conversation(State(s): State<AppState>, Auth(ctx): Auth, Path(id): Path<String>) -> ApiResult {
    ok(s.domain.join_conversation(&ctx, &id).await?)
}

async fn leave_conversation(State(s): State<AppState>, Auth(ctx): Auth, Path(id): Path<String>) -> ApiResult {
    s.domain.leave_conversation(&ctx, &id).await?;
    no_content()
}

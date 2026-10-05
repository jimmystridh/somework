use std::{convert::Infallible, time::Duration};

use axum::{
    Router,
    extract::{Path, Query, State},
    http::header,
    response::{
        IntoResponse,
        sse::{Event, KeepAlive, Sse},
    },
    routing::{delete, get, post},
};
use serde::Deserialize;
use serde_json::json;
use somework_domain::subscriptions::CreateSubscription;

use crate::{http::*, state::AppState};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/v1/events", get(events))
        .route("/v1/events/ack", post(ack))
        .route("/v1/subscriptions", post(create_subscription).get(list_subscriptions))
        .route("/v1/subscriptions/{id}", delete(delete_subscription))
}

#[derive(Deserialize)]
struct EventsQuery {
    after: Option<i64>,
    limit: Option<i64>,
    wait: Option<u64>,
}

/// `GET /v1/events`: cursor-based long-poll, or an SSE stream when the client asks for `text/event-stream`.
async fn events(
    State(s): State<AppState>,
    Auth(ctx): Auth,
    headers: axum::http::HeaderMap,
    Query(q): Query<EventsQuery>,
) -> Result<axum::response::Response, ApiError> {
    let after = match q.after {
        Some(a) => a,
        None => s.domain.event_cursor(&ctx).await?,
    };
    let wants_sse = headers.get(header::ACCEPT).and_then(|v| v.to_str().ok()).is_some_and(|v| v.contains("text/event-stream"));
    if wants_sse {
        let domain = s.domain.clone();
        let stream = async_stream::stream! {
            let mut cursor = after;
            loop {
                match domain.watch_events(&ctx, cursor, 100, Duration::from_secs(20)).await {
                    Ok(events) => {
                        for e in events {
                            cursor = cursor.max(e.seq);
                            yield Ok::<_, Infallible>(Event::default().id(e.seq.to_string()).event(e.kind.clone()).json_data(&e).unwrap_or_default());
                        }
                    }
                    Err(err) => {
                        yield Ok(Event::default().event("error").data(err.to_string()));
                        break;
                    }
                }
            }
        };
        return Ok(Sse::new(stream).keep_alive(KeepAlive::default()).into_response());
    }
    let events = s.domain.watch_events(&ctx, after, q.limit.unwrap_or(100), Duration::from_secs(q.wait.unwrap_or(0).min(30))).await?;
    let cursor = events.last().map(|e| e.seq).unwrap_or(after);
    ok(json!({"events": events, "cursor": cursor}))
}

#[derive(Deserialize)]
struct AckBody {
    cursor: i64,
}

async fn ack(State(s): State<AppState>, Auth(ctx): Auth, Body(b): Body<AckBody>) -> ApiResult {
    s.domain.ack_events(&ctx, b.cursor).await?;
    ok(json!({"cursor": b.cursor}))
}

async fn create_subscription(State(s): State<AppState>, Auth(ctx): Auth, Body(req): Body<CreateSubscription>) -> ApiResult {
    created(s.domain.create_subscription(&ctx, req).await?)
}

async fn list_subscriptions(State(s): State<AppState>, Auth(ctx): Auth) -> ApiResult {
    ok(json!({"subscriptions": s.domain.list_subscriptions(&ctx).await?}))
}

async fn delete_subscription(State(s): State<AppState>, Auth(ctx): Auth, Path(id): Path<String>) -> ApiResult {
    s.domain.delete_subscription(&ctx, &id).await?;
    no_content()
}

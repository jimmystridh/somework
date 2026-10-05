//! Inbound ingestion: Application Service transactions from the homeserver become canonical domain calls made *as
//! the mapped human principal*. The bridge never authorizes anything itself (least privilege): policy decisions,
//! idempotency and audit all happen in the domain service.

use std::sync::Arc;

use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, put},
};
use serde::Deserialize;
use serde_json::{Value, json};
use somework_core::{Error, ErrorCode, contracts::*};
use somework_domain::{
    Ctx,
    audit::AuditRecord,
    catalog::SearchRequest,
    messages::{MemberRef, SendMessage},
    tasks::{CancelRequest, DecideApproval, InputRequest, SubmitTask},
    transport::Mapping,
};

use crate::bridge::*;

type Shared = Arc<Bridge>;

pub fn router(bridge: Arc<Bridge>) -> Router {
    Router::new()
        .route("/_matrix/app/v1/transactions/{txn}", put(transaction))
        .route("/_matrix/app/v1/users/{user}", get(user_query))
        .route("/_matrix/app/v1/rooms/{alias}", get(room_query))
        .route("/transactions/{txn}", put(transaction))
        .route("/users/{user}", get(user_query))
        .route("/rooms/{alias}", get(room_query))
        .with_state(bridge)
}

fn matrix_error(status: StatusCode, errcode: &str, message: &str) -> Response {
    (status, Json(json!({"errcode": errcode, "error": message}))).into_response()
}

#[derive(Deserialize)]
struct TokenQuery {
    access_token: Option<String>,
}

fn authorize(b: &Bridge, headers: &HeaderMap, q: &TokenQuery) -> Result<(), Response> {
    let presented =
        headers.get("authorization").and_then(|v| v.to_str().ok()).and_then(|v| v.strip_prefix("Bearer ")).map(String::from).or_else(|| q.access_token.clone());
    match presented {
        None => Err(matrix_error(StatusCode::UNAUTHORIZED, "M_MISSING_TOKEN", "missing homeserver token")),
        Some(t) if b.tokens.hs_token_matches(&t) => Ok(()),
        Some(_) => Err(matrix_error(StatusCode::FORBIDDEN, "M_FORBIDDEN", "invalid homeserver token")),
    }
}

async fn transaction(State(b): State<Shared>, Path(txn): Path<String>, Query(q): Query<TokenQuery>, headers: HeaderMap, Json(body): Json<Value>) -> Response {
    if let Err(r) = authorize(&b, &headers, &q) {
        return r;
    }
    let txn_key = format!("txn:{txn}");
    match b.domain.mapping_by_external(TRANSPORT, &txn_key).await {
        Ok(Some(_)) => return Json(json!({})).into_response(),
        Ok(None) => {}
        Err(e) => return matrix_error(StatusCode::INTERNAL_SERVER_ERROR, "M_UNKNOWN", &e.message),
    }
    // End-to-end encryption side channels (MSC2409/MSC3202): to-device events carry room keys and must be processed
    // before the events in the same transaction, otherwise their ciphertexts would look undecryptable.
    if let Some(crypto) = &b.crypto {
        let to_device: Vec<Value> =
            ["de.sorunome.msc2409.to_device", "org.matrix.msc2409.to_device"].iter().flat_map(|k| body[k].as_array().cloned().unwrap_or_default()).collect();
        for (room, session) in crypto.handle_to_device(&to_device).await {
            for parked in crypto.take_parked(&room, &session).await.unwrap_or_default() {
                if let Err(e) = process_event(&b, &parked).await {
                    tracing::warn!(error = %e, "retrying a parked encrypted event failed");
                }
            }
        }
        for key in ["org.matrix.msc3202.device_one_time_key_counts", "device_one_time_keys_count"] {
            if body[key].is_object() {
                crypto.handle_otk_counts(&body[key]).await;
            }
        }
        let changed: Vec<String> = body["org.matrix.msc3202.device_lists"]["changed"]
            .as_array()
            .into_iter()
            .flatten()
            .chain(body["device_lists"]["changed"].as_array().into_iter().flatten())
            .filter_map(|v| v.as_str().map(String::from))
            .collect();
        if !changed.is_empty() {
            crypto.invalidate_devices(&changed).await;
        }
    }
    for event in body["events"].as_array().cloned().unwrap_or_default() {
        if let Err(e) = process_event(&b, &event).await {
            b.domain.metrics.matrix_ingest_errors.inc();
            tracing::warn!(error = %e, event_id = %event["event_id"], "matrix event ingestion failed");
            // the homeserver retries the whole transaction; event-id dedupe and idempotency keys make that safe
            return matrix_error(StatusCode::INTERNAL_SERVER_ERROR, "M_UNKNOWN", &e.message);
        }
    }
    let _ = b.domain.put_mapping(&Mapping::new(TRANSPORT, txn_key, "txn", txn, json!({}))).await;
    Json(json!({})).into_response()
}

async fn user_query(State(b): State<Shared>, Path(user): Path<String>, Query(q): Query<TokenQuery>, headers: HeaderMap) -> Response {
    if let Err(r) = authorize(&b, &headers, &q) {
        return r;
    }
    if let Some(agent) = b.cfg.agent_id_from_user(&user)
        && b.domain.agent_exists(&agent).await.unwrap_or(false)
        && b.ensure_virtual_user(&agent).await.is_ok()
    {
        return Json(json!({})).into_response();
    }
    matrix_error(StatusCode::NOT_FOUND, "M_NOT_FOUND", "no such user")
}

async fn room_query(State(b): State<Shared>, Path(alias): Path<String>, Query(q): Query<TokenQuery>, headers: HeaderMap) -> Response {
    if let Err(r) = authorize(&b, &headers, &q) {
        return r;
    }
    let _ = alias;
    matrix_error(StatusCode::NOT_FOUND, "M_NOT_FOUND", "room aliases are created by the bridge on demand")
}

async fn process_event(b: &Bridge, ev: &Value) -> Result<(), Error> {
    let event_id = ev["event_id"].as_str().unwrap_or_default();
    let sender = ev["sender"].as_str().unwrap_or_default();
    if event_id.is_empty() || b.cfg.is_virtual_user(sender) || b.cfg.is_bot(sender) {
        return Ok(()); // own-origin events are never processed (loop protection)
    }
    if b.domain.mapping_by_external(TRANSPORT, event_id).await?.is_some() {
        return Ok(()); // duplicate delivery
    }
    if let Some(ts) = ev["origin_server_ts"].as_i64() {
        let age = b.domain.now().timestamp_millis() - ts;
        if age > b.cfg.ignore_events_older_than_secs * 1000 {
            return Ok(());
        }
    }
    match ev["type"].as_str().unwrap_or_default() {
        "m.room.message" => on_message(b, ev).await,
        "m.reaction" => on_reaction(b, ev).await,
        "m.room.encrypted" => on_encrypted(b, ev).await,
        _ => Ok(()),
    }
}

/// Encrypted events: only the observer profile holds a device that can read them. Everything decrypted flows through
/// the same dispatch as plaintext events (mapping, mention gating, commands, approvals); everything else is counted
/// as undecryptable and never executes anything.
async fn on_encrypted(b: &Bridge, ev: &Value) -> Result<(), Error> {
    use crate::crypto::DecryptError;
    let Some(crypto) = &b.crypto else {
        b.domain.metrics.matrix_undecryptable_events.inc();
        return Ok(()); // metadata-only profile: the platform deliberately cannot read this
    };
    match crypto.decrypt_room_event(ev).await {
        Ok(plain) => {
            let event_id = ev["event_id"].as_str().unwrap_or_default();
            let sender = ev["sender"].as_str().unwrap_or_default();
            let mapped = b.domain.principal_for_matrix_user(sender).await?.is_some();
            let policy = b.domain.get_policy(&b.ctx()).await?;
            // permitted audit projection of what the observer device read: metadata and digests, plaintext only when the
            // domain policy retains it and the sender is a mapped principal
            let mut detail = json!({"eventId": event_id, "roomId": ev["room_id"], "sender": sender, "type": plain.event_type, "senderDevice": plain.sender_device, "contentDigest": somework_core::canonical::digest_json(&plain.content)});
            if policy.audit_plaintext && mapped {
                detail["content"] = plain.content.clone();
            }
            b.domain
                .record_audit(
                    &b.ctx().with_transport_event(event_id),
                    AuditRecord::new("matrix.observer.decrypted", Some(format!("matrix://{event_id}")), "success").detail(detail),
                )
                .await?;
            let mut decrypted = ev.clone();
            decrypted["type"] = json!(plain.event_type);
            decrypted["content"] = plain.content;
            match plain.event_type.as_str() {
                "m.room.message" => on_message(b, &decrypted).await,
                "m.reaction" => on_reaction(b, &decrypted).await,
                _ => Ok(()),
            }
        }
        Err(DecryptError::UnknownSession(session)) => {
            // the room key may still be in flight: park the ciphertext (never plaintext) until it arrives
            crypto.park_event(&session, ev).await?;
            Ok(())
        }
        Err(e) => {
            b.domain.metrics.matrix_undecryptable_events.inc();
            b.domain.metrics.matrix_ingest_errors.inc();
            tracing::warn!(error = %e, event_id = %ev["event_id"], "rejected an encrypted event");
            let ctx = b.ctx().with_transport_event(ev["event_id"].as_str().unwrap_or_default());
            let _ = b
                .domain
                .record_audit(
                    &ctx,
                    AuditRecord::new("matrix.observer.rejected", Some(format!("matrix://{}", ev["event_id"].as_str().unwrap_or_default())), "denied")
                        .detail(json!({"sender": ev["sender"], "roomId": ev["room_id"], "reason": e.to_string()})),
                )
                .await;
            let _ = b.domain.put_mapping(&Mapping::new(TRANSPORT, ev["event_id"].as_str().unwrap_or_default(), "ignored", "undecryptable", json!({}))).await;
            Ok(())
        }
    }
}

async fn identify(b: &Bridge, ev: &Value) -> Result<Option<Ctx>, Error> {
    let sender = ev["sender"].as_str().unwrap_or_default();
    let event_id = ev["event_id"].as_str().unwrap_or_default();
    match b.domain.principal_for_matrix_user(sender).await? {
        Some(p) => {
            let actor = b.domain.actor_for_principal(&p, None).await;
            Ok(Some(Ctx::new(actor).with_transport(TRANSPORT).with_transport_event(event_id).with_idempotency(format!("matrix:{event_id}"))))
        }
        None => {
            let ctx = b.ctx().with_transport_event(event_id);
            b.domain
                .record_audit(
                    &ctx,
                    AuditRecord::new("matrix.ingest.unmapped_sender", Some(format!("matrix://{sender}")), "ignored")
                        .detail(json!({"sender": sender, "roomId": ev["room_id"], "eventId": event_id})),
                )
                .await?;
            b.domain.put_mapping(&Mapping::new(TRANSPORT, event_id, "ignored", "unmapped_sender", json!({}))).await?;
            Ok(None)
        }
    }
}

async fn reply(b: &Bridge, room: &str, event_id: &str, thread: Option<&str>, text: &str) {
    if let Err(e) = b.notice(room, &format!("reply:{event_id}"), text, thread, None).await {
        tracing::warn!(error = %e, "failed to post bridge reply");
    }
}

pub fn extract_agent_mentions(cfg: &crate::config::MatrixConfig, text: &str) -> Vec<String> {
    let needle = format!("@{}", cfg.agent_prefix);
    let mut out = vec![];
    let mut rest = text;
    while let Some(pos) = rest.find(&needle) {
        let tail = &rest[pos..];
        let end = tail[1..]
            .find(|c: char| !(c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '_' | '-' | '=' | ':' | '/') || c.is_ascii_uppercase()))
            .map(|i| i + 1)
            .unwrap_or(tail.len());
        let candidate = tail[..end].trim_end_matches([':', '.', '-']).to_string();
        if let Some(agent) = cfg.agent_id_from_user(&candidate).or_else(|| cfg.agent_id_from_user(&format!("{candidate}:{}", cfg.server_name)))
            && !out.contains(&agent)
        {
            out.push(agent);
        }
        rest = &tail[end.max(1)..];
    }
    out
}

async fn mentions_of(b: &Bridge, content: &Value) -> Vec<String> {
    let mut agents = vec![];
    let mut push = |a: String| {
        if !agents.contains(&a) {
            agents.push(a);
        }
    };
    for u in content["m.mentions"]["user_ids"].as_array().cloned().unwrap_or_default() {
        if let Some(a) = u.as_str().and_then(|u| b.cfg.agent_id_from_user(u)) {
            push(a);
        }
    }
    for field in ["body", "formatted_body"] {
        if let Some(t) = content[field].as_str() {
            for a in extract_agent_mentions(&b.cfg, t) {
                push(a);
            }
        }
    }
    let mut existing = vec![];
    for a in agents {
        if b.domain.agent_exists(&a).await.unwrap_or(false) {
            existing.push(a);
        }
    }
    existing
}

async fn on_message(b: &Bridge, ev: &Value) -> Result<(), Error> {
    let content = &ev["content"];
    if content["msgtype"].as_str() == Some("m.notice") || content["m.relates_to"]["rel_type"].as_str() == Some("m.replace") {
        return Ok(());
    }
    let room = ev["room_id"].as_str().unwrap_or_default();
    let event_id = ev["event_id"].as_str().unwrap_or_default();
    let Some(conversation_id) = b.conversation_for_room(room).await? else { return Ok(()) };
    let Some(ctx) = identify(b, ev).await? else { return Ok(()) };
    let body = content["body"].as_str().unwrap_or_default().trim().to_string();
    let thread_root =
        (content["m.relates_to"]["rel_type"].as_str() == Some("m.thread")).then(|| content["m.relates_to"]["event_id"].as_str()).flatten().map(String::from);
    let task_id = match &thread_root {
        Some(root) => b.domain.mapping_by_external(TRANSPORT, root).await?.filter(|m| m.object_kind == "task").map(|m| m.object_id),
        None => None,
    };

    if let Some(command) = body.strip_prefix('!') {
        let outcome = run_command(b, &ctx, &conversation_id, task_id.as_deref(), command).await;
        let text = match outcome {
            Ok(text) => text,
            Err(e) if e.code == ErrorCode::PolicyDenied => format!("Denied by policy: {}", e.message),
            Err(e) => format!("Command failed: {}", e.message),
        };
        reply(b, room, event_id, thread_root.as_deref(), &text).await;
        b.domain.put_mapping(&Mapping::new(TRANSPORT, event_id, "command", event_id, json!({"roomId": room}))).await?;
        return Ok(());
    }

    let agents = mentions_of(b, content).await;
    let req = SendMessage {
        kind: Some(MessageType::ChatMessage),
        conversation_id: Some(conversation_id),
        task_id,
        recipients: agents.iter().map(|a| MemberRef { kind: ActorKind::Agent, id: a.clone() }).collect(),
        content: Some(MessageContent { media_type: "text/plain".into(), data: json!(body) }),
        trigger_mode: Some(if agents.is_empty() { TriggerMode::Never } else { TriggerMode::Directed }),
        labels: [("transport".to_string(), "matrix".to_string())].into(),
        idempotency_key: Some(format!("matrix:{event_id}")),
        ..Default::default()
    };
    match b.domain.send_message(&ctx, req).await {
        Ok(record) => {
            b.domain.put_mapping(&Mapping::new(TRANSPORT, event_id, "message", record.envelope.message_id, json!({"roomId": room}))).await?;
        }
        Err(e) if matches!(e.code, ErrorCode::Unavailable | ErrorCode::Internal) => return Err(e),
        Err(e) => {
            reply(b, room, event_id, thread_root.as_deref(), &format!("Message not delivered: {}", e.message)).await;
            b.domain.put_mapping(&Mapping::new(TRANSPORT, event_id, "rejected", event_id, json!({}))).await?;
        }
    }
    Ok(())
}

async fn run_command(b: &Bridge, ctx: &Ctx, conversation_id: &str, task_id: Option<&str>, command: &str) -> Result<String, Error> {
    let (name, rest) = command.split_once(char::is_whitespace).map(|(n, r)| (n, r.trim())).unwrap_or((command, ""));
    match name {
        "task" => {
            let (head, json_part) = rest.split_once('{').map(|(h, j)| (h.trim(), format!("{{{j}"))).unwrap_or((rest, "{}".into()));
            let mut capability = None;
            let mut target = None;
            for token in head.split_whitespace() {
                match token.strip_prefix("to=") {
                    Some(agent) => target = Some(agent.to_string()),
                    None => capability = Some(token.to_string()),
                }
            }
            let capability = capability.ok_or_else(|| Error::invalid("usage: !task <capability>[@version] [to=<agent>] {json input}"))?;
            let input: Value = serde_json::from_str(&json_part).map_err(|e| Error::invalid(format!("input is not valid JSON: {e}")))?;
            let (cap_id, version) = match capability.split_once('@') {
                Some((id, v)) => (id.to_string(), v.to_string()),
                None => {
                    let found = b
                        .domain
                        .search_catalog(ctx, SearchRequest { required_capabilities: vec![capability.clone()], limit: Some(1), ..Default::default() })
                        .await?;
                    let m = found.matches.first().and_then(|m| m.matched_capabilities.first().cloned()).ok_or_else(|| Error::not_found("capability"))?;
                    (m.id, m.version)
                }
            };
            let resp = b
                .domain
                .submit_task(
                    ctx,
                    SubmitTask {
                        capability: Some(CapabilityRef { id: cap_id, version }),
                        target_agent_id: target,
                        conversation_id: Some(conversation_id.to_string()),
                        input: Some(input),
                        ..Default::default()
                    },
                )
                .await?;
            Ok(format!("Task {} submitted ({})", resp.task.task.task_id, resp.task.task.state))
        }
        "approve" | "deny" => {
            let approval_id = rest.split_whitespace().next().ok_or_else(|| Error::invalid("usage: !approve <approvalId>"))?;
            decide(b, ctx, approval_id, name == "approve").await
        }
        "input" => {
            let task_id = task_id.ok_or_else(|| Error::invalid("!input must be sent inside the task thread"))?;
            let data = serde_json::from_str(rest).unwrap_or_else(|_| json!({"text": rest}));
            let view = b.domain.provide_input(ctx, task_id, InputRequest { data, expected_revision: None }).await?;
            Ok(format!("Input accepted; task is {}", view.task.state))
        }
        "cancel" => {
            let task_id = task_id.ok_or_else(|| Error::invalid("!cancel must be sent inside the task thread"))?;
            let view = b.domain.cancel_task(ctx, task_id, CancelRequest { reason: Some("requested from Matrix".into()), ..Default::default() }).await?;
            Ok(format!("Task is {}", view.task.state))
        }
        other => Err(Error::invalid(format!("unknown command !{other} (try !task, !approve, !deny, !input, !cancel)"))),
    }
}

/// Uses the digest and revision stored when the approval request was projected, never the *current* ones, so a
/// reaction to a stale prompt is refused by the domain.
async fn decide(b: &Bridge, ctx: &Ctx, approval_id: &str, approve: bool) -> Result<String, Error> {
    let mapping = b.domain.mapping_by_object(TRANSPORT, "approval", approval_id).await?.ok_or_else(|| Error::not_found("approval prompt"))?;
    let view = b
        .domain
        .decide_approval(
            ctx,
            approval_id,
            DecideApproval {
                decision: if approve { "approved" } else { "denied" }.into(),
                action_digest: mapping.data["actionDigest"].as_str().unwrap_or_default().into(),
                task_revision: mapping.data["taskRevision"].as_u64().unwrap_or_default(),
                comment: Some("via Matrix".into()),
            },
        )
        .await?;
    Ok(format!("Approval {approval_id} {}; task is {}", if approve { "granted" } else { "denied" }, view.task.state))
}

async fn on_reaction(b: &Bridge, ev: &Value) -> Result<(), Error> {
    let event_id = ev["event_id"].as_str().unwrap_or_default();
    let rel = &ev["content"]["m.relates_to"];
    if rel["rel_type"].as_str() != Some("m.annotation") {
        return Ok(());
    }
    let (target, key) = (rel["event_id"].as_str().unwrap_or_default(), rel["key"].as_str().unwrap_or_default());
    let approve = match key.trim_end_matches('\u{fe0f}') {
        "👍" | "✅" | "+1" => true,
        "👎" | "❌" | "-1" => false,
        _ => return Ok(()),
    };
    let Some(prompt) = b.domain.mapping_by_external(TRANSPORT, target).await?.filter(|m| m.object_kind == "approval") else { return Ok(()) };
    let room = ev["room_id"].as_str().unwrap_or_default();
    if prompt.data["roomId"].as_str() != Some(room) {
        return Ok(());
    }
    let Some(ctx) = identify(b, ev).await? else { return Ok(()) };
    let text = match decide(b, &ctx, &prompt.object_id, approve).await {
        Ok(t) => t,
        Err(e) if e.code == ErrorCode::Unavailable => return Err(e),
        Err(e) => format!("Approval not applied: {} ({})", e.message, e.code.as_str()),
    };
    reply(b, room, event_id, None, &text).await;
    b.domain.put_mapping(&Mapping::new(TRANSPORT, event_id, "reaction", prompt.object_id, json!({"approved": approve}))).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::MatrixConfig;

    #[test]
    fn finds_agent_mentions_in_plain_and_pill_text() {
        let cfg = MatrixConfig::default();
        let user = cfg.agent_user_id("agent/reviewer");
        assert_eq!(extract_agent_mentions(&cfg, &format!("hey {user} please look")), ["agent/reviewer"]);
        assert_eq!(extract_agent_mentions(&cfg, &format!("<a href=\"https://matrix.to/#/{user}\">r</a>")), ["agent/reviewer"]);
        assert!(extract_agent_mentions(&cfg, "no mention @alice:localhost").is_empty());
    }
}

//! In-process Matrix homeserver double. It implements the subset of the client-server API the SomeWork bridge uses
//! (Application Service registration of virtual users, rooms/aliases, invites/joins, idempotent sends with txnId,
//! state, profile) and plays the homeserver role towards the bridge by pushing Application Service transactions.
//! It enforces the rules the bridge relies on: the AppService token, `user_id` masquerading only inside the
//! exclusive namespace, membership before sending, and txnId idempotency. Synapse itself cannot run here.

use std::{
    collections::{HashMap, HashSet},
    net::SocketAddr,
    sync::{Arc, Mutex},
    time::Duration,
};

use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post, put},
};
use serde_json::{Value, json};
use tokio::sync::mpsc;

#[derive(Debug, Clone)]
pub struct MxEvent {
    pub event_id: String,
    pub room_id: String,
    pub sender: String,
    pub kind: String,
    pub content: Value,
    pub state_key: Option<String>,
    pub origin_server_ts: i64,
}

impl MxEvent {
    pub fn to_json(&self) -> Value {
        let mut v = json!({"event_id": self.event_id, "room_id": self.room_id, "sender": self.sender, "type": self.kind, "content": self.content, "origin_server_ts": self.origin_server_ts});
        if let Some(k) = &self.state_key {
            v["state_key"] = json!(k);
        }
        v
    }

    pub fn body(&self) -> &str {
        self.content["body"].as_str().unwrap_or_default()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Membership {
    Invited,
    Joined,
}

#[derive(Default)]
struct Room {
    name: Option<String>,
    members: HashMap<String, Membership>,
    events: Vec<MxEvent>,
}

#[derive(Default)]
struct State_ {
    as_token: String,
    hs_token: String,
    as_url: Option<String>,
    ns_prefix: String,
    bot: String,
    users: HashMap<String, Option<String>>,
    rooms: HashMap<String, Room>,
    room_order: Vec<String>,
    aliases: HashMap<String, String>,
    txns: HashMap<(String, String, String), String>,
    counter: u64,
    outage: bool,
    echo: bool,
    /// End-to-end encryption: published device keys, one-time keys, fallback keys and queued to-device events.
    device_keys: HashMap<String, HashMap<String, Value>>,
    otks: HashMap<(String, String), Vec<(String, Value)>>,
    fallback: HashMap<(String, String), Value>,
    to_device: HashMap<(String, String), Vec<Value>>,
    td_txns: HashSet<(String, String, String)>,
}

/// What the homeserver pushes to the appservice in one transaction.
struct Push {
    events: Vec<Value>,
    to_device: Vec<Value>,
}

struct Inner {
    server_name: String,
    state: Mutex<State_>,
    push_tx: mpsc::UnboundedSender<Push>,
    http: reqwest::Client,
}

pub struct MockMatrix {
    inner: Arc<Inner>,
    pub url: String,
    pub server_name: String,
    handle: tokio::task::JoinHandle<()>,
}

type Reply = Response;

fn mx_err(status: StatusCode, errcode: &str, msg: &str) -> Reply {
    (status, Json(json!({"errcode": errcode, "error": msg}))).into_response()
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or_default()
}

impl Inner {
    fn st(&self) -> std::sync::MutexGuard<'_, State_> {
        self.state.lock().expect("mock matrix state")
    }

    /// Token + masquerade checks shared by every client-server endpoint. Returns the acting user id.
    fn authenticate(&self, headers: &HeaderMap, q: &HashMap<String, String>) -> Result<String, Reply> {
        let st = self.st();
        if st.outage {
            return Err(mx_err(StatusCode::SERVICE_UNAVAILABLE, "M_UNAVAILABLE", "homeserver is down"));
        }
        let token = headers
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .map(String::from)
            .or_else(|| q.get("access_token").cloned());
        if token.as_deref() != Some(st.as_token.as_str()) {
            return Err(mx_err(StatusCode::UNAUTHORIZED, "M_UNKNOWN_TOKEN", "unrecognised appservice token"));
        }
        match q.get("user_id") {
            None => Ok(st.bot.clone()),
            Some(u) if *u == st.bot || (u.starts_with(&format!("@{}", st.ns_prefix)) && u.ends_with(&format!(":{}", self.server_name))) => Ok(u.clone()),
            Some(_) => Err(mx_err(StatusCode::FORBIDDEN, "M_FORBIDDEN", "appservice may only act as users in its exclusive namespace")),
        }
    }

    fn mint_event(&self, st: &mut State_, room_id: &str, sender: &str, kind: &str, content: Value, state_key: Option<String>) -> MxEvent {
        st.counter += 1;
        let ev = MxEvent {
            event_id: format!("${}{}:{}", st.counter, rand_suffix(st.counter), self.server_name),
            room_id: room_id.into(),
            sender: sender.into(),
            kind: kind.into(),
            content,
            state_key,
            origin_server_ts: now_ms(),
        };
        if let Some(room) = st.rooms.get_mut(room_id) {
            room.events.push(ev.clone());
        }
        if st.as_url.is_some() && st.echo {
            let _ = self.push_tx.send(Push { events: vec![ev.to_json()], to_device: vec![] });
        }
        ev
    }
}

impl Inner {
    fn is_as_user(&self, st: &State_, user: &str) -> bool {
        user == st.bot || (!st.ns_prefix.is_empty() && user.starts_with(&format!("@{}", st.ns_prefix)))
    }

    /// One-time key counts of appservice-managed devices (MSC3202 `device_one_time_key_counts`).
    fn otk_counts(&self, st: &State_) -> Value {
        let mut out = serde_json::Map::new();
        for ((user, device), keys) in &st.otks {
            if self.is_as_user(st, user) {
                out.entry(user.clone()).or_insert_with(|| json!({}))[device] = json!({"signed_curve25519": keys.len()});
            }
        }
        Value::Object(out)
    }

    fn upload_keys(&self, user: &str, device: &str, body: &Value) -> Value {
        let mut st = self.st();
        if let Some(dk) = body.get("device_keys").filter(|v| v.is_object()) {
            st.device_keys.entry(user.to_string()).or_default().insert(device.to_string(), dk.clone());
        }
        let entry = st.otks.entry((user.to_string(), device.to_string())).or_default();
        for (id, key) in body["one_time_keys"].as_object().cloned().unwrap_or_default() {
            entry.push((id, key));
        }
        if let Some(fb) = body["fallback_keys"].as_object().and_then(|o| o.values().next().cloned()) {
            st.fallback.insert((user.to_string(), device.to_string()), fb);
        }
        let n = st.otks.get(&(user.to_string(), device.to_string())).map(Vec::len).unwrap_or(0);
        json!({"one_time_key_counts": {"signed_curve25519": n}})
    }

    fn query_keys_for(&self, users: &[String]) -> Value {
        let st = self.st();
        let mut out = serde_json::Map::new();
        for u in users {
            out.insert(u.clone(), json!(st.device_keys.get(u).cloned().unwrap_or_default()));
        }
        Value::Object(out)
    }

    fn claim_key(&self, user: &str, device: &str) -> Option<Value> {
        let mut st = self.st();
        let key = (user.to_string(), device.to_string());
        if let Some(list) = st.otks.get_mut(&key)
            && !list.is_empty()
        {
            let (id, k) = list.remove(0);
            return Some(json!({id: k}));
        }
        st.fallback.get(&key).cloned().map(|fb| json!({"signed_curve25519:fallback": fb}))
    }

    /// Delivers to-device events: appservice-managed devices get them pushed in a transaction, others queue them.
    fn deliver_to_device(&self, sender: &str, event_type: &str, messages: &Value) {
        let mut st = self.st();
        let mut pushed = vec![];
        for (user, devices) in messages.as_object().cloned().unwrap_or_default() {
            for (device, content) in devices.as_object().cloned().unwrap_or_default() {
                if self.is_as_user(&st, &user) {
                    pushed.push(json!({"type": event_type, "sender": sender, "content": content, "to_user_id": user, "to_device_id": device}));
                } else {
                    st.to_device.entry((user.clone(), device.clone())).or_default().push(json!({"type": event_type, "sender": sender, "content": content}));
                }
            }
        }
        if !pushed.is_empty() && st.as_url.is_some() {
            let _ = self.push_tx.send(Push { events: vec![], to_device: pushed });
        }
    }
}

fn rand_suffix(n: u64) -> String {
    format!("{:08x}", n.wrapping_mul(2654435761) as u32)
}

type Q = Query<HashMap<String, String>>;

async fn register(State(s): State<Arc<Inner>>, headers: HeaderMap, Query(q): Q, Json(body): Json<Value>) -> Reply {
    if let Err(r) = s.authenticate(&headers, &q) {
        return r;
    }
    let mut st = s.st();
    let user = format!("@{}:{}", body["username"].as_str().unwrap_or_default(), s.server_name);
    if !user.starts_with(&format!("@{}", st.ns_prefix)) {
        return mx_err(StatusCode::BAD_REQUEST, "M_EXCLUSIVE", "username is outside the appservice namespace");
    }
    if st.users.contains_key(&user) {
        return mx_err(StatusCode::BAD_REQUEST, "M_USER_IN_USE", "user exists");
    }
    st.users.insert(user.clone(), None);
    Json(json!({"user_id": user})).into_response()
}

async fn set_displayname(State(s): State<Arc<Inner>>, headers: HeaderMap, Path(user): Path<String>, Query(q): Q, Json(body): Json<Value>) -> Reply {
    if let Err(r) = s.authenticate(&headers, &q) {
        return r;
    }
    s.st().users.insert(user, body["displayname"].as_str().map(String::from));
    Json(json!({})).into_response()
}

async fn create_room(State(s): State<Arc<Inner>>, headers: HeaderMap, Query(q): Q, Json(body): Json<Value>) -> Reply {
    let creator = match s.authenticate(&headers, &q) {
        Ok(u) => u,
        Err(r) => return r,
    };
    let mut st = s.st();
    let alias = body["room_alias_name"].as_str().map(|a| format!("#{a}:{}", s.server_name));
    if let Some(a) = &alias
        && st.aliases.contains_key(a)
    {
        return mx_err(StatusCode::BAD_REQUEST, "M_ROOM_IN_USE", "alias in use");
    }
    st.counter += 1;
    let room_id = format!("!room{}:{}", st.counter, s.server_name);
    let mut room = Room { name: body["name"].as_str().map(String::from), ..Default::default() };
    room.members.insert(creator.clone(), Membership::Joined);
    for u in body["invite"].as_array().cloned().unwrap_or_default() {
        if let Some(u) = u.as_str() {
            room.members.insert(u.to_string(), Membership::Invited);
        }
    }
    st.rooms.insert(room_id.clone(), room);
    st.room_order.push(room_id.clone());
    if let Some(a) = alias {
        st.aliases.insert(a, room_id.clone());
    }
    s.mint_event(&mut st, &room_id, &creator, "m.room.create", json!({"creator": creator}), Some(String::new()));
    if let Some(name) = body["name"].as_str() {
        s.mint_event(&mut st, &room_id, &creator, "m.room.name", json!({"name": name}), Some(String::new()));
    }
    for ev in body["initial_state"].as_array().cloned().unwrap_or_default() {
        s.mint_event(
            &mut st,
            &room_id,
            &creator,
            ev["type"].as_str().unwrap_or_default(),
            ev["content"].clone(),
            Some(ev["state_key"].as_str().unwrap_or_default().to_string()),
        );
    }
    Json(json!({"room_id": room_id})).into_response()
}

async fn resolve_alias(State(s): State<Arc<Inner>>, headers: HeaderMap, Path(alias): Path<String>, Query(q): Q) -> Reply {
    if let Err(r) = s.authenticate(&headers, &q) {
        return r;
    }
    match s.st().aliases.get(&alias) {
        Some(id) => Json(json!({"room_id": id, "servers": [s.server_name]})).into_response(),
        None => mx_err(StatusCode::NOT_FOUND, "M_NOT_FOUND", "no such alias"),
    }
}

async fn invite(State(s): State<Arc<Inner>>, headers: HeaderMap, Path(room): Path<String>, Query(q): Q, Json(body): Json<Value>) -> Reply {
    let inviter = match s.authenticate(&headers, &q) {
        Ok(u) => u,
        Err(r) => return r,
    };
    let mut st = s.st();
    let Some(r) = st.rooms.get_mut(&room) else { return mx_err(StatusCode::NOT_FOUND, "M_NOT_FOUND", "unknown room") };
    if r.members.get(&inviter) != Some(&Membership::Joined) {
        return mx_err(StatusCode::FORBIDDEN, "M_FORBIDDEN", "inviter is not in the room");
    }
    let target = body["user_id"].as_str().unwrap_or_default().to_string();
    r.members.entry(target.clone()).or_insert(Membership::Invited);
    s.mint_event(&mut st, &room, &inviter, "m.room.member", json!({"membership": "invite"}), Some(target));
    Json(json!({})).into_response()
}

async fn join(State(s): State<Arc<Inner>>, headers: HeaderMap, Path(room): Path<String>, Query(q): Q) -> Reply {
    let user = match s.authenticate(&headers, &q) {
        Ok(u) => u,
        Err(r) => return r,
    };
    let mut st = s.st();
    let Some(r) = st.rooms.get_mut(&room) else { return mx_err(StatusCode::NOT_FOUND, "M_NOT_FOUND", "unknown room") };
    match r.members.get(&user) {
        Some(_) => {
            r.members.insert(user.clone(), Membership::Joined);
        }
        None => return mx_err(StatusCode::FORBIDDEN, "M_FORBIDDEN", "not invited to a private room"),
    }
    s.mint_event(&mut st, &room, &user, "m.room.member", json!({"membership": "join"}), Some(user.clone()));
    Json(json!({"room_id": room})).into_response()
}

async fn send(
    State(s): State<Arc<Inner>>,
    headers: HeaderMap,
    Path((room, kind, txn)): Path<(String, String, String)>,
    Query(q): Q,
    Json(content): Json<Value>,
) -> Reply {
    let sender = match s.authenticate(&headers, &q) {
        Ok(u) => u,
        Err(r) => return r,
    };
    let mut st = s.st();
    let key = (room.clone(), sender.clone(), txn);
    if let Some(existing) = st.txns.get(&key) {
        return Json(json!({"event_id": existing})).into_response();
    }
    let Some(r) = st.rooms.get(&room) else { return mx_err(StatusCode::NOT_FOUND, "M_NOT_FOUND", "unknown room") };
    if r.members.get(&sender) != Some(&Membership::Joined) {
        return mx_err(StatusCode::FORBIDDEN, "M_FORBIDDEN", "sender is not joined to the room");
    }
    let ev = s.mint_event(&mut st, &room, &sender, &kind, content, None);
    st.txns.insert(key, ev.event_id.clone());
    Json(json!({"event_id": ev.event_id})).into_response()
}

async fn put_state(
    State(s): State<Arc<Inner>>,
    headers: HeaderMap,
    Path((room, kind, key)): Path<(String, String, String)>,
    Query(q): Q,
    Json(content): Json<Value>,
) -> Reply {
    let sender = match s.authenticate(&headers, &q) {
        Ok(u) => u,
        Err(r) => return r,
    };
    let mut st = s.st();
    if !st.rooms.contains_key(&room) {
        return mx_err(StatusCode::NOT_FOUND, "M_NOT_FOUND", "unknown room");
    }
    let ev = s.mint_event(&mut st, &room, &sender, &kind, content, Some(key));
    Json(json!({"event_id": ev.event_id})).into_response()
}

async fn messages(State(s): State<Arc<Inner>>, headers: HeaderMap, Path(room): Path<String>, Query(q): Q) -> Reply {
    if let Err(r) = s.authenticate(&headers, &q) {
        return r;
    }
    let st = s.st();
    match st.rooms.get(&room) {
        Some(r) => Json(json!({"chunk": r.events.iter().map(MxEvent::to_json).collect::<Vec<_>>()})).into_response(),
        None => mx_err(StatusCode::NOT_FOUND, "M_NOT_FOUND", "unknown room"),
    }
}

async fn keys_upload(State(s): State<Arc<Inner>>, headers: HeaderMap, Query(q): Q, Json(body): Json<Value>) -> Reply {
    let user = match s.authenticate(&headers, &q) {
        Ok(u) => u,
        Err(r) => return r,
    };
    let device = q.get("device_id").cloned().or_else(|| body["device_keys"]["device_id"].as_str().map(String::from));
    let Some(device) = device else { return mx_err(StatusCode::BAD_REQUEST, "M_MISSING_PARAM", "device_id is required for appservice key uploads") };
    if let Some(dk) = body.get("device_keys")
        && (dk["user_id"] != user || dk["device_id"] != device)
    {
        return mx_err(StatusCode::BAD_REQUEST, "M_INVALID_PARAM", "device_keys do not match the acting user/device");
    }
    Json(s.upload_keys(&user, &device, &body)).into_response()
}

async fn keys_query(State(s): State<Arc<Inner>>, headers: HeaderMap, Query(q): Q, Json(body): Json<Value>) -> Reply {
    if let Err(r) = s.authenticate(&headers, &q) {
        return r;
    }
    let users: Vec<String> = body["device_keys"].as_object().map(|o| o.keys().cloned().collect()).unwrap_or_default();
    Json(json!({"device_keys": s.query_keys_for(&users), "failures": {}})).into_response()
}

async fn keys_claim(State(s): State<Arc<Inner>>, headers: HeaderMap, Query(q): Q, Json(body): Json<Value>) -> Reply {
    if let Err(r) = s.authenticate(&headers, &q) {
        return r;
    }
    let mut out = serde_json::Map::new();
    for (user, devices) in body["one_time_keys"].as_object().cloned().unwrap_or_default() {
        for (device, _alg) in devices.as_object().cloned().unwrap_or_default() {
            if let Some(k) = s.claim_key(&user, &device) {
                out.entry(user.clone()).or_insert_with(|| json!({}))[device] = k;
            }
        }
    }
    Json(json!({"one_time_keys": out, "failures": {}})).into_response()
}

async fn send_to_device(
    State(s): State<Arc<Inner>>,
    headers: HeaderMap,
    Path((kind, txn)): Path<(String, String)>,
    Query(q): Q,
    Json(body): Json<Value>,
) -> Reply {
    let sender = match s.authenticate(&headers, &q) {
        Ok(u) => u,
        Err(r) => return r,
    };
    let key = (sender.clone(), kind.clone(), txn);
    if !s.st().td_txns.insert(key) {
        return Json(json!({})).into_response();
    }
    s.deliver_to_device(&sender, &kind, &body["messages"]);
    Json(json!({})).into_response()
}

async fn joined_members(State(s): State<Arc<Inner>>, headers: HeaderMap, Path(room): Path<String>, Query(q): Q) -> Reply {
    if let Err(r) = s.authenticate(&headers, &q) {
        return r;
    }
    let st = s.st();
    match st.rooms.get(&room) {
        Some(r) => {
            let joined: serde_json::Map<String, Value> = r
                .members
                .iter()
                .filter(|(_, m)| **m == Membership::Joined)
                .map(|(u, _)| (u.clone(), json!({"display_name": st.users.get(u).cloned().flatten()})))
                .collect();
            Json(json!({"joined": joined})).into_response()
        }
        None => mx_err(StatusCode::NOT_FOUND, "M_NOT_FOUND", "unknown room"),
    }
}

async fn delete_devices(State(s): State<Arc<Inner>>, headers: HeaderMap, Query(q): Q, Json(body): Json<Value>) -> Reply {
    let user = match s.authenticate(&headers, &q) {
        Ok(u) => u,
        Err(r) => return r,
    };
    let mut st = s.st();
    for d in body["devices"].as_array().cloned().unwrap_or_default() {
        if let Some(id) = d.as_str() {
            if let Some(m) = st.device_keys.get_mut(&user) {
                m.remove(id);
            }
            st.otks.remove(&(user.clone(), id.to_string()));
            st.fallback.remove(&(user.clone(), id.to_string()));
        }
    }
    Json(json!({})).into_response()
}

async fn versions() -> Json<Value> {
    Json(json!({"versions": ["v1.11"]}))
}

impl MockMatrix {
    pub async fn start(server_name: &str) -> Self {
        let (push_tx, mut push_rx) = mpsc::unbounded_channel::<Push>();
        let inner = Arc::new(Inner {
            server_name: server_name.into(),
            state: Mutex::new(State_ { echo: true, ..Default::default() }),
            push_tx,
            http: reqwest::Client::new(),
        });
        let base = "/_matrix/client/v3";
        let app = Router::new()
            .route("/_matrix/client/versions", get(versions))
            .route(&format!("{base}/register"), post(register))
            .route(&format!("{base}/createRoom"), post(create_room))
            .route(&format!("{base}/profile/{{user}}/displayname"), put(set_displayname))
            .route(&format!("{base}/directory/room/{{alias}}"), get(resolve_alias))
            .route(&format!("{base}/rooms/{{room}}/invite"), post(invite))
            .route(&format!("{base}/rooms/{{room}}/join"), post(join))
            .route(&format!("{base}/rooms/{{room}}/send/{{kind}}/{{txn}}"), put(send))
            .route(&format!("{base}/rooms/{{room}}/state/{{kind}}/{{key}}"), put(put_state))
            .route(&format!("{base}/rooms/{{room}}/messages"), get(messages))
            .route(&format!("{base}/rooms/{{room}}/joined_members"), get(joined_members))
            .route(&format!("{base}/keys/upload"), post(keys_upload))
            .route(&format!("{base}/keys/query"), post(keys_query))
            .route(&format!("{base}/keys/claim"), post(keys_claim))
            .route(&format!("{base}/sendToDevice/{{kind}}/{{txn}}"), put(send_to_device))
            .route(&format!("{base}/delete_devices"), post(delete_devices))
            .with_state(inner.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind mock matrix");
        let addr: SocketAddr = listener.local_addr().expect("addr");
        let handle = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        // Delivery of AppService transactions is ordered and retried, like a real homeserver's.
        let pusher = inner.clone();
        tokio::spawn(async move {
            let mut txn = 0u64;
            while let Some(push) = push_rx.recv().await {
                txn += 1;
                for attempt in 0..20 {
                    let (url, token, counts) = {
                        let st = pusher.st();
                        (st.as_url.clone(), st.hs_token.clone(), pusher.otk_counts(&st))
                    };
                    let Some(url) = url else { break };
                    let mut body = json!({"events": push.events});
                    if !push.to_device.is_empty() {
                        body["de.sorunome.msc2409.to_device"] = json!(push.to_device);
                    }
                    if counts.as_object().is_some_and(|o| !o.is_empty()) {
                        body["org.matrix.msc3202.device_one_time_key_counts"] = counts;
                    }
                    let id = push.events.first().and_then(|e| e["event_id"].as_str()).unwrap_or("td").trim_start_matches('$').to_string();
                    let res = pusher
                        .http
                        .put(format!("{}/_matrix/app/v1/transactions/mx{}-{}", url.trim_end_matches('/'), txn, id))
                        .bearer_auth(token)
                        .json(&body)
                        .send()
                        .await;
                    match res {
                        Ok(r) if r.status().is_success() => break,
                        Ok(r) if r.status() == StatusCode::FORBIDDEN => break,
                        _ => tokio::time::sleep(Duration::from_millis(50 * (attempt + 1))).await,
                    }
                }
            }
        });
        Self { inner, url: format!("http://{addr}"), server_name: server_name.into(), handle }
    }

    pub fn register_appservice(&self, as_url: &str, as_token: &str, hs_token: &str, ns_prefix: &str, sender_localpart: &str) {
        let mut st = self.inner.st();
        st.as_url = Some(as_url.into());
        st.as_token = as_token.into();
        st.hs_token = hs_token.into();
        st.ns_prefix = ns_prefix.into();
        st.bot = format!("@{sender_localpart}:{}", self.server_name);
        let bot = st.bot.clone();
        st.users.insert(bot, Some("SomeWork".into()));
    }

    pub fn rotate_tokens(&self, as_token: &str, hs_token: &str) {
        let mut st = self.inner.st();
        st.as_token = as_token.into();
        st.hs_token = hs_token.into();
    }

    pub fn set_outage(&self, down: bool) {
        self.inner.st().outage = down;
    }

    pub fn set_echo(&self, echo: bool) {
        self.inner.st().echo = echo;
    }

    pub fn add_user(&self, mxid: &str) {
        self.inner.st().users.insert(mxid.into(), None);
    }

    pub fn display_name(&self, mxid: &str) -> Option<String> {
        self.inner.st().users.get(mxid).cloned().flatten()
    }

    pub fn user_exists(&self, mxid: &str) -> bool {
        self.inner.st().users.contains_key(mxid)
    }

    /// Accepts every pending invite of `mxid` (a human joining the rooms the bridge invited them to).
    pub fn join_invites(&self, mxid: &str) -> Vec<String> {
        let mut st = self.inner.st();
        let ids: Vec<String> = st.rooms.iter().filter(|(_, r)| r.members.get(mxid) == Some(&Membership::Invited)).map(|(id, _)| id.clone()).collect();
        for id in &ids {
            if let Some(r) = st.rooms.get_mut(id) {
                r.members.insert(mxid.into(), Membership::Joined);
            }
            self.inner.mint_event(&mut st, id, mxid, "m.room.member", json!({"membership": "join"}), Some(mxid.into()));
        }
        ids
    }

    /// A human sends an event; it is pushed to the bridge like any homeserver would.
    pub fn user_send(&self, room: &str, user: &str, kind: &str, content: Value) -> Result<MxEvent, String> {
        let mut st = self.inner.st();
        let Some(r) = st.rooms.get(room) else { return Err("unknown room".into()) };
        if r.members.get(user) != Some(&Membership::Joined) {
            return Err(format!("{user} is not joined to {room}"));
        }
        Ok(self.inner.mint_event(&mut st, room, user, kind, content, None))
    }

    pub fn user_send_text(&self, room: &str, user: &str, body: &str, mentions: &[&str]) -> MxEvent {
        let mut content = json!({"msgtype": "m.text", "body": body});
        if !mentions.is_empty() {
            content["m.mentions"] = json!({"user_ids": mentions});
        }
        self.user_send(room, user, "m.room.message", content).expect("user send")
    }

    pub fn user_send_in_thread(&self, room: &str, user: &str, body: &str, root: &str) -> MxEvent {
        let content = json!({"msgtype": "m.text", "body": body, "m.relates_to": {"rel_type": "m.thread", "event_id": root}});
        self.user_send(room, user, "m.room.message", content).expect("user send")
    }

    pub fn react(&self, room: &str, user: &str, target: &str, key: &str) -> MxEvent {
        self.user_send(room, user, "m.reaction", json!({"m.relates_to": {"rel_type": "m.annotation", "event_id": target, "key": key}})).expect("react")
    }

    /// Pushes an arbitrary transaction to the bridge (replay, forged-token and malformed-delivery tests).
    pub async fn push_transaction(&self, txn_id: &str, events: Vec<Value>, token: Option<&str>) -> u16 {
        let (url, hs) = {
            let st = self.inner.st();
            (st.as_url.clone().expect("appservice registered"), st.hs_token.clone())
        };
        let resp = self
            .inner
            .http
            .put(format!("{}/_matrix/app/v1/transactions/{txn_id}", url.trim_end_matches('/')))
            .bearer_auth(token.unwrap_or(&hs))
            .json(&json!({"events": events}))
            .send()
            .await
            .expect("push");
        resp.status().as_u16()
    }

    // ---- end-to-end encryption helpers for test clients ---------------------------------------------------------------

    /// A human's client publishes device keys and one-time keys (what Element does after login).
    pub fn client_keys_upload(&self, user: &str, device: &str, body: &Value) -> Value {
        self.inner.upload_keys(user, device, body)
    }

    pub fn client_keys_query(&self, users: &[String]) -> Value {
        self.inner.query_keys_for(users)
    }

    pub fn client_keys_claim(&self, user: &str, device: &str) -> Option<Value> {
        self.inner.claim_key(user, device)
    }

    pub fn client_send_to_device(&self, sender: &str, event_type: &str, messages: &Value) {
        self.inner.deliver_to_device(sender, event_type, messages);
    }

    /// Drains the to-device events queued for a (non-appservice) device.
    pub fn client_take_to_device(&self, user: &str, device: &str) -> Vec<Value> {
        self.inner.st().to_device.remove(&(user.to_string(), device.to_string())).unwrap_or_default()
    }

    /// Joined members of a room (what a client learns from /sync).
    pub fn joined_members_of(&self, room: &str) -> Vec<String> {
        self.members(room).into_iter().filter(|(_, m)| *m == Membership::Joined).map(|(u, _)| u).collect()
    }

    /// Overwrites a device's published keys without validation (a compromised or malicious homeserver).
    pub fn inject_device_keys(&self, user: &str, device: &str, keys: Value) {
        self.inner.st().device_keys.entry(user.to_string()).or_default().insert(device.to_string(), keys);
    }

    pub fn one_time_key_count(&self, user: &str, device: &str) -> usize {
        self.inner.st().otks.get(&(user.to_string(), device.to_string())).map(Vec::len).unwrap_or(0)
    }

    pub fn device_ids_of(&self, user: &str) -> Vec<String> {
        let mut v: Vec<String> = self.inner.st().device_keys.get(user).map(|m| m.keys().cloned().collect()).unwrap_or_default();
        v.sort();
        v
    }

    /// A member leaves (or is removed from) a room.
    pub fn leave(&self, room: &str, user: &str) {
        let mut st = self.inner.st();
        if let Some(r) = st.rooms.get_mut(room) {
            r.members.remove(user);
        }
        self.inner.mint_event(&mut st, room, user, "m.room.member", json!({"membership": "leave"}), Some(user.into()));
    }

    /// Pushes a to-device-only transaction to the appservice (replay/forgery tests).
    pub async fn push_to_device(&self, txn_id: &str, to_device: Vec<Value>) -> u16 {
        let (url, hs) = {
            let st = self.inner.st();
            (st.as_url.clone().expect("appservice registered"), st.hs_token.clone())
        };
        let resp = self
            .inner
            .http
            .put(format!("{}/_matrix/app/v1/transactions/{txn_id}", url.trim_end_matches('/')))
            .bearer_auth(hs)
            .json(&json!({"events": [], "de.sorunome.msc2409.to_device": to_device}))
            .send()
            .await
            .expect("push");
        resp.status().as_u16()
    }

    pub fn rooms(&self) -> Vec<String> {
        self.inner.st().room_order.clone()
    }

    pub fn room_name(&self, room: &str) -> Option<String> {
        self.inner.st().rooms.get(room).and_then(|r| r.name.clone())
    }

    pub fn room_by_name(&self, fragment: &str) -> Option<String> {
        let st = self.inner.st();
        st.room_order.iter().find(|id| st.rooms[*id].name.as_deref().is_some_and(|n| n.contains(fragment))).cloned()
    }

    pub fn members(&self, room: &str) -> Vec<(String, Membership)> {
        self.inner.st().rooms.get(room).map(|r| r.members.iter().map(|(k, v)| (k.clone(), v.clone())).collect()).unwrap_or_default()
    }

    pub fn events(&self, room: &str) -> Vec<MxEvent> {
        self.inner.st().rooms.get(room).map(|r| r.events.clone()).unwrap_or_default()
    }

    pub fn all_events(&self) -> Vec<MxEvent> {
        let st = self.inner.st();
        st.room_order.iter().flat_map(|id| st.rooms[id].events.clone()).collect()
    }

    pub fn events_of_type(&self, room: &str, kind: &str) -> Vec<MxEvent> {
        self.events(room).into_iter().filter(|e| e.kind == kind).collect()
    }

    pub fn state_event(&self, room: &str, kind: &str) -> Option<MxEvent> {
        self.events(room).into_iter().rev().find(|e| e.kind == kind && e.state_key.is_some())
    }

    pub fn thread_children(&self, room: &str, root: &str) -> Vec<MxEvent> {
        self.events(room).into_iter().filter(|e| e.content["m.relates_to"]["rel_type"] == "m.thread" && e.content["m.relates_to"]["event_id"] == root).collect()
    }
}

impl Drop for MockMatrix {
    fn drop(&mut self) {
        self.handle.abort();
    }
}

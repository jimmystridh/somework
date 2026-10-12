//! The `/fleet/api/ops` routes and the sign-in routes. Roles are enforced by the extractor each handler takes (`AsViewer`, `AsEditor`,
//! `AsAdmin`), so a handler cannot forget to check one.

use super::{
    AsAdmin, AsEditor, AsViewer, AuthMode, Authed, Failure, Ops,
    contract::{self, Invalid, slug_of},
    diff,
    reconcile::Observation,
    session::{self, LOGIN_COOKIE, LOGIN_SECONDS, LoginClaims, SESSION_COOKIE, SESSION_SECONDS, SessionClaims},
    store::{DeliveryRow, StoreError, iso},
};
use axum::{
    Json, Router,
    body::Body,
    extract::{DefaultBodyLimit, FromRequest, Path, Query, Request, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post, put},
};
use fleet_shared::{operations::*, somework::Liveness};
use serde::{Deserialize, de::DeserializeOwned};
use std::{collections::BTreeMap, sync::Arc};

const BODY_LIMIT: usize = 1024 * 1024;
const REVISION_PAGE: i64 = 50;
const LIBRARY_PAGE: i64 = 30;

type ApiResult<T> = Result<Json<T>, Failure>;

impl IntoResponse for Failure {
    fn into_response(self) -> Response {
        (self.0, Json(self.1)).into_response()
    }
}

impl From<Invalid> for Failure {
    fn from(invalid: Invalid) -> Self {
        Self(StatusCode::UNPROCESSABLE_ENTITY, ApiError { code: "invalid".into(), message: invalid.message, field: invalid.field, ..Default::default() })
    }
}

impl From<StoreError> for Failure {
    fn from(error: StoreError) -> Self {
        match error {
            StoreError::Conflict(current) => Failure::new(StatusCode::CONFLICT, "revision_conflict", format!("someone saved first: the current revision is {current}")),
            StoreError::InUse(used_by) => Self(StatusCode::CONFLICT, ApiError { code: "in_use".into(), message: format!("it is used by {}: remove it from their setup first", used_by.join(", ")), used_by, ..Default::default() }),
            StoreError::NotFound => Failure::new(StatusCode::NOT_FOUND, "not_found", "there is no such thing"),
            StoreError::Invalid(invalid) => invalid.into(),
            StoreError::LastAdmin => Failure::new(StatusCode::CONFLICT, "last_admin", "the last administrator cannot be removed or demoted"),
            StoreError::Db(detail) => {
                eprintln!("Operations database error: {detail}");
                Failure::unavailable()
            }
        }
    }
}

/// A JSON body whose problems are answered in the shape of `ApiError`.
pub struct Payload<T>(pub T);

impl<T: DeserializeOwned, S: Send + Sync> FromRequest<S> for Payload<T> {
    type Rejection = Failure;

    async fn from_request(request: Request, state: &S) -> Result<Self, Failure> {
        match Json::<T>::from_request(request, state).await {
            Ok(Json(value)) => Ok(Self(value)),
            Err(rejection) => {
                let status = if rejection.status() == StatusCode::PAYLOAD_TOO_LARGE { StatusCode::PAYLOAD_TOO_LARGE } else { StatusCode::BAD_REQUEST };
                Err(Failure::new(status, "bad_request", format!("the request body is not valid: {}", rejection.body_text().lines().last().unwrap_or("unreadable"))))
            }
        }
    }
}

/// A body that may be absent or empty (restore takes an optional note).
async fn optional_body<T: DeserializeOwned + Default>(body: Body) -> Result<T, Failure> {
    let bytes = axum::body::to_bytes(body, BODY_LIMIT).await.map_err(|_| Failure::new(StatusCode::BAD_REQUEST, "bad_request", "the request body is too large"))?;
    if bytes.iter().all(u8::is_ascii_whitespace) {
        return Ok(T::default());
    }
    serde_json::from_slice(&bytes).map_err(|_| Failure::new(StatusCode::BAD_REQUEST, "bad_request", "the request body is not valid"))
}

fn not_found(what: &str) -> Failure {
    Failure::new(StatusCode::NOT_FOUND, "not_found", format!("there is no {what}"))
}

// -------------------------------------------------------------------------------------------------------- agent summaries

fn rejected_view(row: Option<&DeliveryRow>, observed: Option<&RejectedSetup>, kind: &str) -> Option<RejectedSetup> {
    if let Some(rejected) = observed.filter(|rejected| rejected.kind == kind) {
        return Some(rejected.clone());
    }
    row.and_then(|row| row.rejected.clone()).map(|(revision, reason, at)| RejectedSetup { kind: kind.into(), revision, reason, at: at.map(iso) })
}

/// One agent as the list shows it, from the stored revision, the delivery rows and the last read of its profile.
pub fn summarize(id: &str, saved: Option<&SetupRevision>, observation: Option<&Observation>, rows: &[DeliveryRow], liveness: Liveness) -> OpsAgent {
    let row = |kind: &str| rows.iter().find(|row| row.agent == id && row.kind == kind);
    let (override_row, limits_row) = (row("override"), row("limits"));
    let seen = observation.filter(|observation| observation.reachable && observation.reports_setup);
    let applied = |from_agent: Option<u64>, from_row: Option<&DeliveryRow>| match seen {
        Some(_) => from_agent,
        None => from_row.and_then(|row| row.last_reported_revision),
    };
    let saved_revision = saved.map_or(0, |revision| revision.revision);
    let applied_revision = applied(seen.and_then(|o| o.reported.override_revision), override_row);
    let reported_rejection = seen.and_then(|o| o.reported.rejected.as_ref());
    let rejection = rejected_view(override_row, reported_rejection, "override").or_else(|| rejected_view(limits_row, reported_rejection, "limits"));
    OpsAgent {
        id: id.into(),
        slug: slug_of(id),
        role: observation.and_then(|o| o.role.clone()),
        reachable: observation.is_some_and(|o| o.reachable),
        reports_setup: observation.is_some_and(|o| o.reports_setup),
        liveness,
        saved_revision,
        applied_revision,
        pending: saved_revision > 0 && applied_revision.unwrap_or(0) < saved_revision,
        rejected: rejection,
        override_delivery: override_row.map(DeliveryRow::view).unwrap_or_default(),
        applied_limits_revision: applied(seen.and_then(|o| o.reported.limits_revision), limits_row),
        limits_delivery: limits_row.map(DeliveryRow::view).unwrap_or_default(),
        checked_at: observation.map(|o| iso(o.checked_at)),
    }
}

impl Ops {
    /// Every agent Operations can talk about: those with a health endpoint, a stored revision or a delivery record. Keyed by slug.
    async fn agent_ids(&self) -> Result<BTreeMap<String, String>, Failure> {
        let mut ids: std::collections::BTreeSet<String> = self.targets.iter().map(|target| target.id.clone()).collect();
        ids.extend(self.store.known_agents().await?);
        Ok(ids.into_iter().map(|id| (slug_of(&id), id)).collect())
    }

    async fn resolve(&self, slug: &str) -> Result<String, Failure> {
        self.agent_ids().await?.remove(slug).ok_or_else(|| not_found("agent with this name"))
    }

    async fn liveness(&self, id: &str) -> Liveness {
        self.sample.read().await.agents.iter().find(|agent| agent.id == id).map(|agent| agent.liveness.clone()).unwrap_or_default()
    }

    async fn summaries(&self) -> Result<Vec<OpsAgent>, Failure> {
        let ids = self.agent_ids().await?;
        let saved = self.store.latest_setups().await?;
        let rows = self.store.delivery_rows().await?;
        let observations = self.observations.read().await;
        let sample = self.sample.read().await;
        Ok(ids
            .values()
            .map(|id| {
                let liveness = sample.agents.iter().find(|agent| agent.id == *id).map(|agent| agent.liveness.clone()).unwrap_or_default();
                summarize(id, saved.get(id), observations.get(id), &rows, liveness)
            })
            .collect())
    }
}

// ------------------------------------------------------------------------------------------------------------------ routes

pub fn router(ops: Arc<Ops>) -> Router {
    Router::new()
        .route("/me", get(me))
        .route("/agents", get(agents))
        .route("/agents/{slug}", get(agent))
        .route("/agents/{slug}/setup", put(save_setup).delete(reset_setup))
        .route("/agents/{slug}/revisions", get(revisions))
        .route("/agents/{slug}/revisions/{revision}/restore", post(restore))
        .route("/agents/{slug}/resend", post(resend))
        .route("/catalog", get(catalog))
        .route("/catalog/{name}", get(catalog_entry).put(put_catalog).delete(delete_catalog))
        .route("/catalog/{name}/revisions", get(catalog_revisions))
        .route("/library", get(library))
        .route("/library/{name}", get(library_skill).put(put_library).delete(delete_library))
        .route("/library/{name}/revisions", get(library_revisions))
        .route("/limits", get(limits).put(put_limits))
        .route("/limits/revisions", get(limits_revisions))
        .route("/users", get(users))
        .route("/users/{email}", get(user).put(put_user).delete(delete_user))
        .route("/audit", get(audit))
        .fallback(|| async { not_found("such route") })
        .layer(DefaultBodyLimit::max(BODY_LIMIT))
        .with_state(ops)
}

/// What every `/api/ops` route answers when the database is not configured: the rest of the dashboard keeps working.
pub fn off_router() -> Router {
    Router::new().fallback(|| async { Failure::new(StatusCode::SERVICE_UNAVAILABLE, "unavailable", "Operations is not configured on this server (no DATABASE_URL)") })
}

async fn me(Authed(session): AsViewer) -> Json<Me> {
    Json(Me { email: session.email, role: session.role, auth: session.auth.into() })
}

// ----------------------------------------------------------------------------------------------------------------- agents

async fn agents(State(ops): State<Arc<Ops>>, _: AsViewer) -> ApiResult<OpsAgentList> {
    let limits_revision = ops.store.latest_limits().await?.map_or(0, |limits| limits.revision);
    Ok(Json(OpsAgentList { agents: ops.summaries().await?, sending_configured: ops.sending_configured, limits_revision }))
}

async fn agent(State(ops): State<Arc<Ops>>, _: AsViewer, Path(slug): Path<String>) -> ApiResult<OpsAgentDetail> {
    let id = ops.resolve(&slug).await?;
    let revision = ops.store.latest_setup(&id).await?;
    let rows = ops.store.delivery_rows().await?;
    let observation = ops.observations.read().await.get(&id).cloned();
    let liveness = ops.liveness(&id).await;
    let summary = summarize(&id, revision.as_ref(), observation.as_ref(), &rows, liveness);
    let sample = ops.sample.read().await;
    let events = sample.events.agents.iter().find(|agent| agent.id == id);
    let mut notes = Vec::new();
    if !ops.sending_configured {
        notes.push("This server cannot send documents (no operations key or domain address): saved revisions are stored but not delivered.".to_string());
    }
    match &observation {
        None | Some(Observation { reachable: false, .. }) => notes.push("The agent's profile could not be read, so what it has applied is not known.".into()),
        Some(seen) if !seen.reports_setup => notes.push("This agent does not report setup yet (its kit is too old): each revision is sent once and its effect cannot be seen.".into()),
        Some(_) => {}
    }
    if sample.usage.is_none() {
        notes.push("Model usage is not available (no metrics source is configured).".into());
    }
    Ok(Json(OpsAgentDetail {
        form: revision.as_ref().map(|revision| revision.form.clone()).unwrap_or_default(),
        revision,
        reported: observation.as_ref().map(|o| o.reported.clone()).unwrap_or_default(),
        role_defaults: observation.and_then(|o| o.defaults),
        setup_card: events.and_then(|agent| agent.setup.clone()),
        live_jobs: sample.work.active.iter().chain(sample.work.finished.iter()).filter(|job| job.agent == id).cloned().collect(),
        history: events.map(|agent| agent.jobs.clone()).unwrap_or_default(),
        usage: sample.usage.as_ref().map(|usage| usage.rows.iter().filter(|row| row.agent == id).cloned().collect()).unwrap_or_default(),
        notes,
        agent: summary,
    }))
}

async fn save_response(ops: &Arc<Ops>, id: &str, outcome: Result<SetupRevision, StoreError>, base: u64) -> Result<Response, Failure> {
    match outcome {
        Ok(revision) => {
            ops.nudge.notify_one();
            Ok(Json(SetupSaved { revision }).into_response())
        }
        Err(StoreError::Conflict(_)) => {
            let current = ops.store.latest_setup(id).await?.ok_or_else(|| not_found("revision"))?;
            let before = if base == 0 { SetupForm::default() } else { ops.store.setup_revision_at(id, base).await?.map(|revision| revision.form).unwrap_or_default() };
            let conflict = SaveConflict {
                code: "revision_conflict".into(),
                message: format!("someone saved revision {} after the one you started from ({base})", current.revision),
                diff: diff::diff_forms(&before, &current.form),
                current,
            };
            Ok((StatusCode::CONFLICT, Json(conflict)).into_response())
        }
        Err(other) => Err(other.into()),
    }
}

async fn save_setup(State(ops): State<Arc<Ops>>, Authed(session): AsEditor, Path(slug): Path<String>, Payload(save): Payload<SetupSave>) -> Result<Response, Failure> {
    let id = ops.resolve(&slug).await?;
    let note = contract::check_note(save.note.as_deref())?;
    let outcome = ops.store.save_setup(&id, save.base_revision, &save.form, &note, &session.email, "setup.save").await;
    save_response(&ops, &id, outcome, save.base_revision).await
}

async fn reset_setup(State(ops): State<Arc<Ops>>, Authed(session): AsEditor, Path(slug): Path<String>) -> Result<Response, Failure> {
    let id = ops.resolve(&slug).await?;
    let current = ops.store.latest_setup(&id).await?.map_or(0, |revision| revision.revision);
    let outcome = ops.store.save_setup(&id, current, &SetupForm::default(), "reset", &session.email, "setup.reset").await;
    save_response(&ops, &id, outcome, current).await
}

async fn revisions(State(ops): State<Arc<Ops>>, _: AsViewer, Path(slug): Path<String>) -> ApiResult<RevisionList> {
    let id = ops.resolve(&slug).await?;
    let mut all = ops.store.setup_revisions(&id, REVISION_PAGE + 1).await?;
    let more = all.len() as i64 > REVISION_PAGE;
    let older: Vec<SetupRevision> = all.iter().skip(1).cloned().collect();
    if more {
        all.truncate(REVISION_PAGE as usize);
    }
    let empty = SetupForm::default();
    let revisions = all
        .into_iter()
        .enumerate()
        .map(|(index, revision)| {
            let before = older.get(index).map_or(&empty, |previous| &previous.form);
            RevisionWithDiff { diff: diff::diff_forms(before, &revision.form), revision }
        })
        .collect();
    Ok(Json(RevisionList { revisions }))
}

async fn restore(State(ops): State<Arc<Ops>>, Authed(session): AsEditor, Path((slug, revision)): Path<(String, u64)>, body: Body) -> Result<Response, Failure> {
    let restore: SetupRestore = optional_body(body).await?;
    let id = ops.resolve(&slug).await?;
    let old = ops.store.setup_revision_at(&id, revision).await?.ok_or_else(|| not_found("such revision"))?;
    let extra = contract::check_note(restore.note.as_deref())?;
    let note = if extra.is_empty() { format!("restored revision {revision}") } else { format!("restored revision {revision}: {extra}") };
    let current = ops.store.latest_setup(&id).await?.map_or(0, |latest| latest.revision);
    let outcome = ops.store.save_setup(&id, current, &old.form, &contract::cut(&note, MAX_NOTE_CHARS), &session.email, "setup.restore").await;
    save_response(&ops, &id, outcome, current).await
}

async fn resend(State(ops): State<Arc<Ops>>, Authed(session): AsEditor, Path(slug): Path<String>) -> Result<(StatusCode, Json<Accepted>), Failure> {
    let id = ops.resolve(&slug).await?;
    ops.store.audit(&session.email, "setup.resend", &id, "").await?;
    ops.reconciler.force(&id).await;
    Ok((StatusCode::ACCEPTED, Json(Accepted { accepted: true })))
}

// ----------------------------------------------------------------------------------------------------------------- catalog

async fn catalog(State(ops): State<Arc<Ops>>, _: AsViewer) -> ApiResult<CatalogList> {
    Ok(Json(CatalogList { entries: ops.store.catalog().await? }))
}

async fn catalog_entry(State(ops): State<Arc<Ops>>, _: AsViewer, Path(name): Path<String>) -> ApiResult<CatalogEntryView> {
    ops.store.catalog_entry(&name).await?.map(Json).ok_or_else(|| not_found("catalog entry with this name"))
}

async fn put_catalog(State(ops): State<Arc<Ops>>, Authed(session): AsEditor, Path(name): Path<String>, Payload(put): Payload<CatalogPut>) -> ApiResult<CatalogEntryView> {
    if put.entry.name != name {
        return Err(Invalid { message: "entry.name must be the name in the address".into(), field: Some("entry.name".into()) }.into());
    }
    let entry = contract::check_mcp(put.entry)?;
    let note = contract::check_note(put.note.as_deref())?;
    let (view, revised) = ops.store.save_catalog(&entry, put.base_revision, &note, &session.email).await?;
    if !revised.is_empty() {
        ops.nudge.notify_one();
    }
    Ok(Json(view))
}

async fn delete_catalog(State(ops): State<Arc<Ops>>, Authed(session): AsEditor, Path(name): Path<String>) -> Result<StatusCode, Failure> {
    ops.store.delete_catalog(&name, &session.email).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn catalog_revisions(State(ops): State<Arc<Ops>>, _: AsViewer, Path(name): Path<String>) -> ApiResult<CatalogRevisionList> {
    let all = ops.store.catalog_revisions(&name, REVISION_PAGE + 1).await?;
    if all.is_empty() {
        return Err(not_found("catalog entry with this name"));
    }
    let revisions = (0..all.len().min(REVISION_PAGE as usize))
        .map(|index| {
            let (revision, entry, author, note, at) = &all[index];
            let before = all.get(index + 1).and_then(|previous| previous.1.as_ref());
            CatalogRevision { name: name.clone(), revision: *revision as u64, entry: entry.clone(), author: author.clone(), note: note.clone(), created_at: iso(*at), diff: diff::diff_entries(before, entry.as_ref()) }
        })
        .collect();
    Ok(Json(CatalogRevisionList { revisions }))
}

// ----------------------------------------------------------------------------------------------------------------- library

async fn library(State(ops): State<Arc<Ops>>, _: AsViewer) -> ApiResult<LibraryList> {
    Ok(Json(LibraryList { skills: ops.store.library().await? }))
}

async fn library_skill(State(ops): State<Arc<Ops>>, _: AsViewer, Path(name): Path<String>) -> ApiResult<LibrarySkillDetail> {
    ops.store.library_skill(&name).await?.map(Json).ok_or_else(|| not_found("library skill with this name"))
}

async fn put_library(State(ops): State<Arc<Ops>>, Authed(session): AsEditor, Path(name): Path<String>, Payload(put): Payload<LibraryPut>) -> ApiResult<LibrarySkillView> {
    let skill = contract::check_skill(&name, &put.content)?;
    let note = contract::check_note(put.note.as_deref())?;
    let (view, revised) = ops.store.save_library(&name, put.base_version, &skill, &note, &session.email).await?;
    if !revised.is_empty() {
        ops.nudge.notify_one();
    }
    Ok(Json(view))
}

async fn delete_library(State(ops): State<Arc<Ops>>, Authed(session): AsEditor, Path(name): Path<String>) -> Result<StatusCode, Failure> {
    ops.store.delete_library(&name, &session.email).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn library_revisions(State(ops): State<Arc<Ops>>, _: AsViewer, Path(name): Path<String>) -> ApiResult<LibraryRevisionList> {
    let revisions = ops.store.library_revisions(&name, LIBRARY_PAGE).await?;
    if revisions.is_empty() {
        return Err(not_found("library skill with this name"));
    }
    Ok(Json(LibraryRevisionList { revisions }))
}

// ------------------------------------------------------------------------------------------------------------------ limits

async fn limits(State(ops): State<Arc<Ops>>, _: AsViewer) -> ApiResult<LimitsView> {
    let current = ops.store.latest_limits().await?;
    let rows = ops.store.delivery_rows().await?;
    let observations = ops.observations.read().await;
    let agents = ops
        .agent_ids()
        .await?
        .into_values()
        .map(|id| {
            let summary = summarize(&id, None, observations.get(&id), &rows, Liveness::Unknown);
            AgentLimitsState { slug: summary.slug, applied_revision: summary.applied_limits_revision, delivery: summary.limits_delivery, rejected: summary.rejected.filter(|rejected| rejected.kind == "limits"), id }
        })
        .collect();
    Ok(Json(LimitsView { current, agents }))
}

async fn put_limits(State(ops): State<Arc<Ops>>, Authed(session): AsAdmin, Payload(put): Payload<LimitsPut>) -> ApiResult<LimitsRevision> {
    let note = contract::check_note(put.note.as_deref())?;
    let saved = ops.store.save_limits(put.base_revision, &put.values, &note, &session.email).await?;
    ops.nudge.notify_one();
    Ok(Json(saved))
}

async fn limits_revisions(State(ops): State<Arc<Ops>>, _: AsViewer) -> ApiResult<LimitsRevisionList> {
    let mut all = ops.store.limits_revisions(REVISION_PAGE + 1).await?;
    all.truncate(REVISION_PAGE as usize + 1);
    let revisions = (0..all.len().min(REVISION_PAGE as usize))
        .map(|index| LimitsRevisionWithDiff { diff: diff::diff_limits(all.get(index + 1).map(|previous| &previous.values), &all[index].values), revision: all[index].clone() })
        .collect();
    Ok(Json(LimitsRevisionList { revisions }))
}

// ------------------------------------------------------------------------------------------------------------------- users

fn email_path(raw: &str) -> Result<String, Failure> {
    let email = raw.trim().to_lowercase();
    let ok = email.len() <= 254 && email.split_once('@').is_some_and(|(local, domain)| !local.is_empty() && domain.contains('.')) && !email.chars().any(|c| c.is_control() || c.is_whitespace());
    if ok { Ok(email) } else { Err(Invalid { message: "that is not an email address".into(), field: Some("email".into()) }.into()) }
}

async fn users(State(ops): State<Arc<Ops>>, _: AsAdmin) -> ApiResult<UserList> {
    Ok(Json(UserList { users: ops.store.users().await? }))
}

async fn user(State(ops): State<Arc<Ops>>, _: AsAdmin, Path(email): Path<String>) -> ApiResult<UserView> {
    ops.store.user(&email_path(&email)?).await?.map(Json).ok_or_else(|| not_found("user with this email"))
}

async fn put_user(State(ops): State<Arc<Ops>>, Authed(session): AsAdmin, Path(email): Path<String>, Payload(put): Payload<UserPut>) -> ApiResult<UserView> {
    Ok(Json(ops.store.put_user(&email_path(&email)?, put.role, &session.email).await?))
}

async fn delete_user(State(ops): State<Arc<Ops>>, Authed(session): AsAdmin, Path(email): Path<String>) -> Result<StatusCode, Failure> {
    ops.store.delete_user(&email_path(&email)?, &session.email).await?;
    Ok(StatusCode::NO_CONTENT)
}

// -------------------------------------------------------------------------------------------------------------------- audit

#[derive(Deserialize, Default)]
struct AuditQuery {
    limit: Option<i64>,
    before: Option<i64>,
}

async fn audit(State(ops): State<Arc<Ops>>, _: AsViewer, Query(query): Query<AuditQuery>) -> ApiResult<AuditPage> {
    Ok(Json(ops.store.audit_page(query.limit.unwrap_or(100), query.before).await?))
}

// -------------------------------------------------------------------------------------------------------------------- sign-in

pub fn auth_router(ops: Arc<Ops>) -> Router {
    Router::new().route("/login", get(login)).route("/callback", get(callback)).route("/logout", post(logout)).with_state(ops)
}

fn page(status: StatusCode, text: &str, cookies: &[String]) -> Response {
    let mut response = (status, [(header::CONTENT_TYPE, "text/html; charset=utf-8")], format!("<!doctype html><meta charset=\"utf-8\"><title>Operations</title><p>{text}</p><p><a href=\"/fleet/auth/login\">Sign in</a></p>")).into_response();
    for cookie in cookies {
        if let Ok(value) = HeaderValue::from_str(cookie) {
            response.headers_mut().append(header::SET_COOKIE, value);
        }
    }
    response
}

fn redirect(to: &str, cookies: &[String]) -> Response {
    let mut response = StatusCode::FOUND.into_response();
    if let Ok(value) = HeaderValue::from_str(to) {
        response.headers_mut().insert(header::LOCATION, value);
    }
    for cookie in cookies {
        if let Ok(value) = HeaderValue::from_str(cookie) {
            response.headers_mut().append(header::SET_COOKIE, value);
        }
    }
    response
}

#[derive(Deserialize, Default)]
struct LoginQuery {
    next: Option<String>,
}

async fn login(State(ops): State<Arc<Ops>>, Query(query): Query<LoginQuery>) -> Response {
    let next = session::safe_next(query.next.as_deref());
    let AuthMode::Entra(oidc) = &ops.auth else { return redirect(&next, &[]) };
    let (state, nonce, verifier) = (session::random_token(24), session::random_token(24), session::random_token(32));
    match oidc.authorization_url(&state, &nonce, &verifier).await {
        Ok(url) => {
            let claims = LoginClaims { state, nonce, verifier, next, expires: chrono::Utc::now().timestamp() + LOGIN_SECONDS };
            redirect(&url, &[session::set_cookie(LOGIN_COOKIE, &ops.cookies.sign(&claims), LOGIN_SECONDS)])
        }
        Err(reason) => {
            eprintln!("Operations sign-in could not start: {reason}");
            page(StatusCode::SERVICE_UNAVAILABLE, "Sign-in is not available right now.", &[])
        }
    }
}

#[derive(Deserialize, Default)]
struct CallbackQuery {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
}

async fn callback(State(ops): State<Arc<Ops>>, headers: HeaderMap, Query(query): Query<CallbackQuery>) -> Response {
    use subtle::ConstantTimeEq;
    let AuthMode::Entra(oidc) = &ops.auth else { return redirect("/fleet/", &[]) };
    let clear = [session::clear_cookie(LOGIN_COOKIE)];
    let refuse = |reason: &str| {
        eprintln!("Operations sign-in refused: {reason}");
        page(StatusCode::FORBIDDEN, "Sign-in did not work. Try again.", &clear)
    };
    let now = chrono::Utc::now().timestamp();
    let Some(login) = headers.get(header::COOKIE).and_then(|value| value.to_str().ok()).and_then(|header| session::cookie_value(header, LOGIN_COOKIE)).and_then(|value| ops.cookies.open::<LoginClaims>(&value)) else {
        return refuse("no sign-in is in progress in this browser");
    };
    if login.expires <= now {
        return refuse("the sign-in took too long");
    }
    if query.error.is_some() {
        return refuse("the identity provider reported an error");
    }
    let (Some(code), Some(state)) = (query.code.as_deref(), query.state.as_deref()) else { return refuse("the answer has no code or state") };
    if !bool::from(state.as_bytes().ct_eq(login.state.as_bytes())) {
        return refuse("the state does not match");
    }
    let identity = match oidc.complete(code, &login.verifier, &login.nonce, now).await {
        Ok(identity) => identity,
        Err(reason) => return refuse(&reason),
    };
    match ops.store.user(&identity.email).await {
        Ok(Some(_)) => {
            let _ = ops.store.audit(&identity.email, "signin", &identity.email, "").await;
            let claims = SessionClaims { email: identity.email, issued: now, expires: now + SESSION_SECONDS };
            redirect(&login.next, &[session::set_cookie(SESSION_COOKIE, &ops.cookies.sign(&claims), SESSION_SECONDS), session::clear_cookie(LOGIN_COOKIE)])
        }
        Ok(None) => {
            let _ = ops.store.audit(&identity.email, "signin.refused", &identity.email, "not on the allow list").await;
            page(StatusCode::FORBIDDEN, "You signed in, but you are not on the allow list for Operations. Ask an administrator to add you.", &clear)
        }
        Err(_) => page(StatusCode::SERVICE_UNAVAILABLE, "Operations cannot reach its database right now.", &clear),
    }
}

async fn logout(headers: HeaderMap) -> Response {
    if headers.get(super::WRITE_HEADER).and_then(|value| value.to_str().ok()) != Some("1") {
        return Failure::new(StatusCode::FORBIDDEN, "forbidden", "writes need the header X-Operations-Request: 1").into_response();
    }
    let mut response = StatusCode::NO_CONTENT.into_response();
    if let Ok(value) = HeaderValue::from_str(&session::clear_cookie(SESSION_COOKIE)) {
        response.headers_mut().append(header::SET_COOKIE, value);
    }
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ops::{
        delivery::tests::{deliverer, fake_domain},
        oidc::{Oidc, OidcConfig, tests::TestIdp},
        session::cookie_value,
        testing::{WRITE, fake_agent, ops_with, postgres, profile, send, stub_ops},
    };
    use axum::http::StatusCode as S;
    use serde_json::{Value, json};

    const MCP: fn(&str, &str) -> Value = |name, command| json!({"name": name, "transport": "stdio", "command": command, "approval": "ask"});

    async fn app_as(store: &crate::ops::store::Store, role: Role) -> Router {
        router(stub_ops(store, role, None, vec![]))
    }

    async fn with_agent(store: &crate::ops::store::Store, role: Role) -> (Router, Arc<Ops>) {
        let (target, _) = fake_agent("agent/pi-agent", Some(profile("developer", None, None))).await;
        let ops = stub_ops(store, role, None, vec![target]);
        (router(ops.clone()), ops)
    }

    #[tokio::test]
    async fn roles_are_enforced_per_route() {
        let Some(pg) = postgres("roles_are_enforced_per_route") else { return };
        let store = pg.store("roles").await;
        let (viewer, editor, admin) = (with_agent(&store, Role::Viewer).await.0, with_agent(&store, Role::Editor).await.0, with_agent(&store, Role::Admin).await.0);
        let form = json!({"baseRevision": 0, "form": {}});
        let limits = json!({"baseRevision": 0, "values": {"maxTokensCap": 1, "maxMinutesCap": 1, "dailyTokenLimit": 1, "budgetRaiseCeiling": 1}});
        let skill = json!({"baseVersion": 0, "content": "---\ndescription: d\n---\nbody"});
        let catalog = json!({"baseRevision": 0, "entry": MCP("docs", "npx")});
        // (method, path, body, lowest role that may)
        let routes: Vec<(&str, &str, Option<Value>, Role)> = vec![
            ("GET", "/me", None, Role::Viewer),
            ("GET", "/agents", None, Role::Viewer),
            ("GET", "/agents/pi-agent", None, Role::Viewer),
            ("GET", "/agents/pi-agent/revisions", None, Role::Viewer),
            ("GET", "/catalog", None, Role::Viewer),
            ("GET", "/library", None, Role::Viewer),
            ("GET", "/limits", None, Role::Viewer),
            ("GET", "/limits/revisions", None, Role::Viewer),
            ("GET", "/audit", None, Role::Viewer),
            ("GET", "/users", None, Role::Admin),
            ("PUT", "/agents/pi-agent/setup", Some(form.clone()), Role::Editor),
            ("POST", "/agents/pi-agent/resend", None, Role::Editor),
            ("PUT", "/catalog/docs", Some(catalog), Role::Editor),
            ("PUT", "/library/review", Some(skill), Role::Editor),
            ("PUT", "/limits", Some(limits), Role::Admin),
            ("PUT", "/users/new@example.com", Some(json!({"role": "viewer"})), Role::Admin),
        ];
        for (method, path, body, lowest) in routes {
            for (role, app) in [(Role::Viewer, &viewer), (Role::Editor, &editor), (Role::Admin, &admin)] {
                if role >= lowest {
                    continue;
                }
                let (status, answer, _) = send(app, method, path, body.clone(), WRITE).await;
                assert_eq!(status, S::FORBIDDEN, "{role:?} must not {method} {path}");
                assert_eq!(answer["code"], "forbidden");
            }
            let (status, answer, _) = send(match lowest {
                Role::Viewer => &viewer,
                Role::Editor => &editor,
                Role::Admin => &admin,
            }, method, path, body, WRITE).await;
            assert!(status.is_success(), "{lowest:?} may {method} {path}, got {status}: {answer}");
        }
    }

    #[tokio::test]
    async fn a_service_token_acts_as_its_service_with_its_role() {
        let Some(pg) = postgres("a_service_token_acts_as_its_service_with_its_role") else { return };
        let store = pg.store("service").await;
        let (target, _) = fake_agent("agent/pi-agent", Some(profile("developer", None, None))).await;
        let digest = crate::ops::contract::sha256_hex(b"manager-token");
        let tokens = crate::ops::service::parse(&format!(r#"[{{"name": "agent/manager", "sha256": "{digest}", "role": "editor"}}]"#)).unwrap();
        let ops = crate::ops::testing::ops_with_services(&store, AuthMode::Stub(crate::ops::StubUser { email: "nobody@example.com".into(), role: Role::Viewer }), None, vec![target], tokens);
        let app = router(ops);
        let body = Some(json!({"baseRevision": 0, "form": {"instructions": "be brief"}, "note": "asked on Telegram"}));
        let bearer = |token: &str| [("x-operations-request", "1"), ("x-operations-service-token", if token == "good" { "manager-token" } else { "guess" })].map(|(name, value)| (name, value.to_string()));

        let as_viewer = send(&app, "PUT", "/agents/pi-agent/setup", body.clone(), WRITE).await;
        assert_eq!(as_viewer.0, S::FORBIDDEN, "without the token the caller is only the viewer the stub signs in");
        let guessed = bearer("bad");
        let (status, answer, _) = send(&app, "PUT", "/agents/pi-agent/setup", body.clone(), &guessed.iter().map(|(n, v)| (*n, v.as_str())).collect::<Vec<_>>()).await;
        assert_eq!((status, answer["code"].as_str()), (S::UNAUTHORIZED, Some("unauthorized")));
        assert!(store.latest_setup("agent/pi-agent").await.unwrap().is_none());

        let good = bearer("good");
        let headers: Vec<(&str, &str)> = good.iter().map(|(n, v)| (*n, v.as_str())).collect();
        let (status, saved, _) = send(&app, "PUT", "/agents/pi-agent/setup", body, &headers).await;
        assert_eq!(status, S::OK, "{saved}");
        assert_eq!((saved["revision"]["author"].as_str(), saved["revision"]["revision"].as_u64()), (Some("agent/manager"), Some(1)));
        let (_, me, _) = send(&app, "GET", "/me", None, &headers[1..]).await;
        assert_eq!((me["email"].as_str(), me["role"].as_str(), me["auth"].as_str()), (Some("agent/manager"), Some("editor"), Some("service")));
        let (status, _, _) = send(&app, "PUT", "/limits", Some(json!({"baseRevision": 0, "values": {"maxTokensCap": 1, "maxMinutesCap": 1, "dailyTokenLimit": 1, "budgetRaiseCeiling": 1}})), &headers).await;
        assert_eq!(status, S::FORBIDDEN, "an editor token cannot change the fleet limits");
    }

    #[tokio::test]
    async fn a_write_needs_the_request_header() {
        let Some(pg) = postgres("a_write_needs_the_request_header") else { return };
        let store = pg.store("csrf").await;
        let (app, _) = with_agent(&store, Role::Admin).await;
        let body = Some(json!({"baseRevision": 0, "form": {"instructions": "x"}}));
        for headers in [&[][..], &[("x-operations-request", "0")], &[("x-operations-request", "true")]] {
            let (status, answer, _) = send(&app, "PUT", "/agents/pi-agent/setup", body.clone(), headers).await;
            assert_eq!((status, answer["code"].as_str()), (S::FORBIDDEN, Some("forbidden")));
        }
        assert_eq!(send(&app, "DELETE", "/agents/pi-agent/setup", None, &[]).await.0, S::FORBIDDEN);
        assert!(store.latest_setup("agent/pi-agent").await.unwrap().is_none(), "nothing was written");
        assert_eq!(send(&app, "GET", "/agents", None, &[]).await.0, S::OK, "reads need no header");
        assert_eq!(send(&app, "PUT", "/agents/pi-agent/setup", body, WRITE).await.0, S::OK);
    }

    #[tokio::test]
    async fn saving_an_agent_setup_answers_409_with_the_newer_revision_and_what_changed() {
        let Some(pg) = postgres("saving_an_agent_setup_answers_409_with_the_newer_revision_and_what_changed") else { return };
        let store = pg.store("conflict").await;
        let (app, _) = with_agent(&store, Role::Editor).await;
        let save = |base: u64, instructions: &str| Some(json!({"baseRevision": base, "form": {"instructions": instructions}, "note": "why"}));
        let (status, saved, _) = send(&app, "PUT", "/agents/pi-agent/setup", save(0, "first"), WRITE).await;
        assert_eq!(status, S::OK);
        assert_eq!((saved["revision"]["revision"].as_u64(), saved["revision"]["author"].as_str(), saved["revision"]["note"].as_str()), (Some(1), Some("editor@example.com"), Some("why")));
        assert_eq!(send(&app, "PUT", "/agents/pi-agent/setup", save(1, "second"), WRITE).await.0, S::OK);
        let (status, conflict, _) = send(&app, "PUT", "/agents/pi-agent/setup", save(1, "stale edit"), WRITE).await;
        assert_eq!(status, S::CONFLICT);
        assert_eq!(conflict["code"], "revision_conflict");
        assert_eq!((conflict["current"]["revision"].as_u64(), conflict["current"]["form"]["instructions"].as_str()), (Some(2), Some("second")));
        assert_eq!(conflict["diff"][0]["field"], "instructions", "what changed since the revision the editor started from");
        assert_eq!(conflict["diff"][0]["before"], "first");
        assert_eq!(conflict["diff"][0]["after"], "second");
        let (status, _, _) = send(&app, "PUT", "/agents/pi-agent/setup", save(0, "from nothing"), WRITE).await;
        assert_eq!(status, S::CONFLICT);
        assert_eq!(store.latest_setup("agent/pi-agent").await.unwrap().unwrap().revision, 2);
    }

    #[tokio::test]
    async fn an_invalid_setup_is_422_with_the_field_and_nothing_is_stored() {
        let Some(pg) = postgres("an_invalid_setup_is_422_with_the_field_and_nothing_is_stored") else { return };
        let store = pg.store("invalid").await;
        let (app, _) = with_agent(&store, Role::Editor).await;
        let cases = [
            (json!({"instructions": "x".repeat(16_001)}), "instructions"),
            (json!({"mcp": ["ghost"]}), "mcp"),
            (json!({"approvalPatterns": [{"pattern": "(", "reason": "r"}]}), "approvalPatterns"),
            (json!({"model": {"provider": "", "modelId": "m"}}), "model"),
        ];
        for (form, field) in cases {
            let (status, answer, _) = send(&app, "PUT", "/agents/pi-agent/setup", Some(json!({"baseRevision": 0, "form": form})), WRITE).await;
            assert_eq!((status, answer["code"].as_str(), answer["field"].as_str()), (S::UNPROCESSABLE_ENTITY, Some("invalid"), Some(field)), "{answer}");
        }
        let (status, answer, _) = send(&app, "PUT", "/agents/pi-agent/setup", Some(json!({"baseRevision": "zero"})), WRITE).await;
        assert_eq!((status, answer["code"].as_str()), (S::BAD_REQUEST, Some("bad_request")));
        assert_eq!(send(&app, "PUT", "/agents/nobody/setup", Some(json!({"baseRevision": 0, "form": {}})), WRITE).await.0, S::NOT_FOUND);
        assert!(store.latest_setup("agent/pi-agent").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn reset_and_restore_make_new_revisions_and_the_log_shows_diffs() {
        let Some(pg) = postgres("reset_and_restore_make_new_revisions_and_the_log_shows_diffs") else { return };
        let store = pg.store("history").await;
        let (app, _) = with_agent(&store, Role::Editor).await;
        send(&app, "PUT", "/agents/pi-agent/setup", Some(json!({"baseRevision": 0, "form": {"instructions": "keep it short", "model": {"provider": "p", "modelId": "m"}}})), WRITE).await;
        let (status, reset, _) = send(&app, "DELETE", "/agents/pi-agent/setup", None, WRITE).await;
        assert_eq!((status, reset["revision"]["revision"].as_u64(), reset["revision"]["note"].as_str()), (S::OK, Some(2), Some("reset")));
        assert_eq!(reset["revision"]["form"], json!({"instructions": null, "model": null, "disableGlobalPrompt": false, "approvalPatterns": null, "repositorySkills": null, "librarySkills": [], "overlays": {}, "mcp": []}), "a reset is the empty form");
        let (status, restored, _) = send(&app, "POST", "/agents/pi-agent/revisions/1/restore", None, WRITE).await;
        assert_eq!((status, restored["revision"]["revision"].as_u64(), restored["revision"]["note"].as_str()), (S::OK, Some(3), Some("restored revision 1")));
        assert_eq!(restored["revision"]["form"]["instructions"], "keep it short");
        assert_eq!(send(&app, "POST", "/agents/pi-agent/revisions/9/restore", None, WRITE).await.0, S::NOT_FOUND);
        let (_, log, _) = send(&app, "GET", "/agents/pi-agent/revisions", None, &[]).await;
        let revisions = log["revisions"].as_array().unwrap();
        assert_eq!(revisions.iter().map(|r| r["revision"]["revision"].as_u64().unwrap()).collect::<Vec<_>>(), vec![3, 2, 1]);
        let fields = |index: usize| revisions[index]["diff"].as_array().unwrap().iter().map(|d| d["field"].as_str().unwrap().to_string()).collect::<Vec<_>>();
        assert_eq!(fields(0), vec!["instructions", "model"], "the restore brings the instructions and the model back");
        assert_eq!(revisions[1]["diff"][0]["kind"], "removed");
        assert_eq!(fields(2), vec!["instructions", "model"], "revision 1 is against an empty setup");
        assert_eq!(revisions[2]["diff"][0]["kind"], "added");
    }

    #[tokio::test]
    async fn restoring_a_revision_that_names_a_deleted_entry_is_refused() {
        let Some(pg) = postgres("restoring_a_revision_that_names_a_deleted_entry_is_refused") else { return };
        let store = pg.store("restore_gone").await;
        let (app, _) = with_agent(&store, Role::Editor).await;
        send(&app, "PUT", "/catalog/docs", Some(json!({"baseRevision": 0, "entry": MCP("docs", "npx")})), WRITE).await;
        send(&app, "PUT", "/agents/pi-agent/setup", Some(json!({"baseRevision": 0, "form": {"mcp": ["docs"]}})), WRITE).await;
        let (status, answer, _) = send(&app, "DELETE", "/catalog/docs", None, WRITE).await;
        assert_eq!((status, answer["code"].as_str(), answer["usedBy"].clone()), (S::CONFLICT, Some("in_use"), json!(["pi-agent"])));
        send(&app, "DELETE", "/agents/pi-agent/setup", None, WRITE).await;
        assert_eq!(send(&app, "DELETE", "/catalog/docs", None, WRITE).await.0, S::NO_CONTENT);
        let (status, answer, _) = send(&app, "POST", "/agents/pi-agent/revisions/1/restore", None, WRITE).await;
        assert_eq!((status, answer["field"].as_str()), (S::UNPROCESSABLE_ENTITY, Some("mcp")), "{answer}");
    }

    #[tokio::test]
    async fn the_catalog_refuses_secret_values_and_plain_downloads_and_keeps_a_log() {
        let Some(pg) = postgres("the_catalog_refuses_secret_values_and_plain_downloads_and_keeps_a_log") else { return };
        let store = pg.store("catalog_api").await;
        let app = app_as(&store, Role::Editor).await;
        let put = |entry: Value, base: u64| Some(json!({"baseRevision": base, "entry": entry}));
        let mut leaking = MCP("gh", "npx");
        leaking["env"] = json!({"GITHUB_TOKEN": "ghp_abcdefghijklmnopqrstuvwxyz0123456789"});
        let (status, answer, _) = send(&app, "PUT", "/catalog/gh", put(leaking, 0), WRITE).await;
        assert_eq!((status, answer["code"].as_str(), answer["field"].as_str()), (S::UNPROCESSABLE_ENTITY, Some("invalid"), Some("entry.env.GITHUB_TOKEN")));
        assert!(!answer.to_string().contains("ghp_"), "the answer never repeats the value");
        let mut plain = MCP("local", "${LOCAL}");
        plain["downloads"] = json!({"linux": {"url": "http://example.com/x", "sha256": "ab".repeat(32), "archive": "none", "executable": "x"}});
        assert_eq!(send(&app, "PUT", "/catalog/local", put(plain.clone(), 0), WRITE).await.0, S::UNPROCESSABLE_ENTITY);
        plain["downloads"]["linux"]["url"] = json!("https://example.com/x");
        plain["downloads"]["linux"]["sha256"] = json!("");
        assert_eq!(send(&app, "PUT", "/catalog/local", put(plain.clone(), 0), WRITE).await.0, S::UNPROCESSABLE_ENTITY, "a checksum is required");
        plain["downloads"]["linux"]["sha256"] = json!("ab".repeat(32));
        assert_eq!(send(&app, "PUT", "/catalog/local", put(plain, 0), WRITE).await.0, S::OK);
        assert_eq!(send(&app, "PUT", "/catalog/other", put(MCP("docs", "npx"), 0), WRITE).await.0, S::UNPROCESSABLE_ENTITY, "the name in the body must be the name in the address");
        assert_eq!(send(&app, "PUT", "/catalog/Bad_Name", put(MCP("Bad_Name", "npx"), 0), WRITE).await.0, S::UNPROCESSABLE_ENTITY);
        let (status, view, _) = send(&app, "PUT", "/catalog/docs", put(MCP("docs", "npx"), 0), WRITE).await;
        assert_eq!((status, view["revision"].as_u64(), view["updatedBy"].as_str()), (S::OK, Some(1), Some("editor@example.com")));
        let (status, _, _) = send(&app, "PUT", "/catalog/docs", put(MCP("docs", "uvx"), 0), WRITE).await;
        assert_eq!(status, S::CONFLICT, "a stale base is a conflict here too");
        send(&app, "PUT", "/catalog/docs", put(MCP("docs", "uvx"), 1), WRITE).await;
        let (_, log, _) = send(&app, "GET", "/catalog/docs/revisions", None, &[]).await;
        assert_eq!(log["revisions"][0]["revision"], 2);
        assert_eq!(log["revisions"][0]["diff"][0]["field"], "entry.command");
        assert_eq!(send(&app, "GET", "/catalog/ghost", None, &[]).await.0, S::NOT_FOUND);
        let (_, list, _) = send(&app, "GET", "/catalog", None, &[]).await;
        assert_eq!(list["entries"].as_array().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn the_library_computes_the_checksum_and_description_and_caps_the_size() {
        let Some(pg) = postgres("the_library_computes_the_checksum_and_description_and_caps_the_size") else { return };
        let store = pg.store("library_api").await;
        let app = app_as(&store, Role::Editor).await;
        let content = "---\nname: review\ndescription: Reviews a pull request\n---\n# Review\n";
        let (status, view, _) = send(&app, "PUT", "/library/review", Some(json!({"baseVersion": 0, "content": content})), WRITE).await;
        assert_eq!(status, S::OK, "{view}");
        assert_eq!((view["version"].as_u64(), view["description"].as_str(), view["sizeBytes"].as_u64()), (Some(1), Some("Reviews a pull request"), Some(content.len() as u64)));
        assert_eq!(view["sha256"], crate::ops::contract::sha256_hex(content.as_bytes()));
        let (_, detail, _) = send(&app, "GET", "/library/review", None, &[]).await;
        assert_eq!(detail["content"], content);
        let big = "x".repeat(64 * 1024 + 1);
        let (status, answer, _) = send(&app, "PUT", "/library/big", Some(json!({"baseVersion": 0, "content": big})), WRITE).await;
        assert_eq!((status, answer["field"].as_str()), (S::UNPROCESSABLE_ENTITY, Some("content")));
        assert_eq!(send(&app, "PUT", "/library/BAD", Some(json!({"baseVersion": 0, "content": "x"})), WRITE).await.0, S::UNPROCESSABLE_ENTITY);
        let (_, edited, _) = send(&app, "PUT", "/library/review", Some(json!({"baseVersion": 1, "content": format!("{content}more\n")})), WRITE).await;
        assert_eq!(edited["version"], 2);
        let (_, log, _) = send(&app, "GET", "/library/review/revisions", None, &[]).await;
        assert_eq!(log["revisions"].as_array().unwrap().len(), 2);
        assert_eq!(log["revisions"][0]["diff"][0]["lines"].as_array().unwrap().iter().filter(|l| l["op"] == "add").count(), 1);
        assert_eq!(send(&app, "DELETE", "/library/review", None, WRITE).await.0, S::NO_CONTENT);
        assert_eq!(send(&app, "GET", "/library/review", None, &[]).await.0, S::NOT_FOUND);
    }

    #[tokio::test]
    async fn limits_users_and_audit_work_for_an_admin() {
        let Some(pg) = postgres("limits_users_and_audit_work_for_an_admin") else { return };
        let store = pg.store("admin_api").await;
        let app = app_as(&store, Role::Admin).await;
        let values = json!({"maxTokensCap": 500000, "maxMinutesCap": 60, "dailyTokenLimit": 5000000, "budgetRaiseCeiling": 1000000});
        let (status, saved, _) = send(&app, "PUT", "/limits", Some(json!({"baseRevision": 0, "values": values, "note": "initial"})), WRITE).await;
        assert_eq!((status, saved["revision"].as_u64()), (S::OK, Some(1)));
        let (status, answer, _) = send(&app, "PUT", "/limits", Some(json!({"baseRevision": 1, "values": {"maxTokensCap": 0, "maxMinutesCap": 1, "dailyTokenLimit": 1, "budgetRaiseCeiling": 1}})), WRITE).await;
        assert_eq!((status, answer["field"].as_str()), (S::UNPROCESSABLE_ENTITY, Some("values.maxTokensCap")));
        assert_eq!(send(&app, "PUT", "/limits", Some(json!({"baseRevision": 0, "values": values})), WRITE).await.0, S::CONFLICT);
        let mut changed = values.clone();
        changed["maxMinutesCap"] = json!(90);
        send(&app, "PUT", "/limits", Some(json!({"baseRevision": 1, "values": changed})), WRITE).await;
        let (_, log, _) = send(&app, "GET", "/limits/revisions", None, &[]).await;
        assert_eq!((log["revisions"][0]["diff"][0]["field"].as_str(), log["revisions"][0]["diff"][0]["after"].as_str()), (Some("limits.maxMinutesCap"), Some("90")));
        let (_, view, _) = send(&app, "GET", "/limits", None, &[]).await;
        assert_eq!(view["current"]["revision"], 2);
        let (status, user, _) = send(&app, "PUT", "/users/New.Person@Example.com", Some(json!({"role": "editor"})), WRITE).await;
        assert_eq!((status, user["email"].as_str(), user["role"].as_str(), user["addedBy"].as_str()), (S::OK, Some("new.person@example.com"), Some("editor"), Some("admin@example.com")));
        assert_eq!(send(&app, "PUT", "/users/not-an-email", Some(json!({"role": "viewer"})), WRITE).await.0, S::UNPROCESSABLE_ENTITY);
        assert_eq!(send(&app, "PUT", "/users/x@example.com", Some(json!({"role": "root"})), WRITE).await.0, S::BAD_REQUEST);
        let (_, users, _) = send(&app, "GET", "/users", None, &[]).await;
        assert_eq!(users["users"].as_array().unwrap().len(), 1);
        assert_eq!(send(&app, "DELETE", "/users/new.person@example.com", None, WRITE).await.0, S::NO_CONTENT);
        assert_eq!(send(&app, "DELETE", "/users/new.person@example.com", None, WRITE).await.0, S::NOT_FOUND);
        let (_, audit, _) = send(&app, "GET", "/audit?limit=3", None, &[]).await;
        let entries = audit["entries"].as_array().unwrap();
        assert_eq!(entries.len(), 3);
        assert_eq!((entries[0]["action"].as_str(), entries[0]["actor"].as_str()), (Some("user.delete"), Some("admin@example.com")));
        assert!(entries[0]["id"].as_u64() > entries[1]["id"].as_u64());
    }

    #[tokio::test]
    async fn the_last_administrator_cannot_be_removed() {
        let Some(pg) = postgres("the_last_administrator_cannot_be_removed") else { return };
        let store = pg.store("last_admin").await;
        store.put_user("admin@example.com", Role::Admin, "OPERATIONS_FIRST_ADMIN").await.unwrap();
        let app = app_as(&store, Role::Admin).await;
        let (status, answer, _) = send(&app, "DELETE", "/users/admin@example.com", None, WRITE).await;
        assert_eq!((status, answer["code"].as_str()), (S::CONFLICT, Some("last_admin")));
        assert_eq!(send(&app, "PUT", "/users/admin@example.com", Some(json!({"role": "viewer"})), WRITE).await.0, S::CONFLICT);
    }

    #[tokio::test]
    async fn the_agent_list_and_detail_combine_the_stored_setup_with_what_the_agent_reports() {
        let Some(pg) = postgres("the_agent_list_and_detail_combine_the_stored_setup_with_what_the_agent_reports") else { return };
        let store = pg.store("agents_api").await;
        let (target, profile_slot) = fake_agent("agent/pi-agent", Some(profile("developer", Some(1), None))).await;
        let (down, _) = fake_agent("agent/qa", None).await;
        let ops = stub_ops(&store, Role::Editor, None, vec![target, down]);
        let app = router(ops.clone());
        send(&app, "PUT", "/agents/pi-agent/setup", Some(json!({"baseRevision": 0, "form": {"instructions": "one"}})), WRITE).await;
        send(&app, "PUT", "/agents/pi-agent/setup", Some(json!({"baseRevision": 1, "form": {"instructions": "two"}})), WRITE).await;
        ops.reconciler.tick().await;
        let (_, list, _) = send(&app, "GET", "/agents", None, &[]).await;
        let agents = list["agents"].as_array().unwrap();
        assert_eq!(agents.iter().map(|a| a["slug"].as_str().unwrap()).collect::<Vec<_>>(), vec!["pi-agent", "qa"]);
        let pi = &agents[0];
        assert_eq!((pi["id"].as_str(), pi["role"].as_str(), pi["reachable"].as_bool(), pi["savedRevision"].as_u64(), pi["appliedRevision"].as_u64(), pi["pending"].as_bool()), (Some("agent/pi-agent"), Some("developer"), Some(true), Some(2), Some(1), Some(true)));
        assert_eq!((agents[1]["reachable"].as_bool(), agents[1]["savedRevision"].as_u64()), (Some(false), Some(0)));
        assert_eq!(list["sendingConfigured"], false);
        *profile_slot.lock().unwrap() = Some(profile("developer", Some(2), Some(1)));
        ops.reconciler.tick().await;
        let (_, detail, _) = send(&app, "GET", "/agents/pi-agent", None, &[]).await;
        assert_eq!((detail["agent"]["appliedRevision"].as_u64(), detail["agent"]["pending"].as_bool(), detail["form"]["instructions"].as_str(), detail["revision"]["revision"].as_u64()), (Some(2), Some(false), Some("two"), Some(2)));
        assert_eq!((detail["reported"]["overrideRevision"].as_u64(), detail["reported"]["limitsRevision"].as_u64()), (Some(2), Some(1)));
        assert!(detail["roleDefaults"].is_null(), "an agent with an override applied and no `defaults` in its profile has no role defaults to show");
    }

    #[tokio::test]
    async fn routes_of_an_unconfigured_server_answer_503_and_unknown_routes_404() {
        let off = off_router();
        let (status, answer, _) = send(&off, "GET", "/agents", None, &[]).await;
        assert_eq!((status, answer["code"].as_str()), (S::SERVICE_UNAVAILABLE, Some("unavailable")));
        let Some(pg) = postgres("routes_of_an_unconfigured_server_answer_503_and_unknown_routes_404") else { return };
        let store = pg.store("unknown").await;
        let app = app_as(&store, Role::Admin).await;
        assert_eq!(send(&app, "GET", "/nothing", None, &[]).await.0, S::NOT_FOUND);
    }

    // ---------------------------------------------------------------------------------------------------------- Entra

    struct FakeIdp {
        base: String,
        keys: Arc<TestIdp>,
        token: Arc<std::sync::Mutex<Option<String>>>,
        challenge_check: Arc<std::sync::Mutex<Vec<(String, String)>>>,
    }

    async fn fake_idp() -> FakeIdp {
        use axum::{Form, routing::post};
        let keys = Arc::new(TestIdp::new("kid-1"));
        let token = Arc::new(std::sync::Mutex::new(None::<String>));
        let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let (jwks_keys, token_slot, token_seen, root) = (keys.clone(), token.clone(), seen.clone(), base.clone());
        let app = Router::new()
            .route("/.well-known/openid-configuration", get({
                let root = root.clone();
                move || {
                    let root = root.clone();
                    async move { Json(json!({"issuer": root, "authorization_endpoint": format!("{root}/authorize"), "token_endpoint": format!("{root}/token"), "jwks_uri": format!("{root}/keys")})) }
                }
            }))
            .route("/keys", get(move || {
                let keys = jwks_keys.clone();
                async move { let jwk = keys.jwk(); Json(json!({"keys": [{"kty": jwk.kty, "kid": jwk.kid, "n": jwk.n, "e": jwk.e, "use": "sig"}]})) }
            }))
            .route("/token", post(move |Form(form): Form<std::collections::HashMap<String, String>>| {
                let (token, seen) = (token_slot.clone(), token_seen.clone());
                async move {
                    seen.lock().unwrap().push((form.get("code_verifier").cloned().unwrap_or_default(), form.get("client_secret").cloned().unwrap_or_default()));
                    match token.lock().unwrap().clone() {
                        Some(id_token) if form.get("grant_type").map(String::as_str) == Some("authorization_code") && form.get("code").map(String::as_str) == Some("the-code") => (S::OK, Json(json!({"id_token": id_token, "access_token": "unused"}))),
                        _ => (S::BAD_REQUEST, Json(json!({"error": "invalid_grant"}))),
                    }
                }
            }));
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        FakeIdp { base, keys, token, challenge_check: seen }
    }

    fn query_of(location: &str, name: &str) -> String {
        reqwest::Url::parse(location).unwrap().query_pairs().find(|(key, _)| key == name).map(|(_, value)| value.to_string()).unwrap_or_default()
    }

    async fn entra_app(store: &crate::ops::store::Store, idp: &FakeIdp) -> (Router, Router) {
        let config = OidcConfig { issuer: idp.base.clone(), client_id: "client-1".into(), client_secret: "the-client-secret".into(), redirect_url: "http://ops.test/fleet/auth/callback".into() };
        let ops = ops_with(store, crate::ops::AuthMode::Entra(Box::new(Oidc::new(config, true).unwrap())), None, vec![]);
        (router(ops.clone()), auth_router(ops))
    }

    #[tokio::test]
    async fn the_sign_in_flow_uses_pkce_checks_the_token_and_the_allow_list() {
        let Some(pg) = postgres("the_sign_in_flow_uses_pkce_checks_the_token_and_the_allow_list") else { return };
        let store = pg.store("entra").await;
        store.put_user("jane@example.com", Role::Editor, "OPERATIONS_FIRST_ADMIN").await.unwrap();
        let idp = fake_idp().await;
        let (api, auth) = entra_app(&store, &idp).await;

        let (status, body, _) = send(&api, "GET", "/me", None, &[]).await;
        assert_eq!((status, body["code"].as_str(), body["login"].as_str()), (S::UNAUTHORIZED, Some("not_signed_in"), Some("/fleet/auth/login")));

        let begin = || async {
            let (status, _, headers) = send(&auth, "GET", "/login?next=/fleet/%23agents", None, &[]).await;
            assert_eq!(status, S::FOUND);
            let location = headers.get("location").unwrap().to_str().unwrap().to_string();
            let cookie = headers.get("set-cookie").unwrap().to_str().unwrap().to_string();
            (location, cookie)
        };
        let (location, login_cookie) = begin().await;
        assert!(location.starts_with(&format!("{}/authorize?", idp.base)), "{location}");
        let (state, nonce, challenge) = (query_of(&location, "state"), query_of(&location, "nonce"), query_of(&location, "code_challenge"));
        assert_eq!((query_of(&location, "client_id").as_str(), query_of(&location, "response_type").as_str(), query_of(&location, "code_challenge_method").as_str()), ("client-1", "code", "S256"));
        assert_eq!(query_of(&location, "redirect_uri"), "http://ops.test/fleet/auth/callback");
        for flag in ["HttpOnly", "Secure", "SameSite=Lax", "__Host-ops_login="] {
            assert!(login_cookie.contains(flag), "{login_cookie}");
        }
        let login_value = cookie_value(&login_cookie, "__Host-ops_login").unwrap();
        let with_login = format!("__Host-ops_login={login_value}");
        let now = chrono::Utc::now().timestamp();

        // someone else's browser: no login cookie, or the wrong state
        let callback = format!("/callback?code=the-code&state={state}");
        *idp.token.lock().unwrap() = Some(idp.keys.good_for(&idp.base, "client-1", now, "jane@example.com", &nonce));
        assert_eq!(send(&auth, "GET", &callback, None, &[]).await.0, S::FORBIDDEN);
        assert_eq!(send(&auth, "GET", "/callback?code=the-code&state=wrong", None, &[("cookie", &with_login)]).await.0, S::FORBIDDEN);
        assert_eq!(send(&auth, "GET", &format!("/callback?error=access_denied&state={state}"), None, &[("cookie", &with_login)]).await.0, S::FORBIDDEN);
        // a token for another nonce, another audience, or one that expired
        for bad in [idp.keys.good_for(&idp.base, "client-1", now, "jane@example.com", "other-nonce"), idp.keys.good_for(&idp.base, "someone-elses-client", now, "jane@example.com", &nonce), idp.keys.good_for(&idp.base, "client-1", now - 7200, "jane@example.com", &nonce), idp.keys.good_for("http://evil.example", "client-1", now, "jane@example.com", &nonce)] {
            *idp.token.lock().unwrap() = Some(bad);
            let (status, _, headers) = send(&auth, "GET", &callback, None, &[("cookie", &with_login)]).await;
            assert_eq!(status, S::FORBIDDEN);
            assert!(headers.get_all("set-cookie").iter().all(|c| !c.to_str().unwrap().contains("ops_session=") || c.to_str().unwrap().contains("Max-Age=0")), "no session is issued");
        }

        // the real thing
        *idp.token.lock().unwrap() = Some(idp.keys.good_for(&idp.base, "client-1", now, "Jane@Example.com", &nonce));
        let (status, _, headers) = send(&auth, "GET", &callback, None, &[("cookie", &with_login)]).await;
        assert_eq!((status, headers.get("location").unwrap().to_str().unwrap()), (S::FOUND, "/fleet/#agents"));
        let session = headers.get_all("set-cookie").iter().map(|c| c.to_str().unwrap().to_string()).find(|c| c.starts_with("__Host-ops_session=") && !c.contains("Max-Age=0")).expect("a session cookie");
        for flag in ["HttpOnly", "Secure", "SameSite=Lax", "Path=/"] {
            assert!(session.contains(flag), "{session}");
        }
        let verifier_and_secret = idp.challenge_check.lock().unwrap().last().cloned().unwrap();
        assert_eq!(crate::ops::oidc::code_challenge(&verifier_and_secret.0), challenge, "the verifier sent to the token endpoint matches the challenge sent to the authorize endpoint");
        assert_eq!(verifier_and_secret.1, "the-client-secret");
        let cookie = format!("__Host-ops_session={}", cookie_value(&session, "__Host-ops_session").unwrap());
        let (status, me, _) = send(&api, "GET", "/me", None, &[("cookie", &cookie)]).await;
        assert_eq!((status, me["email"].as_str(), me["role"].as_str(), me["auth"].as_str()), (S::OK, Some("jane@example.com"), Some("editor"), Some("entra")));
        assert_eq!(send(&api, "PUT", "/limits", Some(json!({"baseRevision": 0, "values": {"maxTokensCap": 1, "maxMinutesCap": 1, "dailyTokenLimit": 1, "budgetRaiseCeiling": 1}})), &[("cookie", &cookie), ("x-operations-request", "1")]).await.0, S::FORBIDDEN, "her role comes from the table");

        // a cookie of someone's making, or an edited one, is not a session
        assert_eq!(send(&api, "GET", "/me", None, &[("cookie", "__Host-ops_session=eyJlbWFpbCI6ImFAYiJ9.AAAA")]).await.0, S::UNAUTHORIZED);
        let mut parts = cookie.splitn(2, '.');
        let forged = format!("{}.{}", crate::ops::testing::forged_payload("admin@example.com"), parts.nth(1).unwrap());
        assert_eq!(send(&api, "GET", "/me", None, &[("cookie", &format!("__Host-ops_session={forged}"))]).await.0, S::UNAUTHORIZED);

        // removed from the allow list: the very next request is refused
        store.put_user("keeper@example.com", Role::Admin, "x").await.unwrap();
        store.delete_user("jane@example.com", "keeper@example.com").await.unwrap();
        let (status, body, _) = send(&api, "GET", "/me", None, &[("cookie", &cookie)]).await;
        assert_eq!((status, body["code"].as_str()), (S::FORBIDDEN, Some("forbidden")));

        // signed in at the identity provider but not on the list: refused, and the audit log says who tried
        let (location, login_cookie) = begin().await;
        let (state, nonce) = (query_of(&location, "state"), query_of(&location, "nonce"));
        *idp.token.lock().unwrap() = Some(idp.keys.good_for(&idp.base, "client-1", now, "stranger@example.com", &nonce));
        let with_login = format!("__Host-ops_login={}", cookie_value(&login_cookie, "__Host-ops_login").unwrap());
        let (status, _, headers) = send(&auth, "GET", &format!("/callback?code=the-code&state={state}"), None, &[("cookie", &with_login)]).await;
        assert_eq!(status, S::FORBIDDEN);
        assert!(headers.get_all("set-cookie").iter().all(|c| !c.to_str().unwrap().starts_with("__Host-ops_session=") || c.to_str().unwrap().contains("Max-Age=0")));
        let audit = store.audit_page(10, None).await.unwrap();
        assert!(audit.entries.iter().any(|e| e.action == "signin.refused" && e.target == "stranger@example.com"));
        assert!(audit.entries.iter().any(|e| e.action == "signin" && e.target == "jane@example.com"));
    }

    #[tokio::test]
    async fn logout_clears_the_session_and_needs_the_header() {
        let Some(pg) = postgres("logout_clears_the_session_and_needs_the_header") else { return };
        let store = pg.store("logout").await;
        let idp = fake_idp().await;
        let (_, auth) = entra_app(&store, &idp).await;
        assert_eq!(send(&auth, "POST", "/logout", None, &[]).await.0, S::FORBIDDEN);
        let (status, _, headers) = send(&auth, "POST", "/logout", None, WRITE).await;
        assert_eq!(status, S::NO_CONTENT);
        assert!(headers.get("set-cookie").unwrap().to_str().unwrap().contains("Max-Age=0"));
    }

    #[tokio::test]
    async fn the_stub_signs_everybody_in_as_one_user() {
        let Some(pg) = postgres("the_stub_signs_everybody_in_as_one_user") else { return };
        let store = pg.store("stub").await;
        let app = app_as(&store, Role::Admin).await;
        let (status, me, _) = send(&app, "GET", "/me", None, &[]).await;
        assert_eq!((status, me["email"].as_str(), me["auth"].as_str()), (S::OK, Some("admin@example.com"), Some("stub")));
    }

    // -------------------------------------------------------------------------------------------- save to delivery

    #[tokio::test]
    async fn a_save_is_delivered_to_the_agent_with_the_catalog_and_library_resolved_at_that_moment() {
        let Some(pg) = postgres("a_save_is_delivered_to_the_agent_with_the_catalog_and_library_resolved_at_that_moment") else { return };
        let store = pg.store("end_to_end").await;
        let (base, domain) = fake_domain().await;
        let (target, profile_slot) = fake_agent("agent/pi-agent", Some(profile("developer", None, None))).await;
        let ops = stub_ops(&store, Role::Editor, Some(Arc::new(deliverer(&base))), vec![target]);
        let app = router(ops.clone());
        send(&app, "PUT", "/catalog/docs", Some(json!({"baseRevision": 0, "entry": MCP("docs", "npx")})), WRITE).await;
        send(&app, "PUT", "/library/review", Some(json!({"baseVersion": 0, "content": "---\ndescription: Reviews\n---\nv1"})), WRITE).await;
        send(&app, "PUT", "/agents/pi-agent/setup", Some(json!({"baseRevision": 0, "form": {"instructions": "Be brief", "mcp": ["docs"], "librarySkills": ["review"]}})), WRITE).await;
        ops.reconciler.tick().await;
        {
            let uploads = domain.uploads.lock().unwrap();
            assert_eq!(uploads.len(), 1);
            let document: Value = serde_json::from_slice(&uploads[0].1).unwrap();
            assert_eq!((document["kind"].as_str(), document["agent"].as_str(), document["revision"].as_u64(), document["instructions"].as_str()), (Some("override"), Some("agent/pi-agent"), Some(1), Some("Be brief")));
            assert_eq!(document["mcp"][0]["name"], "docs");
            assert_eq!((document["skills"]["library"][0]["name"].as_str(), document["skills"]["library"][0]["version"].as_u64()), (Some("review"), Some(1)));
            assert_eq!(document["skills"]["library"][0]["content"], "---\ndescription: Reviews\n---\nv1");
        }
        // editing the skill revises the agent (revision 2) and the new text is what goes out
        send(&app, "PUT", "/library/review", Some(json!({"baseVersion": 1, "content": "---\ndescription: Reviews\n---\nv2"})), WRITE).await;
        *profile_slot.lock().unwrap() = Some(profile("developer", Some(1), None));
        ops.reconciler.tick().await;
        {
            let uploads = domain.uploads.lock().unwrap();
            assert_eq!(uploads.len(), 2);
            let document: Value = serde_json::from_slice(&uploads[1].1).unwrap();
            assert_eq!((document["revision"].as_u64(), document["skills"]["library"][0]["version"].as_u64(), document["skills"]["library"][0]["content"].as_str()), (Some(2), Some(2), Some("---\ndescription: Reviews\n---\nv2")));
            assert_eq!(document["savedBy"], "editor@example.com");
        }
        let (_, list, _) = send(&app, "GET", "/agents", None, &[]).await;
        assert_eq!(list["agents"][0]["overrideDelivery"]["sentRevision"], 2);
        assert_eq!(list["sendingConfigured"], true);
    }
}

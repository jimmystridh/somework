//! Administration of trust-domain federation and A2A interoperability (peers, exports, credentials, imports).

use axum::{
    Router,
    extract::{Path, State},
    routing::{get, post, put},
};
use serde::Deserialize;
use serde_json::{Value, json};
use somework_core::{
    Error,
    contracts::{ActorKind, TrustTier},
    jws,
};
use somework_domain::{auth::CreatePrincipal, policy::Permissions};
use somework_gateway::{AddPeer, GatewayAdmin, PeerKey, PeerPolicy, PeerStatus};

use crate::{http::*, state::AppState};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/v1/admin/federation/identity", get(identity))
        .route("/v1/admin/federation/thumbprint", post(thumbprint))
        .route("/v1/admin/federation/peers", post(add_peer).get(list_peers))
        .route("/v1/admin/federation/peers/{peer}", get(get_peer))
        .route("/v1/admin/federation/peers/{peer}/policy", put(set_policy))
        .route("/v1/admin/federation/peers/{peer}/status", post(set_status))
        .route("/v1/admin/federation/peers/{peer}/revoke", post(revoke))
        .route("/v1/admin/federation/peers/{peer}/keys", post(rotate_keys))
        .route("/v1/admin/federation/peers/{peer}/certificates", put(set_certificates))
        .route("/v1/admin/federation/peers/{peer}/gateway", put(set_gateway))
        .route("/v1/admin/federation/peers/{peer}/import-catalog", post(import_catalog))
        .route("/v1/admin/federation/a2a/import", post(import_a2a))
        .route("/v1/admin/federation/a2a/credentials", put(set_a2a_credential))
        .route("/v1/admin/federation/a2a/clients", post(create_a2a_client))
}

fn admin(s: &AppState) -> Result<&GatewayAdmin, ApiError> {
    s.gateway.as_deref().ok_or_else(|| ApiError(Error::not_found("federation gateway (not configured)")))
}

async fn identity(State(s): State<AppState>, Auth(ctx): Auth) -> ApiResult {
    let g = admin(&s)?;
    g.domain.enforce_read(&ctx, somework_domain::policy::AuthzRequest::new("federation.manage")).await?;
    ok(g.identity().await?)
}

#[derive(Deserialize)]
struct PemBody {
    pem: String,
}

async fn thumbprint(Auth(_ctx): Auth, Body(b): Body<PemBody>) -> ApiResult {
    ok(json!({"sha256": somework_gateway::tls::thumbprint_of_pem(&b.pem)?}))
}

async fn add_peer(State(s): State<AppState>, Auth(ctx): Auth, Body(req): Body<AddPeer>) -> ApiResult {
    created(admin(&s)?.peers.add(&ctx, req).await?)
}

async fn list_peers(State(s): State<AppState>, Auth(ctx): Auth) -> ApiResult {
    let g = admin(&s)?;
    g.domain.enforce_read(&ctx, somework_domain::policy::AuthzRequest::new("federation.manage")).await?;
    ok(json!({"peers": g.peers.list().await?}))
}

async fn get_peer(State(s): State<AppState>, Auth(ctx): Auth, Path(peer): Path<String>) -> ApiResult {
    let g = admin(&s)?;
    g.domain.enforce_read(&ctx, somework_domain::policy::AuthzRequest::new("federation.manage")).await?;
    ok(g.peers.get(&peer).await?.ok_or_else(|| Error::not_found("peer"))?)
}

async fn set_policy(State(s): State<AppState>, Auth(ctx): Auth, Path(peer): Path<String>, Body(policy): Body<PeerPolicy>) -> ApiResult {
    ok(admin(&s)?.peers.set_policy(&ctx, &peer, policy).await?)
}

#[derive(Deserialize)]
struct StatusBody {
    status: PeerStatus,
}

async fn set_status(State(s): State<AppState>, Auth(ctx): Auth, Path(peer): Path<String>, Body(b): Body<StatusBody>) -> ApiResult {
    ok(admin(&s)?.peers.set_status(&ctx, &peer, b.status).await?)
}

async fn revoke(State(s): State<AppState>, Auth(ctx): Auth, Path(peer): Path<String>) -> ApiResult {
    ok(admin(&s)?.peers.revoke(&ctx, &peer).await?)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct KeyBody {
    kid: String,
    public_key: String,
    #[serde(default)]
    retire_others: bool,
}

async fn rotate_keys(State(s): State<AppState>, Auth(ctx): Auth, Path(peer): Path<String>, Body(b): Body<KeyBody>) -> ApiResult {
    ok(admin(&s)?.peers.rotate_keys(&ctx, &peer, PeerKey { kid: b.kid, public_key: b.public_key, status: "active".into() }, b.retire_others).await?)
}

#[derive(Deserialize)]
struct CertsBody {
    thumbprints: Vec<String>,
}

async fn set_certificates(State(s): State<AppState>, Auth(ctx): Auth, Path(peer): Path<String>, Body(b): Body<CertsBody>) -> ApiResult {
    ok(admin(&s)?.peers.set_client_certificates(&ctx, &peer, b.thumbprints).await?)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GatewayBody {
    url: Option<String>,
    server_ca_pem: Option<String>,
}

async fn set_gateway(State(s): State<AppState>, Auth(ctx): Auth, Path(peer): Path<String>, Body(b): Body<GatewayBody>) -> ApiResult {
    ok(admin(&s)?.peers.set_gateway(&ctx, &peer, b.url, b.server_ca_pem).await?)
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct ImportBody {
    query: Option<String>,
    approve: bool,
}

async fn import_catalog(State(s): State<AppState>, Auth(ctx): Auth, Path(peer): Path<String>, Body(b): Body<ImportBody>) -> ApiResult {
    let g = admin(&s)?;
    ok(json!({"entries": somework_gateway::catalog_import::import_peer_catalog(&g.domain, &g.client, &ctx, &peer, b.query.as_deref(), b.approve).await?}))
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct A2aImportBody {
    /// URL of the agent card (`…/.well-known/agent-card.json`); alternatively pass `card` inline.
    url: Option<String>,
    card: Option<Value>,
    approve: bool,
}

async fn import_a2a(State(s): State<AppState>, Auth(ctx): Auth, Body(b): Body<A2aImportBody>) -> ApiResult {
    let g = admin(&s)?;
    let (card, source) = match (&b.card, &b.url) {
        (Some(c), u) => (c.clone(), u.clone().unwrap_or_else(|| "inline".into())),
        (None, Some(u)) => (somework_gateway::a2a::client::fetch_card(u).await?, u.clone()),
        _ => return Err(Error::invalid("url or card is required").into()),
    };
    created(somework_gateway::a2a::client::import_agent_card(&g.domain, &ctx, &card, &source, b.approve).await?)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct A2aCredentialBody {
    origin: String,
    scheme: String,
    secret: String,
    issuer: Option<String>,
    audience: Option<String>,
}

async fn set_a2a_credential(State(s): State<AppState>, Auth(ctx): Auth, Body(b): Body<A2aCredentialBody>) -> ApiResult {
    let g = admin(&s)?;
    g.domain.enforce_read(&ctx, somework_domain::policy::AuthzRequest::new("federation.manage")).await?;
    somework_gateway::a2a::client::set_credential(&g.domain, &b.origin, &b.scheme, &b.secret, b.issuer.as_deref(), b.audience.as_deref()).await?;
    ok(json!({"origin": b.origin, "scheme": b.scheme}))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct A2aClientBody {
    name: String,
    /// Capability id patterns the external client may discover and invoke (exported capabilities only).
    exports: Vec<String>,
    classification_max: Option<String>,
    side_effects_at_most: Option<somework_core::contracts::SideEffects>,
}

/// Enrols an external A2A caller as a tightly scoped service principal and returns its key (shown once).
async fn create_a2a_client(State(s): State<AppState>, Auth(ctx): Auth, Body(b): Body<A2aClientBody>) -> ApiResult {
    let g = admin(&s)?;
    let key = jws::new_signing_key();
    let perms = Permissions {
        actions: ["catalog.read", "task.submit", "task.read", "task.cancel", "artifact.read", "capability.invoke"].map(String::from).to_vec(),
        capabilities: b.exports.clone(),
        classification_max: Some(b.classification_max.unwrap_or_else(|| "public".into())),
        side_effects_at_most: Some(b.side_effects_at_most.unwrap_or(somework_core::contracts::SideEffects::Read)),
        ..Default::default()
    };
    let id = format!("a2a-client:{}", b.name);
    g.domain
        .create_principal(
            &ctx,
            CreatePrincipal {
                kind: ActorKind::Service,
                id: id.clone(),
                display_name: Some(b.name.clone()),
                permissions: Some(perms),
                public_key: Some(jws::verifying_key_to_b64(&key.verifying_key())),
                matrix_user_id: None,
                oidc_issuer: None,
                oidc_subject: None,
            },
        )
        .await?;
    created(
        json!({"issuer": format!("service:{id}"), "audience": format!("somework:{}", g.domain.domain_id()), "privateKey": jws::signing_key_to_b64(&key), "publicKey": jws::verifying_key_to_b64(&key.verifying_key()), "trustTier": TrustTier::External}),
    )
}

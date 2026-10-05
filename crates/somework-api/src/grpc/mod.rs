//! gRPC API (tonic). Same domain semantics as REST: every handler authenticates through the shared credential path,
//! builds the same request documents the REST routes deserialize, calls the same `Domain` method and renders the
//! result. No business logic lives here.

mod convert;
mod json;
mod services;
mod status;

use std::{net::SocketAddr, path::PathBuf};

use serde::Deserialize;
use somework_core::{Error, trace::TraceContext};
use somework_domain::Ctx;
use tokio_util::sync::CancellationToken;
use tonic::{Response, Status, metadata::MetadataMap};

use crate::{oidc::OidcVerifier, state::AppState};

pub use json::{json_to_struct, struct_to_json};
pub use status::{error_to_status, grpc_code};

/// Generated protobuf types and service stubs (`somework.v1`). Tests and external Rust clients use these.
pub mod pb {
    tonic::include_proto!("somework.v1");

    pub const FILE_DESCRIPTOR_SET: &[u8] = tonic::include_file_descriptor_set!("somework_descriptor");
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
pub struct GrpcTls {
    pub cert_path: PathBuf,
    pub key_path: PathBuf,
    /// When set, clients must present a certificate signed by this CA (mutual TLS).
    pub client_ca_path: Option<PathBuf>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct GrpcSection {
    pub listen: String,
    pub tls: Option<GrpcTls>,
    pub reflection: bool,
}

impl Default for GrpcSection {
    fn default() -> Self {
        Self { listen: "127.0.0.1:50051".into(), tls: None, reflection: true }
    }
}

pub struct RunningGrpc {
    pub addr: SocketAddr,
    pub handle: tokio::task::JoinHandle<()>,
}

/// Per-call context: credentials -> actor plus idempotency, revision and trace metadata.
pub(crate) async fn call_ctx(state: &AppState, md: &MetadataMap) -> Result<Ctx, Status> {
    let trace = md.get("traceparent").and_then(|v| v.to_str().ok()).and_then(TraceContext::parse).map(|t| t.child()).unwrap_or_else(TraceContext::new_root);
    let fail = |e: Error| error_to_status(&e, &trace);
    let auth = md.get("authorization").and_then(|v| v.to_str().ok()).ok_or_else(|| fail(Error::unauthenticated("missing authorization metadata")))?;
    let token =
        auth.strip_prefix("Bearer ").or_else(|| auth.strip_prefix("bearer ")).ok_or_else(|| fail(Error::unauthenticated("expected a Bearer token")))?.trim();
    let actor = authenticate_bearer(state, token).await.map_err(&fail)?;
    let mut ctx = Ctx::new(actor).with_trace(trace.clone()).with_transport("grpc");
    if let Some(key) = md.get("idempotency-key").and_then(|v| v.to_str().ok()) {
        if key.is_empty() || key.len() > 256 {
            return Err(fail(Error::invalid("idempotency-key must be 1-256 characters")));
        }
        ctx.idempotency_key = Some(key.to_string());
    }
    if let Some(m) = md.get("if-match").or_else(|| md.get("expected-revision")).and_then(|v| v.to_str().ok()) {
        let rev = m.trim().trim_matches('"');
        ctx.if_match = Some(rev.parse().map_err(|_| fail(Error::invalid("if-match must carry the task revision as an integer")))?);
    }
    Ok(ctx)
}

async fn authenticate_bearer(state: &AppState, token: &str) -> Result<somework_domain::Actor, Error> {
    if let Some(oidc) = state.oidc.as_ref().filter(|_| OidcVerifier::looks_like_oidc(token)) {
        let identity = oidc.verify(token).await?;
        state.domain.actor_for_oidc(&identity.issuer, &identity.subject).await
    } else {
        state.domain.authenticate(token, &somework_domain::auth::AuthMeta { transport: "grpc".into(), peer_cert_sha256: None }).await
    }
}

/// Wraps a message with the trace metadata every response carries.
pub(crate) fn respond<T>(ctx: &Ctx, message: T) -> Response<T> {
    let mut response = Response::new(message);
    status::attach_trace(response.metadata_mut(), &ctx.trace);
    response
}

pub(crate) fn fail(ctx: &Ctx, err: Error) -> Status {
    error_to_status(&err, &ctx.trace)
}

pub(crate) fn invalid(ctx: &Ctx, what: impl Into<String>) -> Status {
    fail(ctx, Error::invalid(what))
}

/// Binds and serves every service (plus health and reflection) until `shutdown` is cancelled.
pub async fn serve(state: AppState, section: &GrpcSection, shutdown: CancellationToken) -> Result<RunningGrpc, Error> {
    let addr: SocketAddr = section.listen.parse().map_err(|e| Error::invalid(format!("invalid grpc listen address: {e}")))?;
    let listener = tokio::net::TcpListener::bind(addr).await.map_err(|e| Error::internal(format!("bind grpc {addr}: {e}")))?;
    let local = listener.local_addr().map_err(|e| Error::internal(e.to_string()))?;

    let (reporter, health) = tonic_health::server::health_reporter();
    for name in
        ["CatalogService", "MessageService", "EventService", "TaskService", "ContextService", "ArtifactService", "SubscriptionService", "AuthorizationService"]
    {
        reporter.set_service_status(format!("somework.v1.{name}"), tonic_health::ServingStatus::Serving).await;
    }
    reporter.set_service_status("", tonic_health::ServingStatus::Serving).await;

    let mut builder = tonic::transport::Server::builder();
    if let Some(tls) = &section.tls {
        let read = |p: &PathBuf| std::fs::read(p).map_err(|e| Error::internal(format!("read {}: {e}", p.display())));
        let identity = tonic::transport::Identity::from_pem(read(&tls.cert_path)?, read(&tls.key_path)?);
        let mut cfg = tonic::transport::ServerTlsConfig::new().identity(identity);
        if let Some(ca) = &tls.client_ca_path {
            cfg = cfg.client_ca_root(tonic::transport::Certificate::from_pem(read(ca)?));
        }
        builder = builder.tls_config(cfg).map_err(|e| Error::internal(format!("grpc tls: {e}")))?;
    }
    let mut router = builder
        .add_service(health)
        .add_service(pb::catalog_service_server::CatalogServiceServer::new(services::Catalog(state.clone())))
        .add_service(pb::message_service_server::MessageServiceServer::new(services::Messages(state.clone())))
        .add_service(pb::event_service_server::EventServiceServer::new(services::Events(state.clone())))
        .add_service(pb::task_service_server::TaskServiceServer::new(services::Tasks(state.clone())))
        .add_service(pb::context_service_server::ContextServiceServer::new(services::Contexts(state.clone())))
        .add_service(pb::artifact_service_server::ArtifactServiceServer::new(services::Artifacts(state.clone())))
        .add_service(pb::subscription_service_server::SubscriptionServiceServer::new(services::Subscriptions(state.clone())))
        .add_service(pb::authorization_service_server::AuthorizationServiceServer::new(services::Authorization(state)));
    if section.reflection {
        let reflection = tonic_reflection::server::Builder::configure()
            .register_encoded_file_descriptor_set(pb::FILE_DESCRIPTOR_SET)
            .build_v1()
            .map_err(|e| Error::internal(format!("grpc reflection: {e}")))?;
        router = router.add_service(reflection);
    }
    let incoming = tokio_stream::wrappers::TcpListenerStream::new(listener);
    let handle = tokio::spawn(async move {
        if let Err(err) = router.serve_with_incoming_shutdown(incoming, async move { shutdown.cancelled().await }).await {
            tracing::error!(error = %err, "grpc server stopped");
        }
    });
    Ok(RunningGrpc { addr: local, handle })
}

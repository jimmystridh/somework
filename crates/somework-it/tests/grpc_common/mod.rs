#![allow(dead_code)]

use std::{sync::Arc, time::Duration};

use ed25519_dalek::SigningKey;
use serde_json::{Value, json};
use somework_api::grpc::{GrpcSection, pb};
use somework_core::{contracts::SideEffects, jws};
use somework_domain::policy::Permissions;
use somework_testkit::{Agent, Stack, StackBuilder, capability};
use tonic::{
    Code, Request, Status,
    service::{Interceptor, interceptor::InterceptedService},
    transport::Channel,
};
use tonic_types::StatusExt;

/// Mints a fresh workload assertion for every call, exactly like the SDK does for REST.
#[derive(Clone)]
pub struct Creds {
    pub key: Arc<SigningKey>,
    pub issuer: String,
    pub runtime: Option<String>,
}

impl Creds {
    pub fn agent(agent: &Agent) -> Self {
        Self { key: agent.key.clone(), issuer: format!("agent:{}", agent.id), runtime: agent.client.runtime_instance_id() }
    }

    pub fn admin(stack: &Stack) -> Self {
        Self { key: stack.admin_key.clone(), issuer: "service:root".into(), runtime: None }
    }

    pub fn token(&self) -> String {
        jws::mint_assertion(&self.key, &self.issuer, "somework:development", self.runtime.as_deref(), chrono::Utc::now(), chrono::Duration::seconds(120))
    }
}

impl Interceptor for Creds {
    fn call(&mut self, mut req: Request<()>) -> Result<Request<()>, Status> {
        req.metadata_mut().insert("authorization", format!("Bearer {}", self.token()).parse().unwrap());
        Ok(req)
    }
}

pub type Authed = InterceptedService<Channel, Creds>;

pub struct GrpcStack {
    pub stack: Stack,
    pub channel: Channel,
}

impl GrpcStack {
    pub async fn start() -> Self {
        let stack = StackBuilder::new().config(|c| c.grpc = Some(GrpcSection { listen: "127.0.0.1:0".into(), tls: None, reflection: true })).start().await;
        let addr = stack.runtime.grpc_addr.expect("grpc listener");
        let channel = Channel::from_shared(format!("http://{addr}")).unwrap().connect().await.expect("connect grpc");
        Self { stack, channel }
    }

    pub fn tasks(&self, creds: &Creds) -> pb::task_service_client::TaskServiceClient<Authed> {
        pb::task_service_client::TaskServiceClient::with_interceptor(self.channel.clone(), creds.clone())
    }

    pub fn catalog(&self, creds: &Creds) -> pb::catalog_service_client::CatalogServiceClient<Authed> {
        pb::catalog_service_client::CatalogServiceClient::with_interceptor(self.channel.clone(), creds.clone())
    }

    pub fn events(&self, creds: &Creds) -> pb::event_service_client::EventServiceClient<Authed> {
        pb::event_service_client::EventServiceClient::with_interceptor(self.channel.clone(), creds.clone())
    }

    pub fn messages(&self, creds: &Creds) -> pb::message_service_client::MessageServiceClient<Authed> {
        pb::message_service_client::MessageServiceClient::with_interceptor(self.channel.clone(), creds.clone())
    }

    pub fn contexts(&self, creds: &Creds) -> pb::context_service_client::ContextServiceClient<Authed> {
        pb::context_service_client::ContextServiceClient::with_interceptor(self.channel.clone(), creds.clone())
    }

    pub fn artifacts(&self, creds: &Creds) -> pb::artifact_service_client::ArtifactServiceClient<Authed> {
        pb::artifact_service_client::ArtifactServiceClient::with_interceptor(self.channel.clone(), creds.clone())
    }

    pub fn subscriptions(&self, creds: &Creds) -> pb::subscription_service_client::SubscriptionServiceClient<Authed> {
        pb::subscription_service_client::SubscriptionServiceClient::with_interceptor(self.channel.clone(), creds.clone())
    }

    pub fn authorization(&self, creds: &Creds) -> pb::authorization_service_client::AuthorizationServiceClient<Authed> {
        pb::authorization_service_client::AuthorizationServiceClient::with_interceptor(self.channel.clone(), creds.clone())
    }

    /// worker + requester pair offering `code.review@2.1` (read).
    pub async fn review_pair(&self) -> (Agent, Agent) {
        let worker = self
            .stack
            .worker(
                "agent/reviewer",
                vec![capability("code.review", "2.1", "read", "Review pull requests for correctness and security")],
                worker_perms(SideEffects::Read),
            )
            .await;
        let author = self.stack.requester("agent/author", &["code.review"], SideEffects::Read).await;
        (worker, author)
    }
}

pub fn worker_perms(se: SideEffects) -> Permissions {
    let mut p = Permissions::default_agent();
    p.side_effects_at_most = Some(se);
    p
}

pub fn with_md<T>(message: T, pairs: &[(&'static str, &str)]) -> Request<T> {
    let mut req = Request::new(message);
    for (k, v) in pairs {
        req.metadata_mut().insert(*k, v.parse().unwrap());
    }
    req
}

/// The problem code (`stale_revision`, `schema_violation`...) carried in the `ErrorInfo` detail.
pub fn reason(status: &Status) -> String {
    status.get_details_error_info().map(|i| i.reason).unwrap_or_default()
}

pub fn expect_err<T: std::fmt::Debug>(result: Result<tonic::Response<T>, Status>, code: Code, problem: &str) -> Status {
    let status = result.expect_err("call should fail");
    assert_eq!(status.code(), code, "unexpected status: {status:?}");
    assert_eq!(reason(&status), problem, "unexpected problem code: {status:?}");
    status
}

pub fn struct_of(v: Value) -> prost_types::Struct {
    somework_api::grpc::json_to_struct(&v).expect("object")
}

pub fn review_input() -> prost_types::Struct {
    struct_of(json!({"repository": "billing/import-service", "commit": "61a8d52"}))
}

pub fn submit_req() -> pb::SubmitTaskRequest {
    pb::SubmitTaskRequest {
        capability: Some(pb::CapabilityRef { id: "code.review".into(), version: "2.1".into() }),
        input: Some(review_input()),
        ..Default::default()
    }
}

pub fn pctl(mut samples: Vec<Duration>, p: f64) -> Duration {
    samples.sort();
    samples[((samples.len() as f64 * p).ceil() as usize).saturating_sub(1).min(samples.len() - 1)]
}

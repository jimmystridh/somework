//! Typed views of the v1 contract bundle (`schemas/v1.json`). Documents are validated against the JSON Schema
//! first (see [`crate::schema`]) and then deserialized into these types.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::fsm::TaskState;

pub const SCHEMA_VERSION: &str = "1.0";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ActorKind {
    Agent,
    Human,
    Service,
    Domain,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActorRef {
    pub kind: ActorKind,
    pub id: String,
    pub domain_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
}

impl ActorRef {
    pub fn new(kind: ActorKind, id: impl Into<String>, domain_id: impl Into<String>) -> Self {
        Self { kind, id: id.into(), domain_id: domain_id.into(), display_name: None }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SideEffects {
    None,
    Read,
    Write,
    Irreversible,
}

impl SideEffects {
    pub fn as_str(self) -> &'static str {
        match self {
            SideEffects::None => "none",
            SideEffects::Read => "read",
            SideEffects::Write => "write",
            SideEffects::Irreversible => "irreversible",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "none" => Some(Self::None),
            "read" => Some(Self::Read),
            "write" => Some(Self::Write),
            "irreversible" => Some(Self::Irreversible),
            _ => None,
        }
    }
}

/// Tag an action contract carries when repeating it with the same idempotency key is proven safe (TASK-06).
pub const IDEMPOTENT_TAG: &str = "contract:idempotent";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Capability {
    pub id: String,
    pub version: String,
    pub name: String,
    pub description: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
    pub input_schema: Value,
    pub output_schema: Value,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub input_media_types: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub output_media_types: Vec<String>,
    pub side_effects: SideEffects,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub data_classes: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub required_permissions: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub examples: Vec<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_seconds: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost_hint: Option<Value>,
}

impl Capability {
    pub fn is_idempotent(&self) -> bool {
        self.tags.iter().any(|t| t == IDEMPOTENT_TAG)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Owner {
    pub team: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub contact: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub service: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Interface {
    pub protocol: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub binding: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tenant: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentStatus {
    Active,
    Degraded,
    Offline,
    Disabled,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentCard {
    pub schema_version: String,
    pub agent_id: String,
    pub domain_id: String,
    pub display_name: String,
    pub description: String,
    pub owner: Owner,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<AgentStatus>,
    pub capabilities: Vec<Capability>,
    pub interfaces: Vec<Interface>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub auth_schemes: Vec<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub labels: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub card_version: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
}

/// Label an agent card uses to opt into a shared worker pool; defaults to the agent id.
pub const POOL_LABEL: &str = "somework.pool";

impl AgentCard {
    pub fn pool_id(&self) -> String {
        self.labels.get(POOL_LABEL).cloned().unwrap_or_else(|| self.agent_id.clone())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Visibility {
    Private,
    Domain,
    Exported,
    Public,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TrustTier {
    Local,
    Partner,
    External,
    Untrusted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ApprovalStatus {
    Draft,
    Approved,
    Suspended,
    Revoked,
}

impl ApprovalStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            ApprovalStatus::Draft => "draft",
            ApprovalStatus::Approved => "approved",
            ApprovalStatus::Suspended => "suspended",
            ApprovalStatus::Revoked => "revoked",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AvailabilityState {
    Available,
    Busy,
    Queueable,
    Offline,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SourceType {
    Native,
    A2a,
    Manual,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Approval {
    pub status: ApprovalStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approved_by: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approved_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub policy_version: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Availability {
    pub state: AvailabilityState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_instances: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub queue_depth: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub observed_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Source {
    #[serde(rename = "type")]
    pub kind: SourceType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub uri: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub digest: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CatalogEntry {
    pub entry_id: String,
    pub agent_card: AgentCard,
    pub visibility: Visibility,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub exported_capabilities: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trust_tier: Option<TrustTier>,
    pub approval: Approval,
    pub availability: Availability,
    pub source: Source,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub search_text: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub labels: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Digest {
    pub algorithm: String,
    pub value: String,
}

impl Digest {
    pub fn sha256(value: impl Into<String>) -> Self {
        Self { algorithm: "sha-256".into(), value: value.into() }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArtifactRef {
    pub artifact_id: String,
    pub version: u64,
    pub uri: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filename: Option<String>,
    pub media_type: String,
    pub size_bytes: u64,
    pub digest: Digest,
    pub classification: String,
    pub created_by: ActorRef,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_task_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provenance: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub encryption: Option<Value>,
}

pub fn artifact_uri(domain_id: &str, artifact_id: &str, version: u64) -> String {
    format!("artifact://{domain_id}/{artifact_id}/{version}")
}

pub fn parse_artifact_uri(uri: &str) -> Option<(String, String, u64)> {
    let rest = uri.strip_prefix("artifact://")?;
    let mut parts = rest.splitn(3, '/');
    let domain = parts.next()?.to_string();
    let id = parts.next()?.to_string();
    let version = parts.next()?.parse().ok()?;
    Some((domain, id, version))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum MessageType {
    #[serde(rename = "chat.message")]
    ChatMessage,
    #[serde(rename = "chat.notice")]
    ChatNotice,
    #[serde(rename = "event.notification")]
    EventNotification,
    #[serde(rename = "task.request")]
    TaskRequest,
    #[serde(rename = "task.status")]
    TaskStatus,
    #[serde(rename = "task.input")]
    TaskInput,
    #[serde(rename = "task.result")]
    TaskResult,
    #[serde(rename = "context.offer")]
    ContextOffer,
    #[serde(rename = "context.accepted")]
    ContextAccepted,
    #[serde(rename = "artifact.published")]
    ArtifactPublished,
    #[serde(rename = "approval.request")]
    ApprovalRequest,
    #[serde(rename = "approval.decision")]
    ApprovalDecision,
    #[serde(rename = "catalog.changed")]
    CatalogChanged,
    #[serde(rename = "policy.denied")]
    PolicyDenied,
    #[serde(rename = "stream.chunk")]
    StreamChunk,
    #[serde(rename = "presence.changed")]
    PresenceChanged,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TriggerMode {
    Never,
    Directed,
    Subscription,
    TaskState,
}

impl TriggerMode {
    pub fn as_str(self) -> &'static str {
        match self {
            TriggerMode::Never => "never",
            TriggerMode::Directed => "directed",
            TriggerMode::Subscription => "subscription",
            TriggerMode::TaskState => "task-state",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Priority {
    Low,
    Normal,
    High,
    Critical,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MessageContent {
    pub media_type: String,
    pub data: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContextRef {
    pub context_pack_id: String,
    pub version: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sections: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MessageEnvelope {
    pub schema_version: String,
    pub message_id: String,
    #[serde(rename = "type")]
    pub kind: MessageType,
    pub sender: ActorRef,
    pub recipients: Vec<ActorRef>,
    pub domain_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conversation_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub correlation_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub causation_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reply_to: Option<String>,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub priority: Option<Priority>,
    pub trigger_mode: TriggerMode,
    pub content: MessageContent,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub artifacts: Vec<ArtifactRef>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub context_refs: Vec<ContextRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub authorization_token_id: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub labels: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub traceparent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub idempotency_key: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CapabilityRef {
    pub id: String,
    pub version: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Lease {
    pub lease_id: String,
    pub runtime_instance_id: String,
    pub fencing_token: u64,
    pub expires_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Failure {
    pub code: String,
    pub message: String,
    pub retryable: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Task {
    pub task_id: String,
    pub domain_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conversation_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_task_id: Option<String>,
    pub capability: CapabilityRef,
    pub requester: ActorRef,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_agent_id: Option<String>,
    #[serde(default)]
    pub assignee: Option<ActorRef>,
    pub state: TaskState,
    pub revision: u64,
    pub attempt: u64,
    pub input: Value,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub context_refs: Vec<ContextRef>,
    #[serde(default)]
    pub lease: Option<Lease>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub authorization_token_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub policy_decision_id: Option<String>,
    #[serde(default)]
    pub result: Option<Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub result_artifacts: Vec<ArtifactRef>,
    #[serde(default)]
    pub failure: Option<Failure>,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deadline_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub idempotency_key: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Action {
    #[serde(rename = "catalog.read")]
    CatalogRead,
    #[serde(rename = "message.send")]
    MessageSend,
    #[serde(rename = "message.read")]
    MessageRead,
    #[serde(rename = "task.submit")]
    TaskSubmit,
    #[serde(rename = "task.read")]
    TaskRead,
    #[serde(rename = "task.claim")]
    TaskClaim,
    #[serde(rename = "task.update")]
    TaskUpdate,
    #[serde(rename = "task.delegate")]
    TaskDelegate,
    #[serde(rename = "task.cancel")]
    TaskCancel,
    #[serde(rename = "artifact.read")]
    ArtifactRead,
    #[serde(rename = "artifact.write")]
    ArtifactWrite,
    #[serde(rename = "context.read")]
    ContextRead,
    #[serde(rename = "context.write")]
    ContextWrite,
    #[serde(rename = "approval.grant")]
    ApprovalGrant,
    #[serde(rename = "capability.invoke")]
    CapabilityInvoke,
}

pub const TOKEN_ACTIONS: [Action; 15] = [
    Action::CatalogRead,
    Action::MessageSend,
    Action::MessageRead,
    Action::TaskSubmit,
    Action::TaskRead,
    Action::TaskClaim,
    Action::TaskUpdate,
    Action::TaskDelegate,
    Action::TaskCancel,
    Action::ArtifactRead,
    Action::ArtifactWrite,
    Action::ContextRead,
    Action::ContextWrite,
    Action::ApprovalGrant,
    Action::CapabilityInvoke,
];

impl Action {
    pub fn as_str(self) -> &'static str {
        use Action::*;
        match self {
            CatalogRead => "catalog.read",
            MessageSend => "message.send",
            MessageRead => "message.read",
            TaskSubmit => "task.submit",
            TaskRead => "task.read",
            TaskClaim => "task.claim",
            TaskUpdate => "task.update",
            TaskDelegate => "task.delegate",
            TaskCancel => "task.cancel",
            ArtifactRead => "artifact.read",
            ArtifactWrite => "artifact.write",
            ContextRead => "context.read",
            ContextWrite => "context.write",
            ApprovalGrant => "approval.grant",
            CapabilityInvoke => "capability.invoke",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        TOKEN_ACTIONS.into_iter().find(|a| a.as_str() == raw)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DelegationClaim {
    pub allowed: bool,
    pub remaining_depth: u32,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Confirmation {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub certificate_sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_thumbprint: Option<String>,
}

/// Signed claims payload of an authorization grant. `issued_at`/`not_before`/`expires_at` are RFC 3339 strings in
/// the schema; the JWS wire form additionally carries `iat`/`nbf`/`exp` as NumericDate (see [`crate::jws`]).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuthorizationToken {
    pub jti: String,
    pub issuer: String,
    pub subject: ActorRef,
    pub audience: Vec<String>,
    pub domain_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    pub actions: Vec<Action>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub capabilities: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub resources: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub constraints: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub classification_max: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delegation: Option<DelegationClaim>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confirmation: Option<Confirmation>,
    pub policy_version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_jti: Option<String>,
    pub issued_at: String,
    pub not_before: String,
    pub expires_at: String,
}

pub const CONTEXT_SECTIONS: [&str; 14] = [
    "objective",
    "acceptanceCriteria",
    "currentState",
    "facts",
    "hypotheses",
    "decisions",
    "openQuestions",
    "workspace",
    "evidence",
    "artifacts",
    "requestedContinuation",
    "executionConstraints",
    "security",
    "provenance",
];

/// Sections that are always disclosed with a manifest because the receiver cannot interpret the pack without them.
pub const CONTEXT_MANIFEST_SECTIONS: [&str; 4] = ["objective", "requestedContinuation", "security", "provenance"];

/// ContextPack top-level keys that make up a named section. `evidence` is the conversation/tool evidence references.
pub fn context_section_keys(section: &str) -> &'static [&'static str] {
    match section {
        "objective" => &["objective"],
        "acceptanceCriteria" => &["acceptanceCriteria"],
        "currentState" => &["currentState"],
        "facts" => &["facts"],
        "hypotheses" => &["hypotheses"],
        "decisions" => &["decisions"],
        "openQuestions" => &["openQuestions"],
        "workspace" => &["workspace"],
        "evidence" => &["conversationRefs", "toolResultRefs"],
        "artifacts" => &["artifacts"],
        "requestedContinuation" => &["requestedContinuation"],
        "executionConstraints" => &["executionConstraints"],
        "security" => &["security"],
        "provenance" => &["provenance"],
        _ => &[],
    }
}

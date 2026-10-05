use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use thiserror::Error;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    Unauthenticated,
    PolicyDenied,
    NotFound,
    ValidationFailed,
    SchemaViolation,
    TriggerNotAllowed,
    SenderMismatch,
    IdempotencyConflict,
    StaleRevision,
    InvalidTransition,
    TaskTerminal,
    AlreadyClaimed,
    StaleFencingToken,
    LeaseExpired,
    PayloadTooLarge,
    IntegrityFailure,
    ArtifactNotReady,
    QuotaExceeded,
    ApprovalRequired,
    Expired,
    Conflict,
    RateLimited,
    PolicyUnavailable,
    Unavailable,
    Internal,
}

impl ErrorCode {
    pub fn status(self) -> u16 {
        use ErrorCode::*;
        match self {
            Unauthenticated => 401,
            PolicyDenied => 403,
            NotFound => 404,
            ValidationFailed | SchemaViolation | TriggerNotAllowed | IntegrityFailure | ArtifactNotReady => 422,
            SenderMismatch => 403,
            IdempotencyConflict | InvalidTransition | TaskTerminal | AlreadyClaimed | StaleFencingToken | LeaseExpired | Conflict | ApprovalRequired => 409,
            StaleRevision => 409,
            PayloadTooLarge | QuotaExceeded => 413,
            Expired => 410,
            RateLimited => 429,
            PolicyUnavailable | Unavailable => 503,
            Internal => 500,
        }
    }

    pub fn as_str(self) -> &'static str {
        use ErrorCode::*;
        match self {
            Unauthenticated => "unauthenticated",
            PolicyDenied => "policy_denied",
            NotFound => "not_found",
            ValidationFailed => "validation_failed",
            SchemaViolation => "schema_violation",
            TriggerNotAllowed => "trigger_not_allowed",
            SenderMismatch => "sender_mismatch",
            IdempotencyConflict => "idempotency_conflict",
            StaleRevision => "stale_revision",
            InvalidTransition => "invalid_transition",
            TaskTerminal => "task_terminal",
            AlreadyClaimed => "already_claimed",
            StaleFencingToken => "stale_fencing_token",
            LeaseExpired => "lease_expired",
            PayloadTooLarge => "payload_too_large",
            IntegrityFailure => "integrity_failure",
            ArtifactNotReady => "artifact_not_ready",
            QuotaExceeded => "quota_exceeded",
            ApprovalRequired => "approval_required",
            Expired => "expired",
            Conflict => "conflict",
            RateLimited => "rate_limited",
            PolicyUnavailable => "policy_unavailable",
            Unavailable => "unavailable",
            Internal => "internal",
        }
    }

    pub fn from_str_code(raw: &str) -> Option<Self> {
        serde_json::from_value(Value::String(raw.to_string())).ok()
    }
}

#[derive(Debug, Clone, Error, Serialize, Deserialize)]
#[error("{code:?}: {message}")]
pub struct Error {
    pub code: ErrorCode,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
}

pub type Result<T, E = Error> = std::result::Result<T, E>;

impl Error {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self { code, message: message.into(), details: None }
    }

    pub fn with_details(mut self, details: Value) -> Self {
        self.details = Some(details);
        self
    }

    pub fn unauthenticated(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Unauthenticated, message)
    }
    pub fn denied(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::PolicyDenied, message)
    }
    pub fn not_found(what: impl Into<String>) -> Self {
        Self::new(ErrorCode::NotFound, format!("{} not found", what.into()))
    }
    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::ValidationFailed, message)
    }
    pub fn conflict(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Conflict, message)
    }
    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Internal, message)
    }
    pub fn unavailable(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Unavailable, message)
    }

    pub fn status(&self) -> u16 {
        self.code.status()
    }

    /// RFC 9457 problem document, extended with `code` and `traceId`.
    pub fn problem(&self, trace_id: &str) -> Value {
        let mut body = json!({
            "type": format!("urn:somework:error:{}", self.code.as_str()),
            "title": self.code.as_str(),
            "status": self.status(),
            "code": self.code.as_str(),
            "detail": self.message,
            "traceId": trace_id,
        });
        if let Some(details) = &self.details {
            body["details"] = details.clone();
        }
        body
    }

    pub fn is_retryable(&self) -> bool {
        matches!(self.code, ErrorCode::Unavailable | ErrorCode::PolicyUnavailable | ErrorCode::RateLimited)
    }
}

impl From<serde_json::Error> for Error {
    fn from(value: serde_json::Error) -> Self {
        Error::invalid(format!("invalid JSON: {value}"))
    }
}

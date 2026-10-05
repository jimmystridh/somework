use std::collections::HashMap;

use somework_core::{Error, ErrorCode, trace::TraceContext};
use tonic::{
    Code, Status,
    metadata::{AsciiMetadataValue, MetadataMap},
};
use tonic_types::{ErrorDetails, StatusExt};

/// `ErrorCode` -> gRPC status code. Revision/transition/terminal conflicts are `FAILED_PRECONDITION` (the caller must
/// re-read); fencing/lease/claim races are `ABORTED` (another worker owns the task).
pub fn grpc_code(code: ErrorCode) -> Code {
    use ErrorCode::*;
    match code {
        Unauthenticated => Code::Unauthenticated,
        PolicyDenied | SenderMismatch => Code::PermissionDenied,
        NotFound => Code::NotFound,
        ValidationFailed | SchemaViolation | TriggerNotAllowed | IntegrityFailure => Code::InvalidArgument,
        StaleRevision | InvalidTransition | TaskTerminal | ApprovalRequired | ArtifactNotReady | Expired => Code::FailedPrecondition,
        AlreadyClaimed | StaleFencingToken | LeaseExpired => Code::Aborted,
        IdempotencyConflict | Conflict => Code::AlreadyExists,
        PayloadTooLarge | QuotaExceeded | RateLimited => Code::ResourceExhausted,
        PolicyUnavailable | Unavailable => Code::Unavailable,
        Internal => Code::Internal,
    }
}

pub fn attach_trace(md: &mut MetadataMap, trace: &TraceContext) {
    if let Ok(v) = AsciiMetadataValue::try_from(trace.trace_id.as_str()) {
        md.insert("trace-id", v);
    }
    if let Ok(v) = AsciiMetadataValue::try_from(trace.traceparent().as_str()) {
        md.insert("traceparent", v);
    }
}

/// The problem document of REST, carried as a `google.rpc.ErrorInfo` detail: reason = problem code, metadata holds
/// `traceId` and the JSON `details` (without internal decision payloads, exactly like the REST response).
pub fn error_to_status(err: &Error, trace: &TraceContext) -> Status {
    let mut metadata = HashMap::new();
    metadata.insert("traceId".to_string(), trace.trace_id.clone());
    metadata.insert("httpStatus".to_string(), err.status().to_string());
    if let Some(details) = &err.details {
        let mut details = details.clone();
        if let Some(obj) = details.as_object_mut() {
            obj.remove("decision");
        }
        metadata.insert("details".to_string(), details.to_string());
    }
    let mut status =
        Status::with_error_details(grpc_code(err.code), err.message.clone(), ErrorDetails::with_error_info(err.code.as_str(), "somework.dev", metadata));
    attach_trace(status.metadata_mut(), trace);
    status
}

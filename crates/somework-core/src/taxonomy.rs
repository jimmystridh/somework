//! Message and event taxonomy (spec "Message and event taxonomy"): durability, wake-up and trigger rules.

use crate::contracts::{MessageType, TriggerMode};

#[derive(Debug, Clone, Copy)]
pub struct TypeRules {
    pub durable: bool,
    pub allowed_triggers: &'static [TriggerMode],
    pub default_trigger: TriggerMode,
    /// Whether API callers may submit this type through `POST /v1/messages`. The remaining types are emitted by
    /// the platform itself as projections of canonical state changes.
    pub client_sendable: bool,
}

use TriggerMode::*;

pub fn rules(kind: MessageType) -> TypeRules {
    use MessageType::*;
    match kind {
        ChatMessage => TypeRules { durable: true, allowed_triggers: &[Never, Directed, Subscription], default_trigger: Directed, client_sendable: true },
        ChatNotice => TypeRules { durable: true, allowed_triggers: &[Never], default_trigger: Never, client_sendable: true },
        EventNotification => TypeRules { durable: true, allowed_triggers: &[Never, Subscription], default_trigger: Subscription, client_sendable: true },
        TaskRequest => TypeRules { durable: true, allowed_triggers: &[TaskState], default_trigger: TaskState, client_sendable: false },
        TaskStatus => TypeRules { durable: true, allowed_triggers: &[Never], default_trigger: Never, client_sendable: true },
        TaskInput => TypeRules { durable: true, allowed_triggers: &[TaskState], default_trigger: TaskState, client_sendable: false },
        TaskResult => TypeRules { durable: true, allowed_triggers: &[Never], default_trigger: Never, client_sendable: false },
        ContextOffer => TypeRules { durable: true, allowed_triggers: &[Directed], default_trigger: Directed, client_sendable: false },
        ContextAccepted => TypeRules { durable: true, allowed_triggers: &[Never], default_trigger: Never, client_sendable: false },
        ArtifactPublished => TypeRules { durable: true, allowed_triggers: &[Never], default_trigger: Never, client_sendable: false },
        ApprovalRequest => TypeRules { durable: true, allowed_triggers: &[Never, Directed], default_trigger: Directed, client_sendable: false },
        ApprovalDecision => TypeRules { durable: true, allowed_triggers: &[TaskState], default_trigger: TaskState, client_sendable: false },
        CatalogChanged => TypeRules { durable: true, allowed_triggers: &[Never], default_trigger: Never, client_sendable: false },
        PolicyDenied => TypeRules { durable: true, allowed_triggers: &[Never], default_trigger: Never, client_sendable: false },
        StreamChunk => TypeRules { durable: false, allowed_triggers: &[Never], default_trigger: Never, client_sendable: false },
        PresenceChanged => TypeRules { durable: false, allowed_triggers: &[Never], default_trigger: Never, client_sendable: false },
    }
}

/// Wire name of a message type, e.g. `chat.notice`.
pub fn type_name(kind: MessageType) -> String {
    serde_json::to_value(kind).ok().and_then(|v| v.as_str().map(str::to_owned)).unwrap_or_default()
}

pub fn parse_type(raw: &str) -> Option<MessageType> {
    serde_json::from_value(serde_json::Value::String(raw.to_string())).ok()
}

/// Loop protection (MSG-02): only an explicit, type-permitted trigger mode can wake an agent.
pub fn may_wake(kind: MessageType, trigger: TriggerMode) -> bool {
    trigger != Never && rules(kind).allowed_triggers.contains(&trigger)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notices_status_and_streams_never_wake() {
        for kind in [MessageType::ChatNotice, MessageType::TaskStatus, MessageType::StreamChunk, MessageType::PresenceChanged, MessageType::TaskResult] {
            for trigger in [Never, Directed, Subscription, TaskState] {
                assert!(!may_wake(kind, trigger), "{kind:?}/{trigger:?}");
            }
        }
    }

    #[test]
    fn directed_chat_wakes() {
        assert!(may_wake(MessageType::ChatMessage, Directed));
        assert!(!may_wake(MessageType::ChatMessage, Never));
        assert!(may_wake(MessageType::ContextOffer, Directed));
    }

    #[test]
    fn type_names_roundtrip() {
        assert_eq!(type_name(MessageType::ChatNotice), "chat.notice");
        assert_eq!(parse_type("task.status"), Some(MessageType::TaskStatus));
        assert_eq!(parse_type("nope"), None);
    }
}

//! NATS subject space and JetStream stream names (one NATS account per trust domain). Ids are always passed
//! through [`subject_token`](crate::ids::subject_token) so user supplied strings cannot add levels or wildcards.

use crate::ids::subject_token;

pub const ROOT: &str = "somework";

pub const STREAM_WORK: &str = "SOMEWORK_WORK";
pub const STREAM_INBOX: &str = "SOMEWORK_INBOX";
pub const STREAM_EVENTS: &str = "SOMEWORK_EVENTS";
pub const STREAM_SUBSCRIPTIONS: &str = "SOMEWORK_SUBSCRIPTIONS";

pub const WORK_FILTER: &str = "somework.work.>";
pub const INBOX_FILTER: &str = "somework.inbox.>";
pub const EVENT_FILTER: &str = "somework.event.>";
pub const SUBSCRIPTION_FILTER: &str = "somework.subscription.>";
pub const STREAM_CORE_FILTER: &str = "somework.stream.>";
pub const PRESENCE_FILTER: &str = "somework.presence.>";

pub const EVENT_CATALOG_CHANGED: &str = "somework.event.catalog.changed";
pub const EVENT_POLICY_DENIED: &str = "somework.event.policy.denied";

pub fn work_pool(pool_id: &str) -> String {
    format!("somework.work.pool.{}", subject_token(pool_id))
}

pub fn inbox(agent_id: &str) -> String {
    format!("somework.inbox.{}", subject_token(agent_id))
}

pub fn event_task(task_id: &str) -> String {
    format!("somework.event.task.{}", subject_token(task_id))
}

pub fn event_conversation(conversation_id: &str) -> String {
    format!("somework.event.conversation.{}", subject_token(conversation_id))
}

pub fn subscription(subscription_id: &str) -> String {
    format!("somework.subscription.{}", subject_token(subscription_id))
}

pub fn stream_task_text(task_id: &str) -> String {
    format!("somework.stream.task.{}.text", subject_token(task_id))
}

pub fn stream_task_tool(task_id: &str) -> String {
    format!("somework.stream.task.{}.tool", subject_token(task_id))
}

pub fn presence(agent_id: &str) -> String {
    format!("somework.presence.{}", subject_token(agent_id))
}

/// Durable consumer name for a worker pool's shared pull consumer.
pub fn pool_consumer(pool_id: &str) -> String {
    format!("pool_{}", subject_token(pool_id))
}

/// Durable consumer name for a logical agent's inbox.
pub fn inbox_consumer(agent_id: &str) -> String {
    format!("inbox_{}", subject_token(agent_id))
}

pub fn stream_for_subject(subject: &str) -> Option<&'static str> {
    if subject.starts_with("somework.work.") {
        Some(STREAM_WORK)
    } else if subject.starts_with("somework.inbox.") {
        Some(STREAM_INBOX)
    } else if subject.starts_with("somework.event.") {
        Some(STREAM_EVENTS)
    } else if subject.starts_with("somework.subscription.") {
        Some(STREAM_SUBSCRIPTIONS)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_strings_cannot_escape_their_level() {
        assert_eq!(work_pool("reviewers"), "somework.work.pool.reviewers");
        let hostile = inbox("agent/x.>");
        assert_eq!(hostile.matches('.').count(), 2);
        assert!(!hostile.contains('>'));
        assert_eq!(stream_for_subject(&hostile), Some(STREAM_INBOX));
    }
}

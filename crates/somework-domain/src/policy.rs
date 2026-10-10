//! Attribute-based policy decision point (POL-01..03). Pure evaluation: persistence of decisions and failing
//! closed when the policy store is unavailable is handled by [`crate::Domain::enforce`].

use serde::{Deserialize, Serialize};
use somework_core::{
    classification::{ClassificationScale, any_glob, glob_match},
    contracts::Action,
};

/// Actions beyond the 15 token actions: administrative and operational surface.
pub const ADMIN_ACTIONS: &[&str] = &[
    "catalog.approve",
    "catalog.write.any",
    "principal.manage",
    "policy.manage",
    "audit.read",
    "ops.read",
    "message.read.any",
    "federation.manage",
    "domain.admin",
    "rules.manage",
    "rules.control",
];

pub const EVENTS_PUBLISH_PREFIX: &str = "events.publish:";

pub fn is_admin_action(action: &str) -> bool {
    ADMIN_ACTIONS.contains(&action)
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Permissions {
    /// `admin`, `auditor`, `operator`.
    pub roles: Vec<String>,
    /// Granted actions; `*` grants every non-administrative action.
    pub actions: Vec<String>,
    pub classification_max: Option<String>,
    /// Resource patterns (`artifact://…`, `context://…`); empty means unrestricted within the domain.
    pub resources: Vec<String>,
}

impl Permissions {
    pub fn default_agent() -> Self {
        Self {
            actions: ["catalog.read", "catalog.register", "message.send", "message.read", "artifact.read", "artifact.write", "context.read", "context.write"]
                .map(String::from)
                .to_vec(),
            classification_max: Some("internal".into()),
            ..Default::default()
        }
    }

    pub fn default_human() -> Self {
        Self {
            actions: ["catalog.read", "message.send", "message.read", "artifact.read", "context.read"].map(String::from).to_vec(),
            classification_max: Some("internal".into()),
            ..Default::default()
        }
    }

    pub fn admin() -> Self {
        Self { roles: vec!["admin".into()], actions: vec!["*".into()], classification_max: Some("restricted".into()), ..Default::default() }
    }

    pub fn has_role(&self, role: &str) -> bool {
        self.roles.iter().any(|r| r == role)
    }

    /// Publishing events needs an explicit `events.publish:<glob over the topic>` grant (or the admin role); the
    /// wildcard `*` action deliberately does not cover it.
    pub fn allows_publish(&self, topic: &str) -> bool {
        self.has_role("admin") || self.actions.iter().filter_map(|a| a.strip_prefix(EVENTS_PUBLISH_PREFIX)).any(|pattern| glob_match(pattern, topic))
    }

    pub fn allows_action(&self, action: &str) -> bool {
        if action == "events.publish" {
            return self.has_role("admin") || self.actions.iter().any(|a| a.starts_with(EVENTS_PUBLISH_PREFIX));
        }
        if is_admin_action(action) {
            return self.has_role("admin")
                || self.actions.iter().any(|a| a == action)
                || match action {
                    "audit.read" | "ops.read" | "message.read.any" => self.has_role("auditor"),
                    _ => false,
                }
                || (action == "ops.read" && self.has_role("operator"));
        }
        self.actions.iter().any(|a| a == "*" || a == action)
    }

    pub fn classification_limit(&self) -> &str {
        self.classification_max.as_deref().unwrap_or("internal")
    }

    pub fn resource_allowed(&self, resource: &str) -> bool {
        self.resources.is_empty() || any_glob(&self.resources, resource)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct DenyRule {
    pub id: String,
    pub actions: Vec<String>,
    /// Globs over `<kind>:<id>` of the acting principal; empty matches everyone.
    pub principals: Vec<String>,
    pub resources: Vec<String>,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PolicyDocument {
    pub version: String,
    pub classification_levels: Vec<String>,
    pub catalog_auto_approve: bool,
    pub deny_rules: Vec<DenyRule>,
    /// AUD-03: whether audit/ops views may show message plaintext (otherwise digests and metadata only).
    pub audit_plaintext: bool,
    /// Classification at (or above) which a conversation must live in a dedicated Matrix room.
    pub dedicated_room_classification: String,
}

impl Default for PolicyDocument {
    fn default() -> Self {
        Self {
            version: "builtin-1".into(),
            classification_levels: ClassificationScale::default().0,
            catalog_auto_approve: false,
            deny_rules: vec![],
            audit_plaintext: true,
            dedicated_room_classification: "confidential".into(),
        }
    }
}

impl PolicyDocument {
    pub fn scale(&self) -> ClassificationScale {
        ClassificationScale(self.classification_levels.clone())
    }
}

#[derive(Debug, Clone, Default)]
pub struct AuthzRequest {
    pub action: String,
    pub resource: Option<String>,
    pub classification: Option<String>,
}

impl AuthzRequest {
    pub fn new(action: impl Into<String>) -> Self {
        Self { action: action.into(), ..Default::default() }
    }
    pub fn action(action: Action) -> Self {
        Self::new(action.as_str())
    }
    pub fn resource(mut self, resource: impl Into<String>) -> Self {
        self.resource = Some(resource.into());
        self
    }
    pub fn classification(mut self, level: impl Into<String>) -> Self {
        self.classification = Some(level.into());
        self
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Decision {
    pub decision_id: String,
    pub allow: bool,
    pub reasons: Vec<String>,
    pub policy_version: String,
}

/// Pure evaluation of `req` for `perms`.
pub fn evaluate(policy: &PolicyDocument, actor_label: &str, perms: &Permissions, req: &AuthzRequest) -> (bool, Vec<String>) {
    let scale = policy.scale();
    let mut reasons = Vec::new();

    if !perms.allows_action(&req.action) {
        reasons.push(format!("action {} is not granted to the caller", req.action));
    }
    if let Some(level) = &req.classification
        && !scale.permits(perms.classification_limit(), level)
    {
        reasons.push(format!("classification {level} exceeds the caller's clearance {}", perms.classification_limit()));
    }
    if let Some(resource) = &req.resource
        && !perms.resource_allowed(resource)
    {
        reasons.push(format!("resource {resource} is outside the caller's resource scope"));
    }

    for rule in &policy.deny_rules {
        let action_match = rule.actions.is_empty() || rule.actions.iter().any(|a| a == &req.action || glob_match(a, &req.action));
        let principal_match = rule.principals.is_empty() || any_glob(&rule.principals, actor_label);
        let res_match = rule.resources.is_empty() || req.resource.as_deref().is_some_and(|r| any_glob(&rule.resources, r));
        if action_match && principal_match && res_match {
            reasons.push(format!("denied by rule {}: {}", rule.id, rule.reason));
        }
    }

    (reasons.is_empty(), reasons)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn perms() -> Permissions {
        Permissions::default_agent()
    }

    #[test]
    fn grants_are_enforced() {
        let policy = PolicyDocument::default();
        assert!(evaluate(&policy, "agent:a", &perms(), &AuthzRequest::action(Action::MessageSend)).0);

        let (allow, reasons) = evaluate(&policy, "agent:a", &perms(), &AuthzRequest::new("policy.manage"));
        assert!(!allow);
        assert!(reasons[0].contains("not granted"));

        let classified = AuthzRequest::action(Action::ArtifactRead).classification("restricted");
        assert!(!evaluate(&policy, "agent:a", &perms(), &classified).0);
    }

    #[test]
    fn deny_rules_override_grants() {
        let mut policy = PolicyDocument::default();
        policy.deny_rules.push(DenyRule {
            id: "no-chat-for-bot".into(),
            actions: vec!["message.send".into()],
            principals: vec!["agent:bot/*".into()],
            reason: "bots may not chat".into(),
            ..Default::default()
        });
        let req = AuthzRequest::action(Action::MessageSend);
        assert!(!evaluate(&policy, "agent:bot/x", &perms(), &req).0);
        assert!(evaluate(&policy, "agent:human/x", &perms(), &req).0);
    }

    #[test]
    fn admin_actions_need_roles() {
        let policy = PolicyDocument::default();
        let req = AuthzRequest::new("catalog.approve");
        assert!(!evaluate(&policy, "agent:a", &perms(), &req).0);
        assert!(evaluate(&policy, "service:root", &Permissions::admin(), &req).0);
        let mut auditor = Permissions::default_human();
        auditor.roles.push("auditor".into());
        assert!(evaluate(&policy, "human:x", &auditor, &AuthzRequest::new("audit.read")).0);
        assert!(!evaluate(&policy, "human:x", &auditor, &AuthzRequest::new("catalog.approve")).0);
    }
}

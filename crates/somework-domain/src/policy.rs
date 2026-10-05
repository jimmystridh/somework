//! Attribute-based policy decision point (POL-01..03). Pure evaluation: persistence of decisions and failing
//! closed when the policy store is unavailable is handled by [`crate::Domain::enforce`].

use serde::{Deserialize, Serialize};
use serde_json::Value;
use somework_core::{
    classification::{ClassificationScale, any_glob, glob_match},
    contracts::{Action, AuthorizationToken, SideEffects},
};

/// Actions beyond the 15 token actions: administrative and operational surface.
pub const ADMIN_ACTIONS: &[&str] = &[
    "catalog.approve",
    "catalog.write.any",
    "principal.manage",
    "policy.manage",
    "audit.read",
    "ops.read",
    "task.reconcile",
    "task.read.any",
    "message.read.any",
    "federation.manage",
    "domain.admin",
];

pub fn is_admin_action(action: &str) -> bool {
    ADMIN_ACTIONS.contains(&action)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
#[derive(Default)]
pub struct DelegationPerm {
    pub allowed: bool,
    pub max_depth: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Permissions {
    /// `admin`, `auditor`, `operator`.
    pub roles: Vec<String>,
    /// Granted actions; `*` grants every non-administrative action.
    pub actions: Vec<String>,
    /// Capability id patterns this principal may invoke (`capability.invoke`, `task.submit`).
    pub capabilities: Vec<String>,
    /// Additional capability patterns the principal may *discover* without being able to invoke them.
    pub discover: Vec<String>,
    pub classification_max: Option<String>,
    pub side_effects_at_most: Option<SideEffects>,
    pub delegation: DelegationPerm,
    /// Resource patterns (`task://…`, `artifact://…`); empty means unrestricted within the domain.
    pub resources: Vec<String>,
    /// Capability patterns whose high-risk invocations this principal may approve.
    pub approves: Vec<String>,
}

impl Permissions {
    pub fn default_agent() -> Self {
        Self {
            actions: [
                "catalog.read",
                "catalog.register",
                "message.send",
                "message.read",
                "task.submit",
                "task.read",
                "task.claim",
                "task.update",
                "task.cancel",
                "artifact.read",
                "artifact.write",
                "context.read",
                "context.write",
            ]
            .map(String::from)
            .to_vec(),
            classification_max: Some("internal".into()),
            side_effects_at_most: Some(SideEffects::Read),
            ..Default::default()
        }
    }

    pub fn default_human() -> Self {
        Self {
            actions: [
                "catalog.read",
                "message.send",
                "message.read",
                "task.submit",
                "task.read",
                "task.cancel",
                "artifact.read",
                "context.read",
                "approval.grant",
            ]
            .map(String::from)
            .to_vec(),
            classification_max: Some("internal".into()),
            side_effects_at_most: Some(SideEffects::Read),
            ..Default::default()
        }
    }

    pub fn admin() -> Self {
        Self {
            roles: vec!["admin".into()],
            actions: vec!["*".into()],
            capabilities: vec!["*".into()],
            classification_max: Some("restricted".into()),
            side_effects_at_most: Some(SideEffects::Irreversible),
            delegation: DelegationPerm { allowed: true, max_depth: 8 },
            approves: vec!["*".into()],
            ..Default::default()
        }
    }

    pub fn has_role(&self, role: &str) -> bool {
        self.roles.iter().any(|r| r == role)
    }

    pub fn allows_action(&self, action: &str) -> bool {
        if is_admin_action(action) {
            return self.has_role("admin")
                || self.actions.iter().any(|a| a == action)
                || match action {
                    "audit.read" | "ops.read" | "task.read.any" | "message.read.any" => self.has_role("auditor"),
                    _ => false,
                }
                || (matches!(action, "ops.read" | "task.reconcile" | "task.read.any") && self.has_role("operator"));
        }
        self.actions.iter().any(|a| a == "*" || a == action)
    }

    pub fn side_effects_max(&self) -> SideEffects {
        self.side_effects_at_most.unwrap_or(SideEffects::Read)
    }

    pub fn classification_limit(&self) -> &str {
        self.classification_max.as_deref().unwrap_or("internal")
    }

    pub fn may_invoke(&self, capability_id: &str) -> bool {
        any_glob(&self.capabilities, capability_id)
    }

    pub fn may_discover(&self, capability_id: &str) -> bool {
        self.may_invoke(capability_id) || any_glob(&self.discover, capability_id)
    }

    pub fn may_approve(&self, capability_id: &str) -> bool {
        any_glob(&self.approves, capability_id)
    }

    pub fn resource_allowed(&self, resource: &str) -> bool {
        self.resources.is_empty() || any_glob(&self.resources, resource)
    }

    /// A token can only narrow what the principal already holds (never widen).
    pub fn narrowed_by(&self, token: &AuthorizationToken, scale: &ClassificationScale) -> Self {
        let mut out = self.clone();
        let token_actions: Vec<&str> = token.actions.iter().map(|a| a.as_str()).collect();
        out.actions = token_actions.iter().filter(|a| self.allows_action(a)).map(|a| a.to_string()).collect();
        out.roles.clear();
        if !token.capabilities.is_empty() {
            out.capabilities = token.capabilities.iter().filter(|c| self.may_invoke(c)).cloned().collect();
            out.discover = token.capabilities.iter().filter(|c| self.may_discover(c)).cloned().collect();
        }
        if !token.resources.is_empty() {
            out.resources = token.resources.iter().filter(|r| self.resource_allowed(r)).cloned().collect();
            if out.resources.is_empty() {
                out.resources = vec!["task://__none__".into()];
            }
        }
        if let Some(max) = &token.classification_max {
            out.classification_max = Some(scale.min(self.classification_limit(), max).to_string());
        }
        if let Some(se) = token.constraints.as_ref().and_then(|c| c.get("sideEffectsAtMost")).and_then(Value::as_str).and_then(SideEffects::parse) {
            out.side_effects_at_most = Some(self.side_effects_max().min(se));
        }
        if let Some(d) = &token.delegation {
            out.delegation = DelegationPerm { allowed: self.delegation.allowed && d.allowed, max_depth: self.delegation.max_depth.min(d.remaining_depth) };
        }
        out
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ApprovalPolicy {
    /// Invocations of capabilities at or above this side-effect class need a structured human approval.
    pub require_side_effects_at_least: Option<SideEffects>,
    pub require_for_capabilities: Vec<String>,
    pub ttl_seconds: i64,
}

impl Default for ApprovalPolicy {
    fn default() -> Self {
        Self { require_side_effects_at_least: Some(SideEffects::Irreversible), require_for_capabilities: vec![], ttl_seconds: 3600 }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct DenyRule {
    pub id: String,
    pub actions: Vec<String>,
    /// Globs over `<kind>:<id>` of the acting principal; empty matches everyone.
    pub principals: Vec<String>,
    pub capabilities: Vec<String>,
    pub resources: Vec<String>,
    pub min_side_effects: Option<SideEffects>,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PolicyDocument {
    pub version: String,
    pub classification_levels: Vec<String>,
    pub catalog_auto_approve: bool,
    pub approvals: ApprovalPolicy,
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
            approvals: ApprovalPolicy::default(),
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

    pub fn approval_required(&self, capability_id: &str, side_effects: SideEffects) -> bool {
        self.approvals.require_side_effects_at_least.is_some_and(|min| side_effects >= min) || any_glob(&self.approvals.require_for_capabilities, capability_id)
    }
}

#[derive(Debug, Clone, Default)]
pub struct AuthzRequest {
    pub action: String,
    pub resource: Option<String>,
    pub capability: Option<String>,
    pub side_effects: Option<SideEffects>,
    pub classification: Option<String>,
    pub task_id: Option<String>,
    pub delegation_remaining: Option<u32>,
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
    pub fn capability(mut self, id: impl Into<String>, side_effects: SideEffects) -> Self {
        self.capability = Some(id.into());
        self.side_effects = Some(side_effects);
        self
    }
    pub fn classification(mut self, level: impl Into<String>) -> Self {
        self.classification = Some(level.into());
        self
    }
    pub fn task(mut self, task_id: impl Into<String>) -> Self {
        self.task_id = Some(task_id.into());
        self
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Decision {
    pub decision_id: String,
    pub allow: bool,
    pub reasons: Vec<String>,
    pub obligations: Vec<String>,
    pub policy_version: String,
}

pub const OBLIGATION_REQUIRE_APPROVAL: &str = "require_approval";

/// Pure evaluation of `req` for `perms` (the actor's effective, token-narrowed permissions).
pub fn evaluate(policy: &PolicyDocument, actor_label: &str, perms: &Permissions, req: &AuthzRequest) -> (bool, Vec<String>, Vec<String>) {
    let scale = policy.scale();
    let mut reasons = Vec::new();
    let mut obligations = Vec::new();

    if !perms.allows_action(&req.action) {
        reasons.push(format!("action {} is not granted to the caller", req.action));
    }
    if let Some(cap) = &req.capability {
        let needs_invoke = matches!(req.action.as_str(), "capability.invoke" | "task.submit" | "task.delegate");
        if needs_invoke && !perms.may_invoke(cap) {
            reasons.push(format!("capability {cap} is not granted to the caller"));
        }
    }
    if let Some(se) = req.side_effects
        && se > perms.side_effects_max()
    {
        reasons.push(format!("side-effect class {} exceeds the caller's maximum {}", se.as_str(), perms.side_effects_max().as_str()));
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
    if req.action == "task.delegate" {
        if !perms.delegation.allowed {
            reasons.push("delegation is not permitted".into());
        } else if req.delegation_remaining == Some(0) {
            reasons.push("delegation depth exhausted".into());
        }
    }

    for rule in &policy.deny_rules {
        let action_match = rule.actions.is_empty() || rule.actions.iter().any(|a| a == &req.action || glob_match(a, &req.action));
        let principal_match = rule.principals.is_empty() || any_glob(&rule.principals, actor_label);
        let cap_match = rule.capabilities.is_empty() || req.capability.as_deref().is_some_and(|c| any_glob(&rule.capabilities, c));
        let res_match = rule.resources.is_empty() || req.resource.as_deref().is_some_and(|r| any_glob(&rule.resources, r));
        let se_match = rule.min_side_effects.is_none_or(|min| req.side_effects.is_some_and(|se| se >= min));
        if action_match && principal_match && cap_match && res_match && se_match {
            reasons.push(format!("denied by rule {}: {}", rule.id, rule.reason));
        }
    }

    if reasons.is_empty()
        && let (Some(cap), Some(se)) = (&req.capability, req.side_effects)
        && matches!(req.action.as_str(), "task.submit" | "capability.invoke")
        && policy.approval_required(cap, se)
    {
        obligations.push(OBLIGATION_REQUIRE_APPROVAL.to_string());
    }
    (reasons.is_empty(), reasons, obligations)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn perms() -> Permissions {
        let mut p = Permissions::default_agent();
        p.capabilities = vec!["code.*".into()];
        p
    }

    #[test]
    fn grants_are_enforced() {
        let policy = PolicyDocument::default();
        let ok = AuthzRequest::action(Action::TaskSubmit).capability("code.review", SideEffects::Read);
        assert!(evaluate(&policy, "agent:a", &perms(), &ok).0);

        let wrong_cap = AuthzRequest::action(Action::TaskSubmit).capability("deployment.execute", SideEffects::Read);
        assert!(!evaluate(&policy, "agent:a", &perms(), &wrong_cap).0);

        let too_strong = AuthzRequest::action(Action::TaskSubmit).capability("code.format", SideEffects::Write);
        let (allow, reasons, _) = evaluate(&policy, "agent:a", &perms(), &too_strong);
        assert!(!allow);
        assert!(reasons[0].contains("side-effect"));

        let classified = AuthzRequest::action(Action::ArtifactRead).classification("restricted");
        assert!(!evaluate(&policy, "agent:a", &perms(), &classified).0);
    }

    #[test]
    fn irreversible_invocations_carry_the_approval_obligation() {
        let policy = PolicyDocument::default();
        let mut p = perms();
        p.capabilities = vec!["*".into()];
        p.side_effects_at_most = Some(SideEffects::Irreversible);
        let req = AuthzRequest::action(Action::TaskSubmit).capability("deployment.execute", SideEffects::Irreversible);
        let (allow, _, obligations) = evaluate(&policy, "agent:a", &p, &req);
        assert!(allow);
        assert_eq!(obligations, vec![OBLIGATION_REQUIRE_APPROVAL.to_string()]);
    }

    #[test]
    fn deny_rules_override_grants() {
        let mut policy = PolicyDocument::default();
        policy.deny_rules.push(DenyRule {
            id: "no-review-for-bot".into(),
            actions: vec!["task.submit".into()],
            principals: vec!["agent:bot/*".into()],
            capabilities: vec!["code.review".into()],
            reason: "bots may not request reviews".into(),
            ..Default::default()
        });
        let req = AuthzRequest::action(Action::TaskSubmit).capability("code.review", SideEffects::Read);
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

    #[test]
    fn delegation_depth_is_enforced() {
        let policy = PolicyDocument::default();
        let mut p = perms();
        p.actions.push("task.delegate".into());
        p.delegation = DelegationPerm { allowed: true, max_depth: 2 };
        let mut req = AuthzRequest::action(Action::TaskDelegate).capability("code.review", SideEffects::Read);
        req.delegation_remaining = Some(1);
        assert!(evaluate(&policy, "agent:a", &p, &req).0);
        req.delegation_remaining = Some(0);
        assert!(!evaluate(&policy, "agent:a", &p, &req).0);
    }
}

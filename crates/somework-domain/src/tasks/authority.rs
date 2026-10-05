//! Effective task authority (confused-deputy protection). A worker never executes with "whatever it can
//! normally do": its authority for a task is the intersection of its own maximum, the capability's declared
//! class, the requester's delegation, the task-specific grant and current policy.

use serde::{Deserialize, Serialize};
use somework_core::{
    classification::{ClassificationScale, any_glob},
    contracts::{Action, SideEffects},
};

use crate::policy::{DelegationPerm, Permissions, PolicyDocument};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EffectiveAuthority {
    pub side_effects_at_most: SideEffects,
    pub classification_max: String,
    pub actions: Vec<String>,
    pub agent_capabilities: Vec<String>,
    pub requester_capabilities: Vec<String>,
    pub delegation_allowed: bool,
    pub delegation_remaining: u32,
    pub policy_version: String,
}

/// Actions a worker may exercise while acting on behalf of a task.
const TASK_ACTIONS: &[Action] = &[
    Action::TaskRead,
    Action::TaskUpdate,
    Action::ArtifactRead,
    Action::ArtifactWrite,
    Action::ContextRead,
    Action::ContextWrite,
    Action::MessageSend,
    Action::CatalogRead,
];

pub struct AuthorityInputs<'a> {
    pub agent: &'a Permissions,
    pub requester: &'a Permissions,
    pub capability_side_effects: SideEffects,
    pub task_constraint: Option<SideEffects>,
    pub delegation_remaining: u32,
    pub parent: Option<&'a EffectiveAuthority>,
    pub policy: &'a PolicyDocument,
}

impl EffectiveAuthority {
    pub fn compute(i: AuthorityInputs<'_>) -> Self {
        let scale = i.policy.scale();
        let mut side_effects = i.agent.side_effects_max().min(i.capability_side_effects);
        if let Some(c) = i.task_constraint {
            side_effects = side_effects.min(c);
        }
        let mut classification = scale.min(i.agent.classification_limit(), i.requester.classification_limit()).to_string();
        let mut actions: Vec<String> = TASK_ACTIONS.iter().filter(|a| i.agent.allows_action(a.as_str())).map(|a| a.as_str().to_string()).collect();
        let delegation_allowed =
            i.agent.delegation.allowed && i.requester.delegation.allowed && i.delegation_remaining > 0 && i.agent.allows_action("task.delegate");
        if delegation_allowed {
            actions.push("task.delegate".into());
        }
        let mut requester_capabilities = i.requester.capabilities.clone();
        let mut remaining = i.delegation_remaining;
        let mut delegation = delegation_allowed;
        if let Some(parent) = i.parent {
            side_effects = side_effects.min(parent.side_effects_at_most);
            classification = scale.min(&classification, &parent.classification_max).to_string();
            actions.retain(|a| parent.actions.contains(a));
            requester_capabilities = parent.requester_capabilities.clone();
            remaining = remaining.min(parent.delegation_remaining.saturating_sub(1));
            delegation = delegation && parent.delegation_allowed && remaining > 0;
            if !delegation {
                actions.retain(|a| a != "task.delegate");
            }
        }
        Self {
            side_effects_at_most: side_effects,
            classification_max: classification,
            actions,
            agent_capabilities: i.agent.capabilities.clone(),
            requester_capabilities,
            delegation_allowed: delegation,
            delegation_remaining: remaining,
            policy_version: i.policy.version.clone(),
        }
    }

    /// Invocation rights for delegation: both the worker and the original requester must be allowed to use `id`.
    pub fn capability_allowed(&self, id: &str) -> bool {
        any_glob(&self.agent_capabilities, id) && any_glob(&self.requester_capabilities, id)
    }

    pub fn permits_side_effects(&self, se: SideEffects) -> bool {
        se <= self.side_effects_at_most
    }

    pub fn permits_classification(&self, scale: &ClassificationScale, level: &str) -> bool {
        scale.permits(&self.classification_max, level)
    }

    pub fn as_permissions(&self) -> Permissions {
        Permissions {
            actions: self.actions.clone(),
            capabilities: self.agent_capabilities.clone(),
            classification_max: Some(self.classification_max.clone()),
            side_effects_at_most: Some(self.side_effects_at_most),
            delegation: DelegationPerm { allowed: self.delegation_allowed, max_depth: self.delegation_remaining },
            ..Default::default()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn perms(se: SideEffects, caps: &[&str]) -> Permissions {
        let mut p = Permissions::default_agent();
        p.side_effects_at_most = Some(se);
        p.capabilities = caps.iter().map(|c| c.to_string()).collect();
        p.delegation = DelegationPerm { allowed: true, max_depth: 3 };
        p.actions.push("task.delegate".into());
        p
    }

    #[test]
    fn read_only_capability_does_not_inherit_the_workers_write_power() {
        let policy = PolicyDocument::default();
        let worker = perms(SideEffects::Irreversible, &["*"]);
        let requester = perms(SideEffects::Read, &["deployment.inspect"]);
        let auth = EffectiveAuthority::compute(AuthorityInputs {
            agent: &worker,
            requester: &requester,
            capability_side_effects: SideEffects::Read,
            task_constraint: None,
            delegation_remaining: 2,
            parent: None,
            policy: &policy,
        });
        assert_eq!(auth.side_effects_at_most, SideEffects::Read);
        assert!(!auth.permits_side_effects(SideEffects::Irreversible));
        assert!(auth.capability_allowed("deployment.inspect"));
        assert!(!auth.capability_allowed("deployment.execute"), "requester may not cause execute even though the worker could");
    }

    #[test]
    fn delegation_depth_decrements_through_the_chain() {
        let policy = PolicyDocument::default();
        let worker = perms(SideEffects::Write, &["*"]);
        let requester = perms(SideEffects::Write, &["*"]);
        let root = EffectiveAuthority::compute(AuthorityInputs {
            agent: &worker,
            requester: &requester,
            capability_side_effects: SideEffects::Write,
            task_constraint: None,
            delegation_remaining: 1,
            parent: None,
            policy: &policy,
        });
        assert!(root.delegation_allowed);
        let child = EffectiveAuthority::compute(AuthorityInputs {
            agent: &worker,
            requester: &worker,
            capability_side_effects: SideEffects::Write,
            task_constraint: None,
            delegation_remaining: 0,
            parent: Some(&root),
            policy: &policy,
        });
        assert!(!child.delegation_allowed);
        assert!(!child.actions.iter().any(|a| a == "task.delegate"));
    }

    #[test]
    fn classification_is_the_lower_of_worker_and_requester() {
        let policy = PolicyDocument::default();
        let mut worker = perms(SideEffects::Read, &["*"]);
        worker.classification_max = Some("restricted".into());
        let mut requester = perms(SideEffects::Read, &["*"]);
        requester.classification_max = Some("internal".into());
        let auth = EffectiveAuthority::compute(AuthorityInputs {
            agent: &worker,
            requester: &requester,
            capability_side_effects: SideEffects::Read,
            task_constraint: None,
            delegation_remaining: 0,
            parent: None,
            policy: &policy,
        });
        assert_eq!(auth.classification_max, "internal");
        assert!(!auth.permits_classification(&policy.scale(), "restricted"));
    }
}

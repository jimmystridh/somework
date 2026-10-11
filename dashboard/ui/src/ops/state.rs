//! What an agent's saved setup is doing: applied, pending, rejected, or not to be known. Pure, so the words and colours are tested.

use fleet_shared::operations::{DeliveryView, OpsAgent, RejectedSetup};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SetupState {
    /// Nothing was saved: the agent runs its role's own setup.
    Default,
    Applied,
    /// Saved, not applied yet; the agent has had no chance to say otherwise.
    Pending,
    /// The agent refused the revision and kept its previous setup.
    Rejected(String),
    /// The agent's profile cannot be read, so what it applied is not known.
    Unreachable,
    /// The agent answers but reports no setup (a kit too old to take one): Operations cannot see the effect.
    NotReported,
}

impl SetupState {
    pub fn label(&self) -> &'static str {
        match self {
            Self::Default => "role default",
            Self::Applied => "applied",
            Self::Pending => "pending",
            Self::Rejected(_) => "rejected",
            Self::Unreachable => "agent unreachable",
            Self::NotReported => "not reported",
        }
    }

    /// A class of the stylesheet (`status <class>`).
    pub fn class(&self) -> &'static str {
        match self {
            Self::Default => "default",
            Self::Applied => "applied",
            Self::Pending => "pending",
            Self::Rejected(_) => "rejected",
            Self::Unreachable => "unreachable",
            Self::NotReported => "notreported",
        }
    }

    pub fn needs_attention(&self) -> bool {
        matches!(self, Self::Rejected(_) | Self::Unreachable)
    }

    /// The state in a few words, with the agent's reason for a rejection.
    pub fn summary(&self, agent: &OpsAgent) -> String {
        let last = last_applied(agent.applied_revision);
        match self {
            Self::Default => "Nothing saved: the agent runs its role's own setup.".into(),
            Self::Applied => format!("Revision {} is in effect.", agent.saved_revision),
            Self::Pending => format!("Revision {} is saved and not applied yet ({last}).", agent.saved_revision),
            Self::Rejected(reason) => format!("The agent rejected revision {} and keeps its previous setup ({last}): {reason}", agent.saved_revision),
            Self::Unreachable => format!("The agent cannot be reached; revision {} is saved ({last}). It applies when the agent returns.", agent.saved_revision),
            Self::NotReported => format!("The agent reports no setup (its kit is too old); revision {} was sent once and its effect cannot be seen.", agent.saved_revision),
        }
    }
}

fn last_applied(applied: Option<u64>) -> String {
    match applied {
        Some(revision) => format!("last applied: revision {revision}"),
        None => "none known to be applied".into(),
    }
}

/// A rejection counts against the saved revision only: a newer save replaces the rejected one, which is then pending again.
fn override_rejection(agent: &OpsAgent) -> Option<&RejectedSetup> {
    agent.rejected.as_ref().filter(|rejected| rejected.kind == "override" && agent.saved_revision > 0 && rejected.revision >= agent.saved_revision)
}

pub fn classify(agent: &OpsAgent) -> SetupState {
    if agent.saved_revision == 0 {
        return SetupState::Default;
    }
    if let Some(rejected) = override_rejection(agent) {
        return SetupState::Rejected(rejected.reason.clone());
    }
    if agent.applied_revision.is_some_and(|applied| applied >= agent.saved_revision) {
        return SetupState::Applied;
    }
    if !agent.reachable {
        return SetupState::Unreachable;
    }
    if !agent.reports_setup {
        return SetupState::NotReported;
    }
    SetupState::Pending
}

/// `saved 3 · applied 2`, with `—` where a revision does not exist or is not known.
pub fn revision_pair(agent: &OpsAgent) -> String {
    let revision = |value: Option<u64>| value.filter(|revision| *revision > 0).map(|revision| revision.to_string()).unwrap_or_else(|| "—".into());
    format!("saved {} · applied {}", revision(Some(agent.saved_revision)), revision(agent.applied_revision))
}

/// A failed send is shown wherever its revision is shown.
pub fn delivery_problem(delivery: &DeliveryView) -> Option<String> {
    delivery.error.as_ref().map(|error| {
        let times = if delivery.failures > 1 { format!(" ({} times in a row)", delivery.failures) } else { String::new() };
        format!("Sending failed{times}: {error}")
    })
}

/// How the fleet limits stand for one agent next to the latest saved revision (`current`, 0 when none exists).
pub fn limits_note(agent: &OpsAgent, current: u64) -> Option<String> {
    if let Some(rejected) = agent.rejected.as_ref().filter(|rejected| rejected.kind == "limits") {
        return Some(format!("limits {} rejected: {}", rejected.revision, rejected.reason));
    }
    if current == 0 {
        return None;
    }
    match agent.applied_limits_revision {
        Some(applied) if applied >= current => Some(format!("limits {current} applied")),
        Some(applied) => Some(format!("limits {applied} of {current}")),
        None => Some(format!("limits {current} not applied yet")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn agent(saved: u64, applied: Option<u64>) -> OpsAgent {
        OpsAgent { id: "agent/qa".into(), slug: "qa".into(), reachable: true, reports_setup: true, saved_revision: saved, applied_revision: applied, pending: applied.unwrap_or(0) < saved, ..Default::default() }
    }

    fn rejection(kind: &str, revision: u64) -> Option<RejectedSetup> {
        Some(RejectedSetup { kind: kind.into(), revision, reason: "the model is not allowed".into(), at: None })
    }

    #[test]
    fn nothing_saved_is_the_role_default() {
        assert_eq!(classify(&agent(0, None)), SetupState::Default);
        assert_eq!(classify(&agent(0, Some(2))), SetupState::Default, "an applied revision without a saved one is nothing to compare");
    }

    #[test]
    fn a_saved_revision_the_agent_reports_is_applied() {
        assert_eq!(classify(&agent(3, Some(3))), SetupState::Applied);
        assert_eq!(classify(&agent(3, Some(4))), SetupState::Applied);
    }

    #[test]
    fn a_saved_revision_the_agent_has_not_reached_is_pending() {
        assert_eq!(classify(&agent(3, Some(2))), SetupState::Pending);
        assert_eq!(classify(&agent(1, None)), SetupState::Pending);
    }

    #[test]
    fn a_rejection_of_the_saved_revision_shows_its_reason_and_beats_pending() {
        let mut rejected = agent(3, Some(2));
        rejected.rejected = rejection("override", 3);
        assert_eq!(classify(&rejected), SetupState::Rejected("the model is not allowed".into()));
        assert!(classify(&rejected).summary(&rejected).contains("the model is not allowed"));
        assert!(classify(&rejected).summary(&rejected).contains("revision 2"));
    }

    #[test]
    fn a_newer_save_replaces_a_rejected_one_and_a_limits_rejection_is_not_about_the_setup() {
        let mut newer = agent(4, Some(2));
        newer.rejected = rejection("override", 3);
        assert_eq!(classify(&newer), SetupState::Pending);
        let mut limits = agent(3, Some(3));
        limits.rejected = rejection("limits", 5);
        assert_eq!(classify(&limits), SetupState::Applied);
    }

    #[test]
    fn an_agent_that_cannot_be_read_is_unreachable_unless_its_last_report_already_covers_the_revision() {
        let mut gone = agent(3, Some(2));
        gone.reachable = false;
        assert_eq!(classify(&gone), SetupState::Unreachable);
        assert!(classify(&gone).needs_attention());
        gone.applied_revision = Some(3);
        assert_eq!(classify(&gone), SetupState::Applied);
    }

    #[test]
    fn an_old_kit_is_not_reported_rather_than_pending_for_ever() {
        let mut old = agent(2, None);
        old.reports_setup = false;
        assert_eq!(classify(&old), SetupState::NotReported);
        assert_eq!(classify(&old).label(), "not reported");
    }

    #[test]
    fn the_summary_says_where_the_agent_stands_in_plain_words() {
        let pending = agent(3, Some(2));
        assert_eq!(classify(&pending).summary(&pending), "Revision 3 is saved and not applied yet (last applied: revision 2).");
        let fresh = agent(1, None);
        assert_eq!(classify(&fresh).summary(&fresh), "Revision 1 is saved and not applied yet (none known to be applied).");
        let mut gone = agent(3, Some(2));
        gone.reachable = false;
        assert!(classify(&gone).summary(&gone).starts_with("The agent cannot be reached; revision 3 is saved (last applied: revision 2)."));
    }

    #[test]
    fn revisions_read_as_a_pair() {
        assert_eq!(revision_pair(&agent(3, Some(2))), "saved 3 · applied 2");
        assert_eq!(revision_pair(&agent(0, None)), "saved — · applied —");
        assert_eq!(revision_pair(&agent(1, None)), "saved 1 · applied —");
    }

    #[test]
    fn a_failed_send_is_named_with_its_count() {
        let delivery = DeliveryView { error: Some("the domain refused the message".into()), failures: 3, ..Default::default() };
        assert_eq!(delivery_problem(&delivery).as_deref(), Some("Sending failed (3 times in a row): the domain refused the message"));
        assert_eq!(delivery_problem(&DeliveryView::default()), None);
    }

    #[test]
    fn limits_are_compared_with_the_latest_saved_revision() {
        let mut limited = agent(0, None);
        assert_eq!(limits_note(&limited, 0), None);
        assert_eq!(limits_note(&limited, 4).as_deref(), Some("limits 4 not applied yet"));
        limited.applied_limits_revision = Some(3);
        assert_eq!(limits_note(&limited, 4).as_deref(), Some("limits 3 of 4"));
        limited.applied_limits_revision = Some(4);
        assert_eq!(limits_note(&limited, 4).as_deref(), Some("limits 4 applied"));
        limited.rejected = rejection("limits", 5);
        assert_eq!(limits_note(&limited, 5).as_deref(), Some("limits 5 rejected: the model is not allowed"));
    }
}

//! Pure task state machine (TASK-01..07). The domain layer persists transitions; this module only decides
//! which transitions are legal so the rules can be property-tested without a database.

use serde::{Deserialize, Serialize};

use crate::error::{Error, ErrorCode};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum TaskState {
    Submitted,
    Queued,
    Claimed,
    Running,
    InputRequired,
    Blocked,
    CancelRequested,
    Succeeded,
    Failed,
    Rejected,
    Canceled,
    Expired,
}

pub const ALL_STATES: [TaskState; 12] = [
    TaskState::Submitted,
    TaskState::Queued,
    TaskState::Claimed,
    TaskState::Running,
    TaskState::InputRequired,
    TaskState::Blocked,
    TaskState::CancelRequested,
    TaskState::Succeeded,
    TaskState::Failed,
    TaskState::Rejected,
    TaskState::Canceled,
    TaskState::Expired,
];

impl TaskState {
    pub fn as_str(self) -> &'static str {
        use TaskState::*;
        match self {
            Submitted => "submitted",
            Queued => "queued",
            Claimed => "claimed",
            Running => "running",
            InputRequired => "input_required",
            Blocked => "blocked",
            CancelRequested => "cancel_requested",
            Succeeded => "succeeded",
            Failed => "failed",
            Rejected => "rejected",
            Canceled => "canceled",
            Expired => "expired",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        ALL_STATES.into_iter().find(|s| s.as_str() == raw)
    }

    pub fn is_terminal(self) -> bool {
        use TaskState::*;
        matches!(self, Succeeded | Failed | Rejected | Canceled | Expired)
    }

    /// States in which a runtime holds (or held) a lease on the task.
    pub fn is_leased(self) -> bool {
        use TaskState::*;
        matches!(self, Claimed | Running | InputRequired | Blocked | CancelRequested)
    }
}

impl std::fmt::Display for TaskState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Event {
    /// Routing finalized and authorized (`submitted` -> `queued`).
    Route,
    /// Request identified but not accepted (`submitted` -> `rejected`).
    Reject,
    /// Requester asks for cancellation; immediate before a runtime owns the task, cooperative afterwards.
    Cancel,
    /// Assignee acknowledges a cooperative cancellation.
    AckCancel,
    /// Deadline passed before a runtime started the work.
    Expire,
    Claim,
    Start,
    RequireInput,
    Block,
    Resume,
    Complete,
    Fail,
    /// Lease lapsed. `retry_safe=false` parks the task for reconciliation (TASK-06).
    LeaseExpired {
        retry_safe: bool,
    },
}

pub fn next_state(from: TaskState, event: Event) -> Result<TaskState, Error> {
    use Event::*;
    use TaskState::*;
    if from.is_terminal() {
        return Err(Error::new(ErrorCode::TaskTerminal, format!("task is {from}; terminal states are immutable"))
            .with_details(serde_json::json!({"state": from.as_str()})));
    }
    let to = match (from, event) {
        (Submitted, Route) => Queued,
        (Submitted, Reject) => Rejected,
        (Submitted, Cancel) | (Queued, Cancel) => Canceled,
        (Submitted, Expire) | (Queued, Expire) => Expired,
        (Queued, Claim) => Claimed,
        (Claimed, Start) | (InputRequired, Resume) | (Blocked, Resume) => Running,
        (Running, RequireInput) => InputRequired,
        (Running, Block) => Blocked,
        (Claimed | Running | InputRequired | Blocked, Cancel) | (CancelRequested, Cancel) => CancelRequested,
        (CancelRequested, AckCancel) => Canceled,
        (Running | CancelRequested, Complete) => Succeeded,
        (Running | CancelRequested, Fail) => Failed,
        (CancelRequested, LeaseExpired { .. }) => Canceled,
        (Claimed | Running | InputRequired, LeaseExpired { retry_safe: true }) | (Blocked, LeaseExpired { retry_safe: true }) => Queued,
        (Claimed | Running | InputRequired | Blocked, LeaseExpired { retry_safe: false }) => Blocked,
        _ => {
            return Err(Error::new(ErrorCode::InvalidTransition, format!("event {event:?} is not valid in state {from}"))
                .with_details(serde_json::json!({"state": from.as_str(), "event": format!("{event:?}")})));
        }
    };
    Ok(to)
}

/// Whether `from -> to` is an edge of the lifecycle diagram, independent of the triggering event.
pub fn is_legal_edge(from: TaskState, to: TaskState) -> bool {
    use TaskState::*;
    if from.is_terminal() {
        return false;
    }
    matches!(
        (from, to),
        (Submitted, Queued | Rejected | Canceled | Expired)
            | (Queued, Claimed | Canceled | Expired)
            | (Claimed, Queued | Running | CancelRequested | Blocked)
            | (Running, InputRequired | Blocked | CancelRequested | Succeeded | Failed | Queued)
            | (InputRequired, Running | CancelRequested | Queued | Blocked)
            | (Blocked, Running | CancelRequested | Queued | Blocked)
            | (CancelRequested, Canceled | Succeeded | Failed | CancelRequested)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const EVENTS: [Event; 15] = [
        Event::Route,
        Event::Reject,
        Event::Cancel,
        Event::AckCancel,
        Event::Expire,
        Event::Claim,
        Event::Start,
        Event::RequireInput,
        Event::Block,
        Event::Resume,
        Event::Complete,
        Event::Fail,
        Event::LeaseExpired { retry_safe: true },
        Event::LeaseExpired { retry_safe: false },
        Event::Cancel,
    ];

    #[test]
    fn terminal_states_reject_every_event() {
        for state in ALL_STATES.into_iter().filter(|s| s.is_terminal()) {
            for event in EVENTS {
                let err = next_state(state, event).unwrap_err();
                assert_eq!(err.code, ErrorCode::TaskTerminal);
            }
        }
    }

    #[test]
    fn every_accepted_transition_is_a_legal_edge() {
        for from in ALL_STATES {
            for event in EVENTS {
                if let Ok(to) = next_state(from, event) {
                    assert!(is_legal_edge(from, to), "{from} --{event:?}--> {to} is not in the lifecycle diagram");
                }
            }
        }
    }

    #[test]
    fn happy_path() {
        let mut s = TaskState::Submitted;
        for e in [Event::Route, Event::Claim, Event::Start, Event::Complete] {
            s = next_state(s, e).unwrap();
        }
        assert_eq!(s, TaskState::Succeeded);
    }

    #[test]
    fn cancellation_race_may_resolve_to_completed() {
        let s = next_state(TaskState::Running, Event::Cancel).unwrap();
        assert_eq!(s, TaskState::CancelRequested);
        assert_eq!(next_state(s, Event::Complete).unwrap(), TaskState::Succeeded);
        assert_eq!(next_state(s, Event::Fail).unwrap(), TaskState::Failed);
        assert_eq!(next_state(s, Event::AckCancel).unwrap(), TaskState::Canceled);
    }

    #[test]
    fn queued_cancel_is_immediate() {
        assert_eq!(next_state(TaskState::Queued, Event::Cancel).unwrap(), TaskState::Canceled);
    }

    #[test]
    fn irreversible_lease_expiry_never_requeues() {
        for s in [TaskState::Claimed, TaskState::Running, TaskState::InputRequired, TaskState::Blocked] {
            assert_eq!(next_state(s, Event::LeaseExpired { retry_safe: false }).unwrap(), TaskState::Blocked);
            assert_eq!(next_state(s, Event::LeaseExpired { retry_safe: true }).unwrap(), TaskState::Queued);
        }
    }

    #[test]
    fn complete_requires_running() {
        for s in [TaskState::Submitted, TaskState::Queued, TaskState::Claimed, TaskState::InputRequired, TaskState::Blocked] {
            assert_eq!(next_state(s, Event::Complete).unwrap_err().code, ErrorCode::InvalidTransition);
        }
    }
}

#[cfg(test)]
mod property_tests {
    use proptest::prelude::*;

    use super::*;

    fn event_strategy() -> impl Strategy<Value = Event> {
        prop_oneof![
            Just(Event::Route),
            Just(Event::Reject),
            Just(Event::Cancel),
            Just(Event::AckCancel),
            Just(Event::Expire),
            Just(Event::Claim),
            Just(Event::Start),
            Just(Event::RequireInput),
            Just(Event::Block),
            Just(Event::Resume),
            Just(Event::Complete),
            Just(Event::Fail),
            Just(Event::LeaseExpired { retry_safe: true }),
            Just(Event::LeaseExpired { retry_safe: false }),
        ]
    }

    proptest! {
        /// Whatever sequence of events is thrown at the machine: transitions stay on lifecycle edges and a
        /// terminal state, once reached, never changes (TASK-04).
        #[test]
        fn random_event_sequences_respect_the_lifecycle(events in proptest::collection::vec(event_strategy(), 0..64)) {
            let mut state = TaskState::Submitted;
            let mut terminal_at: Option<TaskState> = None;
            for event in events {
                match next_state(state, event) {
                    Ok(to) => {
                        prop_assert!(terminal_at.is_none(), "transition accepted after terminal state");
                        prop_assert!(is_legal_edge(state, to));
                        state = to;
                        if state.is_terminal() {
                            terminal_at = Some(state);
                        }
                    }
                    Err(err) => {
                        if state.is_terminal() {
                            prop_assert_eq!(err.code, ErrorCode::TaskTerminal);
                        }
                        prop_assert_eq!(state, terminal_at.unwrap_or(state));
                    }
                }
            }
        }
    }
}

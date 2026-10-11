//! The revision log of one agent: who saved what and when, what changed against the revision before, and restore as a new revision.

use crate::{
    api::{self, Method},
    format::when_ago,
    live::Live,
    ops::diff::{DiffView, summary},
    session::use_session,
    widgets::{Confirm, Outcome, OutcomeNotice, Waiting, use_api},
};
use dioxus::prelude::*;
use fleet_shared::operations::{OpsAgentDetail, RevisionList, RevisionWithDiff, SetupSaved};

/// What a revision is in relation to the agent: the one saved last, the one it applied, the one it refused.
pub fn marks(revision: u64, saved: u64, applied: Option<u64>, rejected: Option<u64>) -> Vec<&'static str> {
    let mut marks = Vec::new();
    if revision == saved {
        marks.push("current");
    }
    if applied == Some(revision) {
        marks.push("applied");
    }
    if rejected == Some(revision) {
        marks.push("rejected");
    }
    marks
}

#[component]
pub fn Revisions(slug: String, detail: OpsAgentDetail, on_changed: EventHandler<()>) -> Element {
    let list = use_api::<RevisionList>(format!("/agents/{}/revisions", api::segment(&slug)), None);
    let Some(data) = list.get() else {
        return rsx! { Waiting { what: "the revisions", failure: list.failed() } };
    };
    let saved = detail.agent.saved_revision;
    let applied = detail.agent.applied_revision;
    let rejected = detail.agent.rejected.as_ref().filter(|rejected| rejected.kind == "override").map(|rejected| rejected.revision);
    rsx! {
        p { class: "hint", "Every save is a new revision; none is ever changed or removed. Restoring an old revision saves its content again as a new one." }
        if data.revisions.is_empty() { p { class: "empty", "Nothing has been saved for this agent yet." } }
        div { class: "revisions",
            for item in data.revisions {
                RevisionCard { key: "{item.revision.revision}", slug: slug.clone(), item: item.clone(), marks: marks(item.revision.revision, saved, applied, rejected), on_changed: move |_| { list.restart(); on_changed.call(()); } }
            }
        }
    }
}

#[component]
fn RevisionCard(slug: String, item: RevisionWithDiff, marks: Vec<&'static str>, on_changed: EventHandler<()>) -> Element {
    let session = use_session();
    let live = use_context::<Live>();
    let now = *live.now.read();
    let mut confirming = use_signal(|| false);
    let mut busy = use_signal(|| false);
    let mut outcome = use_signal(|| Outcome::None);
    let revision = item.revision.clone();
    let number = revision.revision;
    let current = marks.contains(&"current");
    let heading = summary(&item.diff);
    let note = if revision.note.is_empty() { "no note".to_string() } else { revision.note.clone() };
    let at = when_ago(Some(&revision.created_at), now);
    let restore = move |_| {
        let path = format!("/agents/{}/revisions/{number}/restore", api::segment(&slug));
        busy.set(true);
        spawn(async move {
            match api::write::<(), SetupSaved>(Method::Post, &path, None).await {
                Ok(saved) => {
                    outcome.set(Outcome::Saved(format!("Restored revision {number} as revision {}.", saved.revision.revision)));
                    confirming.set(false);
                    on_changed.call(());
                }
                Err(failure) => {
                    outcome.set(Outcome::Failed(failure));
                    confirming.set(false);
                }
            }
            busy.set(false);
        });
    };
    rsx! {
        article { class: "platform-card revision", "aria-label": "Revision {number}",
            h4 {
                "Revision {number}"
                for mark in marks.iter() { span { key: "{mark}", class: "chip {mark_class(mark)}", "{mark}" } }
                small { "{at}" }
            }
            p { class: "meta", "{revision.author} · {note}" }
            details {
                summary { "Changed: {heading}" }
                DiffView { entries: item.diff.clone() }
            }
            if session.can_edit() && !current {
                div { class: "buttons", button { class: "plain", onclick: move |_| confirming.set(true), "Restore revision {number}" } }
            }
            if confirming() {
                Confirm {
                    question: format!("Restore revision {number}? Its content is saved again as a new revision and sent to the agent; the revisions after it stay in the log."),
                    action: format!("Restore revision {number}"),
                    busy: busy(),
                    onconfirm: restore,
                    oncancel: move |_| confirming.set(false),
                }
            }
            OutcomeNotice { outcome: outcome.read().clone() }
        }
    }
}

fn mark_class(mark: &str) -> &'static str {
    match mark {
        "current" => "read",
        "rejected" => "bad",
        _ => "good",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_revision_is_marked_by_what_the_agent_did_with_it() {
        assert_eq!(marks(3, 3, Some(3), None), ["current", "applied"]);
        assert_eq!(marks(3, 4, Some(3), None), ["applied"]);
        assert_eq!(marks(4, 4, Some(3), Some(4)), ["current", "rejected"]);
        assert!(marks(1, 4, Some(3), None).is_empty());
    }
}

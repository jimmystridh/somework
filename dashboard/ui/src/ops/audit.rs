//! The audit trail: who did what to which thing, newest first. Notes and details are short words, never content.

use crate::{
    api,
    format::{ago, plural, when},
    live::Live,
    shell::Gate,
    widgets::{ErrorNotice, Waiting},
};
use dioxus::prelude::*;
use fleet_shared::operations::{AuditEntry, AuditPage};

const PAGE: usize = 100;

/// What an audit action says in words.
pub fn action_text(action: &str) -> &str {
    match action {
        "setup.save" => "saved a setup",
        "setup.reset" => "reset a setup",
        "setup.restore" => "restored a setup revision",
        "setup.resend" => "sent a setup again",
        "catalog.put" => "saved a catalog entry",
        "catalog.delete" => "deleted a catalog entry",
        "library.put" => "saved a library skill",
        "library.delete" => "deleted a library skill",
        "limits.put" => "saved the fleet limits",
        "user.put" => "added or changed a user",
        "user.delete" => "removed a user",
        "signin" => "signed in",
        "signin.refused" => "was refused at sign-in",
        other => other,
    }
}

/// The entries that contain every word of the filter in their actor, action, target or detail.
pub fn matching<'a>(entries: &'a [AuditEntry], filter: &str) -> Vec<&'a AuditEntry> {
    let words: Vec<String> = filter.split_whitespace().map(str::to_lowercase).collect();
    entries
        .iter()
        .filter(|entry| {
            let text = format!("{} {} {} {} {}", entry.actor, entry.action, action_text(&entry.action), entry.target, entry.detail).to_lowercase();
            words.iter().all(|word| text.contains(word))
        })
        .collect()
}

pub fn is_refusal(entry: &AuditEntry) -> bool {
    entry.action == "signin.refused"
}

#[component]
pub fn Audit() -> Element {
    rsx! { Gate { admin: false, AuditPage_ {} } }
}

#[component]
fn AuditPage_() -> Element {
    let mut entries = use_signal(Vec::<AuditEntry>::new);
    let mut loaded = use_signal(|| false);
    let mut failure = use_signal(|| None::<api::Failure>);
    let mut more = use_signal(|| false);
    let mut busy = use_signal(|| false);
    let mut filter = use_signal(String::new);
    let live = use_context::<Live>();
    let now = *live.now.read();

    let load = move |before: Option<u64>| async move {
        busy.set(true);
        let path = match before {
            Some(id) => format!("/audit?limit={PAGE}&before={id}"),
            None => format!("/audit?limit={PAGE}"),
        };
        match api::get::<AuditPage>(&path).await {
            Ok(page) => {
                more.set(page.entries.len() >= PAGE);
                if before.is_some() {
                    entries.write().extend(page.entries);
                } else {
                    entries.set(page.entries);
                }
                failure.set(None);
                loaded.set(true);
            }
            Err(error) => failure.set(Some(error)),
        }
        busy.set(false);
    };
    use_future(move || load(None));

    if !loaded() {
        return rsx! { h1 { class: "page-title", "Audit" }, Waiting { what: "the audit trail", failure: failure.read().clone() } };
    }
    let all = entries.read().clone();
    let typed = filter.read().clone();
    let shown = matching(&all, &typed);
    let count = plural(shown.len(), "entry", "entries");
    let oldest = all.last().map(|entry| entry.id);
    rsx! {
        h1 { class: "page-title", "Audit" }
        p { class: "lede", "Who did what, newest first. Entries say what was done and to which thing, never the content." }
        if let Some(error) = failure.read().clone() { ErrorNotice { failure: error } }
        div { class: "field audit-filter",
            label { r#for: "audit-filter", "Filter" }
            input { id: "audit-filter", r#type: "search", value: "{typed}", placeholder: "person, action or thing", oninput: move |event| filter.set(event.value()) }
        }
        div { class: "machine-table", table {
            caption { "{count} shown of {all.len()} loaded · times are UTC" }
            thead { tr { th { "When" }, th { "Who" }, th { "What" }, th { "Thing" }, th { "Detail" } } }
            tbody {
                if shown.is_empty() { tr { td { colspan: "5", class: "empty", "Nothing matches." } } }
                for entry in shown {
                    tr { key: "{entry.id}",
                        td { span { class: "numeric", "{when(&entry.at)}" }, small { "{ago(Some(&entry.at), now)}" } }
                        td { "{entry.actor}" }
                        td { span { class: if is_refusal(entry) { "chip bad" } else { "chip" }, "{action_text(&entry.action)}" }, small { class: "plain-small", "{entry.action}" } }
                        td { span { class: "numeric wrap", "{entry.target}" } }
                        td { small { class: "wrap plain-small", "{entry.detail}" } }
                    }
                }
            }
        } }
        if more() { p { class: "more", button { class: "tab", disabled: busy(), onclick: move |_| { spawn(load(oldest)); }, "Load older entries" } } }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: u64, actor: &str, action: &str, target: &str, detail: &str) -> AuditEntry {
        AuditEntry { id, at: "2026-10-10T10:00:00.000Z".into(), actor: actor.into(), action: action.into(), target: target.into(), detail: detail.into() }
    }

    #[test]
    fn actions_read_as_words_and_unknown_ones_as_they_are() {
        assert_eq!(action_text("setup.save"), "saved a setup");
        assert_eq!(action_text("signin.refused"), "was refused at sign-in");
        assert_eq!(action_text("something.new"), "something.new");
    }

    #[test]
    fn the_filter_needs_every_word_in_any_column() {
        let all = [entry(3, "jane@example.com", "setup.save", "agent/qa", "revision 7"), entry(2, "bob@example.com", "catalog.put", "docs", "revision 2"), entry(1, "jane@example.com", "signin", "jane@example.com", "")];
        assert_eq!(matching(&all, "").len(), 3);
        assert_eq!(matching(&all, "jane").len(), 2);
        assert_eq!(matching(&all, "jane saved").iter().map(|e| e.id).collect::<Vec<_>>(), [3], "the words of the action count too");
        assert_eq!(matching(&all, "revision 2").iter().map(|e| e.id).collect::<Vec<_>>(), [2]);
        assert!(matching(&all, "nobody").is_empty());
    }

    #[test]
    fn a_refused_sign_in_is_the_one_to_notice() {
        assert!(is_refusal(&entry(1, "x", "signin.refused", "", "")));
        assert!(!is_refusal(&entry(1, "x", "signin", "", "")));
    }
}

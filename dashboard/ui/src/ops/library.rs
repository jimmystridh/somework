//! The skill library: skills written once, kept by Operations and offered to every agent as `library/<name>`. An agent uses one only when
//! its setup enables it.

use crate::{
    api::{self, Method},
    format::{plural, when_ago},
    live::Live,
    ops::{
        diff::{DiffView, summary},
        validate::{Problem, skill_counter, skill_description, skill_problems},
    },
    session::use_session,
    shell::Gate,
    widgets::{Confirm, CounterText, ErrorNotice, FieldMessage, Outcome, OutcomeNotice, Waiting, use_api},
};
use dioxus::prelude::*;
use fleet_shared::operations::{LibraryList, LibraryPut, LibraryRevisionList, LibrarySkillDetail, LibrarySkillView};

/// What a new skill starts from: the front matter the agents' skill loaders read.
pub const TEMPLATE: &str = "---\nname: my-skill\ndescription: One sentence on when to use this skill.\n---\n\n# My skill\n\nWrite the guidance here.\n";

#[derive(Clone, Debug, PartialEq, Eq)]
enum Selection {
    New,
    Existing(String),
}

impl Selection {
    fn key(&self) -> String {
        match self {
            Self::New => "new".into(),
            Self::Existing(name) => format!("skill-{name}"),
        }
    }
}

pub fn size_text(bytes: u64) -> String {
    match bytes {
        0..=1023 => format!("{bytes} B"),
        _ => format!("{:.1} KiB", bytes as f64 / 1024.0),
    }
}

#[component]
pub fn Library() -> Element {
    rsx! { Gate { admin: false, LibraryPage {} } }
}

#[component]
fn LibraryPage() -> Element {
    let list = use_api::<LibraryList>("/library".into(), None);
    let session = use_session();
    let mut selection = use_signal(|| None::<Selection>);
    let Some(data) = list.get() else {
        return rsx! { h1 { class: "page-title", "Skill library" }, Waiting { what: "the skill library", failure: list.failed() } };
    };
    let chosen = selection.read().clone();
    let names: Vec<String> = data.skills.iter().map(|skill| skill.name.clone()).collect();
    let editable = session.can_edit();
    rsx! {
        h1 { class: "page-title", "Skill library" }
        p { class: "lede", "Skills every agent keeps an up-to-date local copy of. A library skill reaches the model as library/<name> and never replaces a repository skill; an agent uses one only when its setup enables it." }
        div { class: "machine-table", table {
            caption { "{plural(data.skills.len(), \"skill\", \"skills\")} · editing a skill creates a new revision of every agent that uses it" }
            thead { tr { th { "Skill" }, th { "Version" }, th { "Size" }, th { "Used by" }, th { "Updated" } } }
            tbody {
                if data.skills.is_empty() { tr { td { colspan: "5", class: "empty", "The library is empty." } } }
                for skill in data.skills.clone() {
                    SkillRow { key: "{skill.name}", skill: skill.clone(), selected: chosen == Some(Selection::Existing(skill.name.clone())), pick: move |name: String| selection.set(Some(Selection::Existing(name))) }
                }
            }
        } }
        if editable { div { class: "buttons", button { class: "primary", onclick: move |_| selection.set(Some(Selection::New)), "New skill" } } }
        if let Some(chosen) = chosen {
            SkillEditor {
                key: "{chosen.key()}",
                existing: match &chosen { Selection::Existing(name) => Some(name.clone()), Selection::New => None },
                names,
                on_changed: move |deleted: bool| { list.restart(); if deleted { selection.set(None); } },
                on_close: move |_| selection.set(None),
            }
        }
    }
}

#[component]
fn SkillRow(skill: LibrarySkillView, selected: bool, pick: EventHandler<String>) -> Element {
    let live = use_context::<Live>();
    let now = *live.now.read();
    let name = skill.name.clone();
    let used = if skill.used_by.is_empty() { "—".to_string() } else { skill.used_by.join(", ") };
    rsx! {
        tr { class: if selected { "selected-row" } else { "" },
            td { button { class: "link", "aria-pressed": "{selected}", onclick: move |_| pick.call(name.clone()), "library/{skill.name}" }, if !skill.description.is_empty() { small { class: "wrap", "{skill.description}" } } }
            td { span { class: "numeric", "v{skill.version}" } }
            td { span { class: "numeric", "{size_text(skill.size_bytes)}" } }
            td { small { class: "wrap plain-small", "{used}" } }
            td { small { class: "plain-small", "{skill.updated_by}" }, small { "{when_ago(Some(&skill.updated_at), now)}" } }
        }
    }
}

#[component]
fn SkillEditor(existing: Option<String>, names: Vec<String>, on_changed: EventHandler<bool>, on_close: EventHandler<()>) -> Element {
    match existing {
        None => rsx! { SkillForm { loaded: None, names, on_changed, on_close } },
        Some(name) => {
            let detail = use_api::<LibrarySkillDetail>(format!("/library/{}", api::segment(&name)), None);
            match detail.get() {
                Some(loaded) => rsx! { SkillForm { loaded: Some(loaded), names, on_changed, on_close } },
                None => rsx! { Waiting { what: "the skill", failure: detail.failed() } },
            }
        }
    }
}

#[component]
fn SkillForm(loaded: Option<LibrarySkillDetail>, names: Vec<String>, on_changed: EventHandler<bool>, on_close: EventHandler<()>) -> Element {
    let session = use_session();
    let editable = session.can_edit();
    let is_new = loaded.is_none();
    let mut name = use_signal(|| loaded.as_ref().map(|detail| detail.skill.name.clone()).unwrap_or_default());
    let mut content = use_signal(|| loaded.as_ref().map(|detail| detail.content.clone()).unwrap_or_else(|| TEMPLATE.to_string()));
    let mut base = use_signal(|| loaded.as_ref().map_or(0, |detail| detail.skill.version));
    let mut note = use_signal(String::new);
    let mut outcome = use_signal(|| Outcome::None);
    let mut server_problems = use_signal(Vec::<Problem>::new);
    let mut busy = use_signal(|| false);
    let mut confirm_delete = use_signal(|| false);
    let mut stale = use_signal(|| false);
    let mut versions = use_signal(|| 0u32);
    let saved_content = loaded.as_ref().map(|detail| detail.content.clone());

    use_effect(move || {
        name.read();
        content.read();
        if !server_problems.peek().is_empty() {
            server_problems.set(Vec::new());
        }
    });
    let name_text = name.read().clone();
    let content_text = content.read().clone();
    let note_text = note.read().clone();
    let mut problems = skill_problems(&name_text, &content_text, is_new);
    if is_new && names.contains(&name_text) {
        problems.push(Problem { field: "name".into(), message: "A skill with this name exists: pick it from the list to change it.".into() });
    }
    if note_text.trim().chars().count() > 500 {
        problems.push(Problem { field: "note".into(), message: "The note is longer than 500 characters.".into() });
    }
    let all: Vec<Problem> = problems.iter().cloned().chain(server_problems.read().iter().cloned()).collect();
    let counter = skill_counter(&content_text);
    let description = skill_description(&content_text);
    let dirty = saved_content.as_deref() != Some(content_text.as_str());
    let blocked = !problems.is_empty();
    let title = if is_new { "New library skill".to_string() } else { format!("library/{name_text}") };

    let save = move |_| {
        let skill_name = name.read().trim().to_string();
        let body = LibraryPut { base_version: base(), content: content.read().clone(), note: Some(note.read().trim().to_string()).filter(|text| !text.is_empty()) };
        let path = format!("/library/{}", api::segment(&skill_name));
        busy.set(true);
        server_problems.set(Vec::new());
        outcome.set(Outcome::None);
        stale.set(false);
        spawn(async move {
            match api::write::<_, LibrarySkillView>(Method::Put, &path, Some(&body)).await {
                Ok(view) => {
                    base.set(view.version);
                    note.set(String::new());
                    versions += 1;
                    let used = if view.used_by.is_empty() { String::new() } else { format!(" Agents that use it get a new setup revision: {}.", view.used_by.join(", ")) };
                    outcome.set(Outcome::Saved(format!("Saved version {}.{used}", view.version)));
                    on_changed.call(false);
                }
                Err(failure) => {
                    if failure.status == 422 {
                        server_problems.set(vec![Problem { field: failure.error.field.clone().unwrap_or_default(), message: failure.error.message.clone() }]);
                    }
                    stale.set(failure.is_conflict());
                    outcome.set(Outcome::Failed(failure));
                }
            }
            busy.set(false);
        });
    };
    let delete = move |_| {
        let path = format!("/library/{}", api::segment(name.read().trim()));
        busy.set(true);
        spawn(async move {
            match api::write_only::<()>(Method::Delete, &path, None).await {
                Ok(()) => on_changed.call(true),
                Err(failure) => {
                    outcome.set(Outcome::Failed(failure));
                    confirm_delete.set(false);
                }
            }
            busy.set(false);
        });
    };

    rsx! {
        section { class: "platform-card editor skill-editor", "aria-label": "{title}",
            h3 { "{title}", button { class: "plain close", onclick: move |_| on_close.call(()), "Close" } }
            if !editable { div { class: "notice", role: "status", "You can read everything here and change nothing: your role is viewer." } }
            if stale() { div { class: "notice conflict", role: "alert", "Someone saved this skill after you opened it. Close it and open it again to see their version." } }
            fieldset { class: "group", disabled: !editable,
                legend { "Skill" }
                if is_new {
                    div { class: "field",
                        label { r#for: "skill-name", "Name" }
                        input { id: "skill-name", r#type: "text", value: "{name_text}", maxlength: "64", "aria-describedby": "skill-name-hint skill-name-error", oninput: move |event| name.set(event.value()) }
                        small { id: "skill-name-hint", class: "hint", "Lowercase letters, digits and -, at most 64 characters. A name cannot be changed later." }
                        FieldMessage { problems: all.clone(), field: "name".to_string(), id: "skill-name-error".to_string() }
                    }
                }
                div { class: "field",
                    label { r#for: "skill-content", "SKILL.md" }
                    textarea { id: "skill-content", class: "mono tall", rows: "22", value: "{content_text}", spellcheck: false, disabled: !editable, "aria-describedby": "skill-count skill-content-error", oninput: move |event| content.set(event.value()) }
                    div { class: "field-foot", CounterText { counter, unit: "bytes".to_string(), id: "skill-count".to_string() }, small { if description.is_empty() { "No description: add description: to the front matter." } else { "Description: {description}" } } }
                    FieldMessage { problems: all.clone(), field: "content".to_string(), id: "skill-content-error".to_string() }
                }
            }
            if editable {
                div { class: "platform-card editor-save",
                    label { r#for: "skill-note", "Note for this version (optional)" }
                    textarea { id: "skill-note", rows: "2", value: "{note_text}", maxlength: "500", oninput: move |event| note.set(event.value()) }
                    FieldMessage { problems: all.clone(), field: "note".to_string(), id: "skill-note-error".to_string() }
                    div { class: "buttons",
                        button { class: "primary", disabled: blocked || busy() || (!is_new && !dirty), onclick: save, if busy() { "Saving…" } else if is_new { "Create skill" } else { "Save as a new version" } }
                        if !is_new { button { class: "danger", disabled: busy(), onclick: move |_| confirm_delete.set(true), "Delete skill" } }
                    }
                    if confirm_delete() {
                        Confirm { question: format!("Delete library/{name_text}? A skill that an agent still uses cannot be deleted."), action: "Delete skill".to_string(), busy: busy(), onconfirm: delete, oncancel: move |_| confirm_delete.set(false) }
                    }
                }
            }
            OutcomeNotice { outcome: outcome.read().clone() }
            if !is_new { SkillVersions { key: "{versions}", name: name_text, editable, on_load: move |text: String| content.set(text) } }
        }
    }
}

#[component]
fn SkillVersions(name: String, editable: bool, on_load: EventHandler<String>) -> Element {
    let list = use_api::<LibraryRevisionList>(format!("/library/{}/revisions", api::segment(&name)), None);
    let live = use_context::<Live>();
    let now = *live.now.read();
    let Some(data) = list.get() else {
        return rsx! { Waiting { what: "the versions", failure: list.failed() } };
    };
    rsx! {
        h3 { class: "sub", "Versions" }
        if let Some(failure) = list.failed() { ErrorNotice { failure } }
        div { class: "revisions",
            for item in data.revisions {
                article { key: "{item.version}", class: "platform-card revision", "aria-label": "Version {item.version} of {item.name}",
                    h4 { "Version {item.version}", if item.content.is_none() { span { class: "chip bad", "deleted" } }, small { "{when_ago(Some(&item.created_at), now)}" } }
                    p { class: "meta", "{item.author} · {note_of(&item.note)} · {size_text(item.size_bytes)}" }
                    details { summary { "Changed: {summary(&item.diff)}" }, DiffView { entries: item.diff.clone() } }
                    if editable { if let Some(text) = item.content.clone() { div { class: "buttons", button { class: "plain", onclick: move |_| on_load.call(text.clone()), "Load into the editor" } } } }
                }
            }
        }
    }
}

fn note_of(note: &str) -> &str {
    if note.is_empty() { "no note" } else { note }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sizes_read_in_bytes_and_kibibytes() {
        assert_eq!((size_text(512), size_text(2048), size_text(65_536)), ("512 B".to_string(), "2.0 KiB".to_string(), "64.0 KiB".to_string()));
    }

    #[test]
    fn the_template_passes_the_checks_a_new_skill_gets() {
        assert!(skill_problems("my-skill", TEMPLATE, true).is_empty());
    }
}

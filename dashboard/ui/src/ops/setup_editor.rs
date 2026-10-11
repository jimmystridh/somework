//! The setup editor of one agent: operator instructions, model, approval patterns, skills and MCP servers. A save sends the revision it
//! started from; a newer one is shown with what changed and the operator decides what to keep. Viewers see everything and change nothing.

use crate::{
    api::{self, Failure, Method},
    format::when,
    ops::{
        agent_page::approval_class,
        diff::DiffView,
        form::{self, canonical, changed_parts, is_dirty, model_text, overlay_names, parse_model, shown_patterns, shown_repository_skills, with_name},
        state::{classify, delivery_problem, revision_pair},
        validate::{self, Problem, form_problems, instructions_counter, note_counter, note_problem, overlay_counter},
    },
    session::use_session,
    widgets::{Confirm, CounterText, FieldMessage, Outcome, OutcomeNotice, StateBadge, use_api},
};
use dioxus::prelude::*;
use fleet_shared::operations::{
    ApprovalPatternSetting, CatalogEntryView, CatalogList, DiffEntry, EffectiveMcp, LibraryList, McpEntry, OpsAgentDetail, RoleDefaults, SetupForm, SetupRevision, SetupSave, SetupSaved,
};

/// The newer revision someone else saved, with what changed when the server said so (a refused save does; the passive banner does not).
#[derive(Clone, Debug, PartialEq)]
struct Newer {
    current: SetupRevision,
    diff: Vec<DiffEntry>,
}

fn problems_from(failure: &Failure) -> Vec<Problem> {
    if failure.status != 422 {
        return Vec::new();
    }
    vec![Problem { field: failure.error.field.clone().unwrap_or_default(), message: failure.error.message.clone() }]
}

#[component]
pub fn SetupEditor(detail: OpsAgentDetail, on_saved: EventHandler<()>) -> Element {
    let session = use_session();
    let editable = session.can_edit();
    let slug = detail.agent.slug.clone();
    let defaults = detail.role_defaults.clone();
    let saved_revision = detail.revision.as_ref().map_or(0, |revision| revision.revision);

    let mut draft = use_signal(|| detail.form.clone());
    let mut loaded = use_signal(|| detail.form.clone());
    let mut base = use_signal(|| saved_revision);
    let mut note = use_signal(String::new);
    let mut outcome = use_signal(|| Outcome::None);
    let mut conflict = use_signal(|| None::<Newer>);
    let mut problems = use_signal(Vec::<Problem>::new);
    let mut busy = use_signal(|| false);
    let mut confirm_reset = use_signal(|| false);

    use_effect(move || {
        draft.read();
        if !problems.peek().is_empty() {
            problems.set(Vec::new());
        }
    });
    {
        let (saved_form, defaults) = (detail.form.clone(), defaults.clone());
        use_effect(use_reactive!(|(saved_revision, saved_form, defaults)| {
            if saved_revision == *base.peek() {
                return;
            }
            let untouched = !is_dirty(&loaded.peek(), &draft.peek(), defaults.as_ref());
            if untouched {
                draft.set(saved_form.clone());
                loaded.set(saved_form);
                base.set(saved_revision);
            }
        }));
    }

    let current_form = draft.read().clone();
    let dirty = is_dirty(&loaded.read(), &current_form, defaults.as_ref());
    let changes = changed_parts(&loaded.read(), &current_form, defaults.as_ref());
    let state = classify(&detail.agent);
    let pair = revision_pair(&detail.agent);
    let sending = delivery_problem(&detail.agent.override_delivery);
    let local_problems = {
        let mut found = form_problems(&current_form);
        found.extend(note_problem(&note.read()));
        found
    };
    let newer = conflict.read().clone().or_else(|| {
        let latest = detail.revision.clone()?;
        (dirty && latest.revision > *base.read()).then(|| Newer { current: latest, diff: Vec::new() })
    });
    let prompt = defaults.as_ref().and_then(|defaults| defaults.prompt.clone()).or_else(|| detail.setup_card.as_ref().and_then(|card| card.prompt.clone()));
    let prompt_note = match (&defaults, &detail.setup_card) {
        (Some(defaults), _) if defaults.prompt_characters > 0 => format!("{} characters · sha256 {}", defaults.prompt_characters, defaults.prompt_sha256),
        (_, Some(card)) => format!("{} characters · sha256 {}", card.prompt_characters, card.prompt_sha256),
        _ => "not reported".to_string(),
    };
    let role_label = defaults.as_ref().map(|defaults| defaults.role.clone()).filter(|role| !role.is_empty()).unwrap_or_else(|| "its role".into());
    let effective_mcp: Vec<EffectiveMcp> = detail.reported.effective.as_ref().map(|effective| effective.mcp.clone()).unwrap_or_default();
    let counter = instructions_counter(current_form.instructions.as_deref().unwrap_or(""));
    let instructions_text = current_form.instructions.clone().unwrap_or_default();
    let note_text = note.read().clone();
    let note_count = note_counter(&note_text);
    let blocked = !local_problems.is_empty();
    let all_problems: Vec<Problem> = local_problems.iter().cloned().chain(problems.read().iter().cloned()).collect();

    let slug_save = slug.clone();
    let defaults_save = defaults.clone();
    let save = move |_| {
        if !editable || busy() {
            return;
        }
        let candidate = canonical(&draft.read(), defaults_save.as_ref());
        let message = note.read().trim().to_string();
        let mut found = form_problems(&candidate);
        found.extend(note_problem(&message));
        if !found.is_empty() {
            problems.set(found);
            return;
        }
        let body = SetupSave { base_revision: base(), form: candidate, note: (!message.is_empty()).then_some(message) };
        let path = format!("/agents/{}/setup", api::segment(&slug_save));
        busy.set(true);
        problems.set(Vec::new());
        outcome.set(Outcome::None);
        spawn(async move {
            match api::write::<_, SetupSaved>(Method::Put, &path, Some(&body)).await {
                Ok(saved) => {
                    let revision = saved.revision.revision;
                    draft.set(saved.revision.form.clone());
                    loaded.set(saved.revision.form);
                    base.set(revision);
                    note.set(String::new());
                    conflict.set(None);
                    outcome.set(Outcome::Saved(format!("Saved revision {revision}. The agent applies it from its next model run; this page shows when it has.")));
                    on_saved.call(());
                }
                Err(failure) => {
                    if let Some(newer) = failure.conflict.clone() {
                        conflict.set(Some(Newer { current: newer.current, diff: newer.diff }));
                    }
                    problems.set(problems_from(&failure));
                    outcome.set(Outcome::Failed(failure));
                }
            }
            busy.set(false);
        });
    };

    let slug_reset = slug.clone();
    let reset = move |_| {
        let path = format!("/agents/{}/setup", api::segment(&slug_reset));
        busy.set(true);
        outcome.set(Outcome::None);
        spawn(async move {
            match api::write::<(), SetupSaved>(Method::Delete, &path, None).await {
                Ok(saved) => {
                    let revision = saved.revision.revision;
                    draft.set(saved.revision.form.clone());
                    loaded.set(saved.revision.form);
                    base.set(revision);
                    conflict.set(None);
                    problems.set(Vec::new());
                    outcome.set(Outcome::Saved(format!("Reset to the role's default as revision {revision}.")));
                    on_saved.call(());
                }
                Err(failure) => {
                    if let Some(newer) = failure.conflict.clone() {
                        conflict.set(Some(Newer { current: newer.current, diff: newer.diff }));
                    }
                    outcome.set(Outcome::Failed(failure));
                }
            }
            confirm_reset.set(false);
            busy.set(false);
        });
    };

    let slug_resend = slug.clone();
    let resend = move |_| {
        let path = format!("/agents/{}/resend", api::segment(&slug_resend));
        spawn(async move {
            match api::write_only::<()>(Method::Post, &path, None).await {
                Ok(()) => outcome.set(Outcome::Saved("The latest revision is queued to be sent again.".into())),
                Err(failure) => outcome.set(Outcome::Failed(failure)),
            }
        });
    };

    rsx! {
        div { class: "editor",
            div { class: "platform-card editor-head",
                div { class: "platform-row", span { "Setup of {detail.agent.id}" }, StateBadge { state: state.clone() } }
                p { "{state.summary(&detail.agent)}" }
                div { class: "platform-row", small { "{pair}" }, if editable && saved_revision > 0 { button { class: "plain", onclick: resend, "Send the latest revision again" } } }
                if let Some(text) = sending { p { class: "bad-text", role: "alert", "{text}" } }
                if !editable { div { class: "notice", role: "status", "You can read everything here and change nothing: your role is viewer." } }
                if defaults.is_none() { div { class: "notice", role: "status", "The agent's role defaults are not known (it did not answer or runs an older kit): approval patterns and repository skills are shown as saved." } }
            }
            if let Some(newer) = newer {
                NewerRevision {
                    newer,
                    started_from: base(),
                    editable,
                    on_load: {
                        let saved_form = detail.revision.as_ref().map(|revision| revision.form.clone());
                        let conflict_form = conflict.read().as_ref().map(|newer| newer.current.form.clone());
                        move |_| {
                            if let Some(form) = conflict_form.clone().or_else(|| saved_form.clone()) {
                                let revision = conflict.read().as_ref().map(|newer| newer.current.revision).unwrap_or(saved_revision);
                                draft.set(form.clone());
                                loaded.set(form);
                                base.set(revision);
                                conflict.set(None);
                                outcome.set(Outcome::None);
                            }
                        }
                    },
                    on_keep: {
                        let revision = conflict.read().as_ref().map(|newer| newer.current.revision).unwrap_or(saved_revision);
                        move |_| {
                            base.set(revision);
                            conflict.set(None);
                            outcome.set(Outcome::None);
                        }
                    },
                }
            }

            fieldset { class: "group", disabled: !editable,
                legend { "Operator instructions" }
                h4 { "Built-in prompt of {role_label}", small { "read-only · {prompt_note}" } }
                match prompt {
                    Some(text) => rsx! { pre { class: "prompt", tabindex: "0", "aria-label": "Built-in prompt, read only", "{text}" } },
                    None => rsx! { p { class: "hint", "The agent does not show its prompt text (the hash identifies it)." } },
                }
                label { r#for: "instructions", "Your instructions, appended after the built-in prompt" }
                textarea {
                    id: "instructions", class: "mono", rows: "10", value: "{instructions_text}", disabled: !editable, spellcheck: false,
                    "aria-describedby": "instructions-count instructions-error",
                    placeholder: "Written to the agent as an addendum. The built-in prompt keeps the result format, so it cannot be edited away.",
                    oninput: move |event| draft.write().instructions = Some(event.value()),
                }
                div { class: "field-foot", CounterText { counter, unit: "characters".to_string(), id: "instructions-count".to_string() }, small { "Appended; applies from the agent's next model run." } }
                FieldMessage { problems: all_problems.clone(), field: "instructions".to_string(), id: "instructions-error".to_string() }
            }

            fieldset { class: "group", disabled: !editable,
                legend { "Model" }
                ModelSelect { form: draft, defaults: defaults.clone() }
                FieldMessage { problems: all_problems.clone(), field: "model".to_string(), id: "model-error".to_string() }
            }

            fieldset { class: "group", disabled: !editable,
                legend { "Approval patterns" }
                PatternRows { form: draft, defaults: defaults.clone() }
                FieldMessage { problems: problems.read().clone(), field: "approvalPatterns".to_string(), id: "patterns-error".to_string() }
            }

            fieldset { class: "group", disabled: !editable,
                legend { "Skills" }
                RepositorySkills { form: draft, defaults: defaults.clone() }
                LibrarySkills { form: draft }
                FieldMessage { problems: all_problems.clone(), field: "librarySkills".to_string(), id: "library-error".to_string() }
                FieldMessage { problems: all_problems.clone(), field: "repositorySkills".to_string(), id: "repository-error".to_string() }
                Overlays { form: draft, defaults: defaults.clone(), problems: all_problems.clone() }
            }

            fieldset { class: "group", disabled: !editable,
                legend { "MCP servers" }
                McpPicker { form: draft, effective: effective_mcp }
                FieldMessage { problems: all_problems.clone(), field: "mcp".to_string(), id: "mcp-error".to_string() }
            }

            div { class: "platform-card editor-save",
                if editable {
                    label { r#for: "note", "Note for this revision (optional)" }
                    textarea { id: "note", rows: "2", value: "{note_text}", "aria-describedby": "note-count", oninput: move |event| note.set(event.value()) }
                    div { class: "field-foot", CounterText { counter: note_count, unit: "characters".to_string(), id: "note-count".to_string() } }
                    if dirty { p { class: "changes", "Unsaved changes: {changes.join(\", \")}." } } else { p { class: "hint", "No changes since revision {base()}." } }
                    div { class: "buttons",
                        button { class: "primary", disabled: !dirty || blocked || busy(), onclick: save, if busy() { "Saving…" } else { "Save as a new revision" } }
                        button { class: "plain", disabled: !dirty || busy(), onclick: move |_| { let started = loaded.read().clone(); draft.set(started); problems.set(Vec::new()); outcome.set(Outcome::None); }, "Discard changes" }
                        button { class: "danger", disabled: busy() || saved_revision == 0, onclick: move |_| confirm_reset.set(true), "Reset to role default" }
                    }
                    if confirm_reset() {
                        Confirm {
                            question: "Reset to role default? This saves a new empty revision: no instructions, model, patterns, library skills or MCP servers. The earlier revisions stay in the log.".to_string(),
                            action: "Reset to role default".to_string(),
                            busy: busy(),
                            onconfirm: reset,
                            oncancel: move |_| confirm_reset.set(false),
                        }
                    }
                }
                OutcomeNotice { outcome: outcome.read().clone() }
            }
        }
    }
}

#[component]
fn NewerRevision(newer: Newer, started_from: u64, editable: bool, on_load: EventHandler<()>, on_keep: EventHandler<()>) -> Element {
    let current = newer.current.clone();
    let note = if current.note.is_empty() { "no note".to_string() } else { current.note.clone() };
    let at = when(&current.created_at);
    rsx! {
        section { class: "notice conflict", role: "alert",
            h4 { "Revision {current.revision} was saved while you were editing revision {started_from}" }
            p { "{current.author} saved it at {at} ({note})." }
            if !newer.diff.is_empty() { h5 { "What changed since revision {started_from}" }, DiffView { entries: newer.diff.clone() } }
            if editable {
                div { class: "buttons",
                    button { class: "primary", onclick: move |_| on_load.call(()), "Load revision {current.revision} and drop my edits" }
                    button { class: "plain", onclick: move |_| on_keep.call(()), "Keep my edits and save on top of it" }
                }
                p { class: "hint", "Saving on top replaces what {current.author} changed with your form." }
            }
        }
    }
}

#[component]
fn ModelSelect(form: Signal<SetupForm>, defaults: Option<RoleDefaults>) -> Element {
    let current = form.read().model.as_ref().map(model_text).unwrap_or_default();
    let default_model = defaults.as_ref().map(|defaults| defaults.model.clone()).filter(|model| !model.is_empty());
    let mut allowed: Vec<String> = defaults.as_ref().map(|defaults| defaults.allowed_models.clone()).unwrap_or_default();
    let outside = !current.is_empty() && !allowed.contains(&current);
    if outside {
        allowed.push(current.clone());
    }
    let default_label = match &default_model {
        Some(model) => format!("Role default ({model})"),
        None => "Role default".to_string(),
    };
    rsx! {
        label { r#for: "model", "Model" }
        select { id: "model", value: "{current}", "aria-describedby": "model-hint model-error",
            onchange: move |event| form.write().model = parse_model(&event.value()),
            option { value: "", selected: current.is_empty(), "{default_label}" }
            for model in allowed { option { key: "{model}", value: "{model}", selected: model == current, "{model}", if outside && model == current { " (not in the agent's allowed list)" } } }
        }
        small { id: "model-hint", class: "hint", if defaults.as_ref().is_some_and(|defaults| defaults.allowed_models.is_empty()) { "The agent did not report which models it allows; it rejects a model it does not know." } else { "Only the models the agent allows are offered." } }
    }
}

#[component]
fn PatternRows(form: Signal<SetupForm>, defaults: Option<RoleDefaults>) -> Element {
    let current = form.read().clone();
    let rows = shown_patterns(&current, defaults.as_ref());
    let own = current.approval_patterns.is_some();
    let count = rows.len();
    let can_reset = own && defaults.is_some();
    let status = match (&current.approval_patterns, rows.len()) {
        (None, n) => format!("the role's list ({n})"),
        (Some(_), 0) => "your list: no command needs approval".to_string(),
        (Some(_), n) => format!("your list ({n})"),
    };
    let max = fleet_shared::operations::MAX_APPROVAL_PATTERNS;
    rsx! {
        p { class: "hint", "Commands that wait for a person before the agent runs them (regular expressions tested against a bash command). Showing {status}. Editing a row makes the list yours; it replaces the role's list." }
        div { class: "patterns",
            for (index, row) in rows.into_iter().enumerate() {
                PatternRow { key: "{index}", form, defaults: defaults.clone(), index, row }
            }
        }
        div { class: "buttons",
            button { class: "plain", disabled: count >= max, onclick: {
                let defaults = defaults.clone();
                move |_| {
                    let list = form::with_pattern(&form.read(), defaults.as_ref(), count, ApprovalPatternSetting { pattern: String::new(), reason: String::new() });
                    form.write().approval_patterns = Some(list);
                }
            }, "Add a pattern" }
            button { class: "plain", disabled: !can_reset, onclick: move |_| form.write().approval_patterns = None, "Reset to role default" }
        }
    }
}

#[component]
fn PatternRow(form: Signal<SetupForm>, defaults: Option<RoleDefaults>, index: usize, row: ApprovalPatternSetting) -> Element {
    let number = index + 1;
    let (pattern_id, reason_id) = (format!("pattern-{index}"), format!("reason-{index}"));
    let problem = validate::pattern_problem(&row).filter(|_| form.read().approval_patterns.is_some());
    let (for_pattern, for_reason, for_remove) = (defaults.clone(), defaults.clone(), defaults);
    let reason_now = row.reason.clone();
    let pattern_now = row.pattern.clone();
    rsx! {
        div { class: "pattern-row",
            label { class: "sr-only", r#for: "{pattern_id}", "Pattern {number}" }
            input { id: "{pattern_id}", class: "mono", r#type: "text", value: "{row.pattern}", placeholder: "regular expression", maxlength: "300",
                oninput: move |event| {
                    let list = form::with_pattern(&form.read(), for_pattern.as_ref(), index, ApprovalPatternSetting { pattern: event.value(), reason: reason_now.clone() });
                    form.write().approval_patterns = Some(list);
                } }
            label { class: "sr-only", r#for: "{reason_id}", "Reason for pattern {number}" }
            input { id: "{reason_id}", r#type: "text", value: "{row.reason}", placeholder: "why it needs approval", maxlength: "200",
                oninput: move |event| {
                    let list = form::with_pattern(&form.read(), for_reason.as_ref(), index, ApprovalPatternSetting { pattern: pattern_now.clone(), reason: event.value() });
                    form.write().approval_patterns = Some(list);
                } }
            button { class: "plain remove", "aria-label": "Remove pattern {number}",
                onclick: move |_| { let list = form::without_pattern(&form.read(), for_remove.as_ref(), index); form.write().approval_patterns = Some(list); }, "×" }
            if let Some(text) = problem { p { class: "field-error", role: "alert", "{text}" } }
        }
    }
}

#[component]
fn RepositorySkills(form: Signal<SetupForm>, defaults: Option<RoleDefaults>) -> Element {
    let current = form.read().clone();
    let allowed = shown_repository_skills(&current, defaults.as_ref());
    let mut names: Vec<String> = defaults.as_ref().map(|defaults| defaults.repository_skills.clone()).unwrap_or_default();
    for name in &allowed {
        if !names.contains(name) {
            names.push(name.clone());
        }
    }
    let own = current.repository_skills.is_some();
    rsx! {
        h4 { "Repository skills", small { if own { "your list" } else { "the role's list" } } }
        p { class: "hint", "Skills that live in the repository the agent works on. Unticking one withholds it from this agent." }
        if names.is_empty() { p { class: "hint", "The role allows no repository skills." } }
        div { class: "checks",
            for name in names {
                label { key: "{name}", class: "check",
                    input { r#type: "checkbox", checked: allowed.contains(&name), onchange: {
                        let (name, defaults) = (name.clone(), defaults.clone());
                        move |event: Event<FormData>| {
                            let next = form::toggle_repository_skill(&form.read(), defaults.as_ref(), &name, event.checked());
                            form.write().repository_skills = next;
                        }
                    } }
                    span { "{name}" }
                }
            }
        }
        div { class: "buttons", button { class: "plain", disabled: !own, onclick: move |_| form.write().repository_skills = None, "Reset to role default" } }
    }
}

#[component]
fn LibrarySkills(form: Signal<SetupForm>) -> Element {
    let library = use_api::<LibraryList>("/library".into(), None);
    let enabled = form.read().library_skills.clone();
    let skills = library.get().map(|list| list.skills).unwrap_or_default();
    let missing: Vec<String> = enabled.iter().filter(|name| !skills.iter().any(|skill| &skill.name == *name)).cloned().collect();
    let loaded = library.get().is_some();
    rsx! {
        h4 { "Library skills", small { "shared by every agent, shown to the model as library/<name>" } }
        if !loaded { p { class: "hint", role: "status", "Loading the skill library…" } }
        if loaded && skills.is_empty() && missing.is_empty() { p { class: "hint", "The skill library is empty. Add skills under Skill library." } }
        div { class: "checks",
            for skill in skills {
                label { key: "{skill.name}", class: "check",
                    input { r#type: "checkbox", checked: enabled.contains(&skill.name), onchange: {
                        let name = skill.name.clone();
                        move |event: Event<FormData>| { let next = with_name(&form.read().library_skills, &name, event.checked()); form.write().library_skills = next; }
                    } }
                    span { b { "library/{skill.name}" }, small { " v{skill.version}" }, if !skill.description.is_empty() { small { class: "wrap", "{skill.description}" } } }
                }
            }
            for name in missing {
                label { key: "{name}", class: "check missing",
                    input { r#type: "checkbox", checked: true, onchange: {
                        let name = name.clone();
                        move |event: Event<FormData>| { let next = with_name(&form.read().library_skills, &name, event.checked()); form.write().library_skills = next; }
                    } }
                    span { b { "library/{name}" }, small { class: "wrap bad-text", "no longer in the library: untick it, a save would be refused" } }
                }
            }
        }
    }
}

#[component]
fn Overlays(form: Signal<SetupForm>, defaults: Option<RoleDefaults>, problems: Vec<Problem>) -> Element {
    let names = overlay_names(&form.read(), defaults.as_ref());
    if names.is_empty() {
        return rsx! {};
    }
    rsx! {
        h4 { "Overlays for repository skills", small { "this agent only" } }
        p { class: "hint", "Text that is added to a repository skill for this agent, for the differences it needs. It does not replace the skill." }
        div { class: "overlays",
            for name in names { OverlayBox { key: "{name}", form, name, problems: problems.clone() } }
        }
    }
}

#[component]
fn OverlayBox(form: Signal<SetupForm>, name: String, problems: Vec<Problem>) -> Element {
    let text = form.read().overlays.get(&name).cloned().unwrap_or_default();
    let counter = overlay_counter(&text);
    let set = !text.trim().is_empty();
    let id = format!("overlay-{name}");
    let count_id = format!("overlay-count-{name}");
    let error_id = format!("overlay-error-{name}");
    let field = format!("overlays.{name}");
    let key = name.clone();
    rsx! {
        details { class: "overlay", open: set,
            summary { "{name}", if set { span { class: "chip write", "overlay set" } } }
            label { class: "sr-only", r#for: "{id}", "Overlay text for {name}" }
            textarea { id: "{id}", class: "mono", rows: "5", value: "{text}", spellcheck: false, "aria-describedby": "{count_id} {error_id}",
                oninput: move |event| { form.write().overlays.insert(key.clone(), event.value()); } }
            div { class: "field-foot", CounterText { counter, unit: "bytes".to_string(), id: count_id.clone() } }
            FieldMessage { problems, field, id: error_id.clone() }
        }
    }
}

#[component]
fn McpPicker(form: Signal<SetupForm>, effective: Vec<EffectiveMcp>) -> Element {
    let catalog = use_api::<CatalogList>("/catalog".into(), None);
    let enabled = form.read().mcp.clone();
    let entries = catalog.get().map(|list| list.entries).unwrap_or_default();
    let missing: Vec<String> = enabled.iter().filter(|name| !entries.iter().any(|entry| &entry.name == *name)).cloned().collect();
    let loaded = catalog.get().is_some();
    rsx! {
        p { class: "hint", "Tool servers from the MCP catalog. The agent can use only the entries ticked here; secrets are read from the agent's own environment and never come from Operations." }
        if !loaded { p { class: "hint", role: "status", "Loading the MCP catalog…" } }
        if loaded && entries.is_empty() && missing.is_empty() { p { class: "hint", "The MCP catalog is empty. Add entries under MCP catalog." } }
        div { class: "checks mcp",
            for entry in entries {
                McpOption { key: "{entry.name}", form, enabled: enabled.contains(&entry.name), error: effective.iter().find(|server| server.name == entry.name).and_then(|server| server.error.clone()), entry }
            }
            for name in missing {
                label { key: "{name}", class: "check missing",
                    input { r#type: "checkbox", checked: true, onchange: {
                        let name = name.clone();
                        move |event: Event<FormData>| { let next = with_name(&form.read().mcp, &name, event.checked()); form.write().mcp = next; }
                    } }
                    span { b { "{name}" }, small { class: "wrap bad-text", "no longer in the catalog: untick it, a save would be refused" } }
                }
            }
        }
    }
}

/// The OS names an entry downloads for, with the archive kind: `linux (tar.gz)`.
pub fn download_summary(entry: &McpEntry) -> Vec<String> {
    entry
        .downloads
        .iter()
        .flatten()
        .map(|(os, download)| {
            let kind = match download.archive {
                fleet_shared::operations::ArchiveKind::None => "single file",
                fleet_shared::operations::ArchiveKind::Zip => "zip",
                fleet_shared::operations::ArchiveKind::TarGz => "tar.gz",
            };
            format!("{os} ({kind})")
        })
        .collect()
}

pub fn approval_word(entry: &McpEntry) -> &'static str {
    use fleet_shared::operations::McpApproval;
    match entry.approval {
        McpApproval::Ask => "ask",
        McpApproval::Never => "never",
        McpApproval::Writes => "writes",
    }
}

pub fn transport_word(entry: &McpEntry) -> &'static str {
    use fleet_shared::operations::McpTransport;
    match entry.transport {
        McpTransport::Stdio => "stdio",
        McpTransport::Http => "http",
    }
}

fn approval_meaning(mode: &str) -> &'static str {
    match mode {
        "never" => "never asks: every call is allowed",
        "writes" => "asks for calls whose tool is not read-only",
        _ => "asks a person before every call",
    }
}

#[component]
fn McpOption(form: Signal<SetupForm>, enabled: bool, error: Option<String>, entry: CatalogEntryView) -> Element {
    let server = entry.entry.clone();
    let approval = approval_word(&server);
    let transport = transport_word(&server);
    let secrets = server.secrets.clone().unwrap_or_default();
    let downloads = download_summary(&server);
    let name = entry.name.clone();
    let meaning = approval_meaning(approval);
    rsx! {
        label { class: "check mcp-option",
            input { r#type: "checkbox", checked: enabled, onchange: move |event: Event<FormData>| { let next = with_name(&form.read().mcp, &name, event.checked()); form.write().mcp = next; } }
            span { class: "mcp-body",
                span { class: "mcp-title", b { "{entry.name}" }, span { class: "chip", "{transport}" }, span { class: "chip {approval_class(approval)}", title: "{meaning}", "approval: {approval}" }, small { "r{entry.revision}" } }
                if let Some(text) = server.description.clone() { small { class: "wrap", "{text}" } }
                small { class: "wrap", "Approval {approval}: {meaning}." }
                if !secrets.is_empty() { small { class: "wrap", "Needs secrets on the agent's host: ", for secret in secrets.iter() { code { key: "{secret}", "{secret}" } } } }
                if !downloads.is_empty() { small { class: "wrap", "Fetched per operating system: {downloads.join(\", \")} (version and SHA-256 are fixed in the entry)" } }
                if let Some(text) = error { small { class: "wrap bad-text", role: "alert", "Not offered on the agent now: {text}" } }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use fleet_shared::operations::{ArchiveKind, McpApproval, McpDownload, McpTransport};
    use std::collections::BTreeMap;

    fn entry(approval: McpApproval, downloads: Option<BTreeMap<String, McpDownload>>) -> McpEntry {
        McpEntry { name: "docs".into(), description: None, transport: McpTransport::Stdio, command: Some("${LOCAL}".into()), args: None, env: None, url: None, headers: None, secrets: None, approval, downloads, timeout_seconds: None }
    }

    #[test]
    fn an_entry_shows_its_approval_mode_and_transport_in_words() {
        assert_eq!((approval_word(&entry(McpApproval::Never, None)), transport_word(&entry(McpApproval::Ask, None))), ("never", "stdio"));
        assert!(approval_meaning("never").contains("every call is allowed"));
        assert!(approval_meaning("ask").contains("before every call"));
    }

    #[test]
    fn the_downloads_are_listed_by_operating_system_with_the_archive_kind() {
        let download = |archive| McpDownload { url: "https://example.com/x".into(), sha256: "a".repeat(64), archive, executable: "x".into() };
        let downloads = BTreeMap::from([("windows".to_string(), download(ArchiveKind::Zip)), ("linux".to_string(), download(ArchiveKind::TarGz)), ("darwin".to_string(), download(ArchiveKind::None))]);
        assert_eq!(download_summary(&entry(McpApproval::Ask, Some(downloads))), ["darwin (single file)", "linux (tar.gz)", "windows (zip)"]);
        assert!(download_summary(&entry(McpApproval::Ask, None)).is_empty());
    }

    #[test]
    fn only_an_unprocessable_save_has_a_field_to_point_at() {
        let invalid = api::parse_failure(422, r#"{"code":"invalid","message":"the instructions are longer than 16000 characters","field":"instructions"}"#);
        assert_eq!(problems_from(&invalid), vec![Problem { field: "instructions".into(), message: "the instructions are longer than 16000 characters".into() }]);
        assert!(problems_from(&api::parse_failure(409, "{}")).is_empty());
        assert!(problems_from(&api::parse_failure(403, "{}")).is_empty());
    }
}

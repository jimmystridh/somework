//! The MCP catalog: the one list of tool servers any agent may be given. An entry names its secrets without holding them and says how a
//! local server is fetched for each operating system, with a fixed checksum.

use crate::{
    api::{self, Method},
    format::when_ago,
    live::Live,
    ops::{
        diff::{DiffView, summary},
        setup_editor::{approval_word, download_summary, transport_word},
        validate::{Problem, entry_problems},
    },
    session::use_session,
    shell::Gate,
    widgets::{Confirm, ErrorNotice, FieldMessage, Outcome, OutcomeNotice, Waiting, use_api},
};
use dioxus::prelude::*;
use fleet_shared::operations::{
    ArchiveKind, CatalogEntryView, CatalogList, CatalogPut, CatalogRevisionList, McpApproval, McpDownload, McpEntry, McpTransport,
};
use std::collections::BTreeMap;

pub const SYSTEMS: [&str; 3] = ["linux", "windows", "darwin"];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DownloadDraft {
    pub enabled: bool,
    pub url: String,
    pub sha256: String,
    pub archive: ArchiveKind,
    pub executable: String,
}

impl Default for DownloadDraft {
    fn default() -> Self {
        Self { enabled: false, url: String::new(), sha256: String::new(), archive: ArchiveKind::None, executable: String::new() }
    }
}

/// An entry as the form holds it: text for everything, lists as rows or lines.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EntryDraft {
    pub name: String,
    pub description: String,
    pub transport: McpTransport,
    pub command: String,
    /// One argument per line.
    pub args: String,
    pub env: Vec<(String, String)>,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub approval: McpApproval,
    /// Names separated by commas, spaces or lines.
    pub secrets: String,
    pub downloads: BTreeMap<String, DownloadDraft>,
    pub timeout: String,
}

impl Default for EntryDraft {
    fn default() -> Self {
        Self {
            name: String::new(),
            description: String::new(),
            transport: McpTransport::Stdio,
            command: String::new(),
            args: String::new(),
            env: Vec::new(),
            url: String::new(),
            headers: Vec::new(),
            approval: McpApproval::Ask,
            secrets: String::new(),
            downloads: SYSTEMS.iter().map(|os| (os.to_string(), DownloadDraft::default())).collect(),
            timeout: String::new(),
        }
    }
}

pub fn split_names(text: &str) -> Vec<String> {
    text.split(|c: char| c == ',' || c.is_whitespace()).filter(|name| !name.is_empty()).map(str::to_string).collect()
}

pub fn from_entry(entry: &McpEntry) -> EntryDraft {
    let mut draft = EntryDraft {
        name: entry.name.clone(),
        description: entry.description.clone().unwrap_or_default(),
        transport: entry.transport,
        command: entry.command.clone().unwrap_or_default(),
        args: entry.args.iter().flatten().cloned().collect::<Vec<_>>().join("\n"),
        env: entry.env.iter().flatten().map(|(key, value)| (key.clone(), value.clone())).collect(),
        url: entry.url.clone().unwrap_or_default(),
        headers: entry.headers.iter().flatten().map(|(key, value)| (key.clone(), value.clone())).collect(),
        approval: entry.approval,
        secrets: entry.secrets.iter().flatten().cloned().collect::<Vec<_>>().join(", "),
        timeout: entry.timeout_seconds.map(|seconds| seconds.to_string()).unwrap_or_default(),
        ..Default::default()
    };
    for (os, download) in entry.downloads.iter().flatten() {
        draft.downloads.insert(os.clone(), DownloadDraft { enabled: true, url: download.url.clone(), sha256: download.sha256.clone(), archive: download.archive, executable: download.executable.clone() });
    }
    draft
}

fn rows_to_map(rows: &[(String, String)]) -> Option<BTreeMap<String, String>> {
    let map: BTreeMap<String, String> = rows.iter().filter(|(key, _)| !key.trim().is_empty()).map(|(key, value)| (key.trim().to_string(), value.clone())).collect();
    (!map.is_empty()).then_some(map)
}

/// The entry the form describes. A timeout that is not a number is the one thing that cannot be turned into an entry.
pub fn to_entry(draft: &EntryDraft) -> Result<McpEntry, Problem> {
    let timeout_seconds = match draft.timeout.trim() {
        "" => None,
        text => Some(text.parse::<u64>().map_err(|_| Problem { field: "entry.timeoutSeconds".into(), message: "The timeout is a whole number of seconds.".into() })?),
    };
    let stdio = draft.transport == McpTransport::Stdio;
    let args: Vec<String> = draft.args.lines().filter(|line| !line.trim().is_empty()).map(str::to_string).collect();
    let secrets = split_names(&draft.secrets);
    let downloads: BTreeMap<String, McpDownload> = draft
        .downloads
        .iter()
        .filter(|(_, download)| download.enabled)
        .map(|(os, download)| (os.clone(), McpDownload { url: download.url.trim().to_string(), sha256: download.sha256.trim().to_string(), archive: download.archive, executable: download.executable.trim().to_string() }))
        .collect();
    Ok(McpEntry {
        name: draft.name.trim().to_string(),
        description: Some(draft.description.trim().to_string()).filter(|text| !text.is_empty()),
        transport: draft.transport,
        command: stdio.then(|| draft.command.trim().to_string()).filter(|text| !text.is_empty()),
        args: (stdio && !args.is_empty()).then_some(args),
        env: rows_to_map(&draft.env),
        url: (!stdio).then(|| draft.url.trim().to_string()).filter(|text| !text.is_empty()),
        headers: if stdio { None } else { rows_to_map(&draft.headers) },
        secrets: (!secrets.is_empty()).then_some(secrets),
        approval: draft.approval,
        downloads: (!downloads.is_empty()).then_some(downloads),
        timeout_seconds,
    })
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum Selection {
    New,
    Existing(String),
}

impl Selection {
    fn key(&self) -> String {
        match self {
            Self::New => "new".into(),
            Self::Existing(name) => format!("entry-{name}"),
        }
    }
}

#[component]
pub fn Catalog() -> Element {
    rsx! { Gate { admin: false, CatalogPage {} } }
}

#[component]
fn CatalogPage() -> Element {
    let list = use_api::<CatalogList>("/catalog".into(), None);
    let session = use_session();
    let mut selection = use_signal(|| None::<Selection>);
    let Some(data) = list.get() else {
        return rsx! { h1 { class: "page-title", "MCP catalog" }, Waiting { what: "the MCP catalog", failure: list.failed() } };
    };
    let chosen = selection.read().clone();
    let existing = match &chosen {
        Some(Selection::Existing(name)) => data.entries.iter().find(|entry| &entry.name == name).cloned(),
        _ => None,
    };
    let names: Vec<String> = data.entries.iter().map(|entry| entry.name.clone()).collect();
    let editable = session.can_edit();
    rsx! {
        h1 { class: "page-title", "MCP catalog" }
        p { class: "lede", "The one list of tool servers every agent can be given. An agent uses only the entries its setup enables; entries name the secrets they need and never hold them." }
        div { class: "machine-table", table {
            caption { "Catalog entries · {data.entries.len()} · changing an entry creates a new revision of every agent that uses it" }
            thead { tr { th { "Entry" }, th { "Transport" }, th { "Approval" }, th { "Secrets" }, th { "Downloads" }, th { "Used by" }, th { "Updated" } } }
            tbody {
                if data.entries.is_empty() { tr { td { colspan: "7", class: "empty", "The catalog is empty." } } }
                for entry in data.entries.clone() {
                    CatalogRow { key: "{entry.name}", entry: entry.clone(), selected: chosen == Some(Selection::Existing(entry.name.clone())), pick: move |name: String| selection.set(Some(Selection::Existing(name))) }
                }
            }
        } }
        if editable { div { class: "buttons", button { class: "primary", onclick: move |_| selection.set(Some(Selection::New)), "New entry" } } }
        if let Some(chosen) = chosen {
            EntryEditor {
                key: "{chosen.key()}",
                existing: existing.clone(),
                names,
                on_changed: move |deleted: bool| { list.restart(); if deleted { selection.set(None); } },
                on_close: move |_| selection.set(None),
            }
        }
    }
}

#[component]
fn CatalogRow(entry: CatalogEntryView, selected: bool, pick: EventHandler<String>) -> Element {
    let live = use_context::<Live>();
    let now = *live.now.read();
    let name = entry.name.clone();
    let server = entry.entry.clone();
    let approval = approval_word(&server);
    let secrets = server.secrets.clone().unwrap_or_default().join(", ");
    let downloads = download_summary(&server).join(", ");
    let used = if entry.used_by.is_empty() { "—".to_string() } else { entry.used_by.join(", ") };
    let updated = when_ago(Some(&entry.updated_at), now);
    rsx! {
        tr { class: if selected { "selected-row" } else { "" },
            td { button { class: "link", "aria-pressed": "{selected}", onclick: move |_| pick.call(name.clone()), "{entry.name}" }, small { "r{entry.revision}" }, if let Some(text) = server.description.clone() { small { class: "wrap", "{text}" } } }
            td { "{transport_word(&server)}" }
            td { span { class: "chip {crate::ops::agent_page::approval_class(approval)}", "{approval}" } }
            td { small { class: "wrap plain-small", if secrets.is_empty() { "—" } else { "{secrets}" } } }
            td { small { class: "wrap plain-small", if downloads.is_empty() { "—" } else { "{downloads}" } } }
            td { small { class: "wrap plain-small", "{used}" } }
            td { small { class: "plain-small", "{entry.updated_by}" }, small { "{updated}" } }
        }
    }
}

#[component]
fn EntryEditor(existing: Option<CatalogEntryView>, names: Vec<String>, on_changed: EventHandler<bool>, on_close: EventHandler<()>) -> Element {
    let session = use_session();
    let editable = session.can_edit();
    let is_new = existing.is_none();
    let mut draft = use_signal(|| existing.as_ref().map(|view| from_entry(&view.entry)).unwrap_or_default());
    let mut base = use_signal(|| existing.as_ref().map_or(0, |view| view.revision));
    let mut note = use_signal(String::new);
    let mut outcome = use_signal(|| Outcome::None);
    let mut server_problems = use_signal(Vec::<Problem>::new);
    let mut busy = use_signal(|| false);
    let mut confirm_delete = use_signal(|| false);
    let mut stale = use_signal(|| false);

    use_effect(move || {
        draft.read();
        if !server_problems.peek().is_empty() {
            server_problems.set(Vec::new());
        }
    });
    let current = draft.read().clone();
    let built = to_entry(&current);
    let mut problems: Vec<Problem> = match &built {
        Ok(entry) => entry_problems(entry, is_new),
        Err(problem) => vec![problem.clone()],
    };
    if is_new && names.contains(&current.name.trim().to_string()) {
        problems.push(Problem { field: "entry.name".into(), message: "An entry with this name exists: pick it from the list to change it.".into() });
    }
    let blocked = !problems.is_empty() || current.name.trim().is_empty();
    let all: Vec<Problem> = problems.iter().cloned().chain(server_problems.read().iter().cloned()).collect();
    let name_text = current.name.clone();
    let stdio = current.transport == McpTransport::Stdio;
    let note_text = note.read().clone();
    let title = if is_new { "New catalog entry".to_string() } else { format!("Entry {}", current.name) };
    let group_downloads: Vec<Problem> = all.iter().filter(|problem| problem.field == "entry.downloads").cloned().collect();

    let existing_name = existing.as_ref().map(|view| view.name.clone());
    let save = move |_| {
        let Ok(entry) = to_entry(&draft.read()) else { return };
        let body = CatalogPut { base_revision: base(), entry: entry.clone(), note: Some(note.read().trim().to_string()).filter(|text| !text.is_empty()) };
        let path = format!("/catalog/{}", api::segment(&entry.name));
        busy.set(true);
        server_problems.set(Vec::new());
        outcome.set(Outcome::None);
        stale.set(false);
        spawn(async move {
            match api::write::<_, CatalogEntryView>(Method::Put, &path, Some(&body)).await {
                Ok(view) => {
                    base.set(view.revision);
                    draft.set(from_entry(&view.entry));
                    note.set(String::new());
                    let used = if view.used_by.is_empty() { String::new() } else { format!(" Agents that use it get a new setup revision: {}.", view.used_by.join(", ")) };
                    outcome.set(Outcome::Saved(format!("Saved revision {}.{used}", view.revision)));
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
        let Some(name) = existing_name.clone() else { return };
        let path = format!("/catalog/{}", api::segment(&name));
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
        section { class: "platform-card editor catalog-editor", "aria-label": "{title}",
            h3 { "{title}", button { class: "plain close", onclick: move |_| on_close.call(()), "Close" } }
            if !editable { div { class: "notice", role: "status", "You can read everything here and change nothing: your role is viewer." } }
            if stale() { div { class: "notice conflict", role: "alert", "Someone saved this entry after you opened it. Close it and open it again to see their version." } }
            fieldset { class: "group", disabled: !editable,
                legend { "Entry" }
                div { class: "field",
                    label { r#for: "entry-name", "Name" }
                    input { id: "entry-name", r#type: "text", value: "{name_text}", readonly: !is_new, disabled: !editable, maxlength: "40", "aria-describedby": "entry-name-error",
                        oninput: move |event| draft.write().name = event.value() }
                    small { class: "hint", "Lowercase letters, digits, - and _, at most 40 characters. A name cannot be changed later." }
                    FieldMessage { problems: all.clone(), field: "entry.name".to_string(), id: "entry-name-error".to_string() }
                }
                div { class: "field",
                    label { r#for: "entry-description", "Description" }
                    input { id: "entry-description", r#type: "text", value: "{current.description}", maxlength: "300", "aria-describedby": "entry-description-error", oninput: move |event| draft.write().description = event.value() }
                    FieldMessage { problems: all.clone(), field: "entry.description".to_string(), id: "entry-description-error".to_string() }
                }
                div { class: "field-row",
                    div { class: "field",
                        label { r#for: "entry-transport", "Transport" }
                        select { id: "entry-transport", value: "{transport_word_of(current.transport)}",
                            onchange: move |event| draft.write().transport = if event.value() == "http" { McpTransport::Http } else { McpTransport::Stdio },
                            option { value: "stdio", selected: stdio, "stdio: the agent starts a command" }
                            option { value: "http", selected: !stdio, "http: the agent calls an address" }
                        }
                    }
                    div { class: "field",
                        label { r#for: "entry-approval", "Approval" }
                        select { id: "entry-approval", value: "{approval_of(current.approval)}",
                            onchange: move |event| draft.write().approval = match event.value().as_str() { "never" => McpApproval::Never, "writes" => McpApproval::Writes, _ => McpApproval::Ask },
                            option { value: "ask", selected: current.approval == McpApproval::Ask, "ask: a person approves every call" }
                            option { value: "writes", selected: current.approval == McpApproval::Writes, "writes: ask for tools that are not read-only" }
                            option { value: "never", selected: current.approval == McpApproval::Never, "never: every call is allowed" }
                        }
                    }
                    div { class: "field",
                        label { r#for: "entry-timeout", "Timeout, seconds" }
                        input { id: "entry-timeout", r#type: "text", inputmode: "numeric", value: "{current.timeout}", placeholder: "agent default", "aria-describedby": "entry-timeout-error", oninput: move |event| draft.write().timeout = event.value() }
                        FieldMessage { problems: all.clone(), field: "entry.timeoutSeconds".to_string(), id: "entry-timeout-error".to_string() }
                    }
                }
            }
            if stdio {
                fieldset { class: "group", disabled: !editable,
                    legend { "Command" }
                    div { class: "field",
                        label { r#for: "entry-command", "Command" }
                        input { id: "entry-command", class: "mono", r#type: "text", value: "{current.command}", placeholder: "npx", "aria-describedby": "entry-command-hint entry-command-error", oninput: move |event| draft.write().command = event.value() }
                        small { id: "entry-command-hint", class: "hint", "Use ${{LOCAL}} to run the executable downloaded for the agent's operating system." }
                        FieldMessage { problems: all.clone(), field: "entry.command".to_string(), id: "entry-command-error".to_string() }
                    }
                    div { class: "field",
                        label { r#for: "entry-args", "Arguments, one per line" }
                        textarea { id: "entry-args", class: "mono", rows: "4", value: "{current.args}", spellcheck: false, "aria-describedby": "entry-args-error", oninput: move |event| draft.write().args = event.value() }
                        FieldMessage { problems: all.clone(), field: "entry.args".to_string(), id: "entry-args-error".to_string() }
                    }
                    KvRows { title: "Environment".to_string(), id: "env".to_string(), key_label: "Variable".to_string(), rows: current.env.clone(), editable, on_change: move |rows| draft.write().env = rows }
                    FieldMessage { problems: all.clone(), field: "entry.env".to_string(), id: "entry-env-error".to_string() }
                }
            } else {
                fieldset { class: "group", disabled: !editable,
                    legend { "Address" }
                    div { class: "field",
                        label { r#for: "entry-url", "URL" }
                        input { id: "entry-url", class: "mono", r#type: "text", value: "{current.url}", placeholder: "https://mcp.example.com/sse", "aria-describedby": "entry-url-error", oninput: move |event| draft.write().url = event.value() }
                        FieldMessage { problems: all.clone(), field: "entry.url".to_string(), id: "entry-url-error".to_string() }
                    }
                    KvRows { title: "Headers".to_string(), id: "headers".to_string(), key_label: "Header".to_string(), rows: current.headers.clone(), editable, on_change: move |rows| draft.write().headers = rows }
                    FieldMessage { problems: all.clone(), field: "entry.headers".to_string(), id: "entry-headers-error".to_string() }
                }
            }
            fieldset { class: "group", disabled: !editable,
                legend { "Secrets" }
                div { class: "field",
                    label { r#for: "entry-secrets", "Secret names" }
                    input { id: "entry-secrets", class: "mono", r#type: "text", value: "{current.secrets}", placeholder: "GITHUB_TOKEN, DOCS_API_KEY", "aria-describedby": "entry-secrets-hint entry-secrets-error", oninput: move |event| draft.write().secrets = event.value() }
                    small { id: "entry-secrets-hint", class: "hint", "Names only, never values. Every ${{NAME}} used in the entry must be listed; the agent reads the value from its own environment and rejects the setup when its host lacks it." }
                    FieldMessage { problems: all.clone(), field: "entry.secrets".to_string(), id: "entry-secrets-error".to_string() }
                }
            }
            fieldset { class: "group", disabled: !editable,
                legend { "Downloads" }
                p { class: "hint", "For a server that must be fetched: one download per operating system, https only, fixed by its SHA-256." }
                FieldMessage { problems: group_downloads, field: "entry.downloads".to_string(), id: "entry-downloads-error".to_string() }
                for os in SYSTEMS {
                    DownloadFields { key: "{os}", os: os.to_string(), download: current.downloads.get(os).cloned().unwrap_or_default(), problems: all.clone(), on_change: move |value: DownloadDraft| { draft.write().downloads.insert(os.to_string(), value); } }
                }
            }
            if editable {
                div { class: "platform-card editor-save",
                    label { r#for: "entry-note", "Note for this revision (optional)" }
                    textarea { id: "entry-note", rows: "2", value: "{note_text}", maxlength: "500", oninput: move |event| note.set(event.value()) }
                    div { class: "buttons",
                        button { class: "primary", disabled: blocked || busy(), onclick: save, if busy() { "Saving…" } else if is_new { "Create entry" } else { "Save as a new revision" } }
                        if !is_new { button { class: "danger", disabled: busy(), onclick: move |_| confirm_delete.set(true), "Delete entry" } }
                    }
                    if confirm_delete() {
                        Confirm { question: format!("Delete the entry {name_text}? An entry that an agent still uses cannot be deleted."), action: "Delete entry".to_string(), busy: busy(), onconfirm: delete, oncancel: move |_| confirm_delete.set(false) }
                    }
                }
            }
            OutcomeNotice { outcome: outcome.read().clone() }
            if !is_new { EntryRevisions { name: name_text.clone(), editable, on_load: move |entry: McpEntry| draft.set(from_entry(&entry)) } }
        }
    }
}

fn note_of(note: &str) -> &str {
    if note.is_empty() { "no note" } else { note }
}

fn transport_word_of(transport: McpTransport) -> &'static str {
    match transport {
        McpTransport::Stdio => "stdio",
        McpTransport::Http => "http",
    }
}

fn approval_of(approval: McpApproval) -> &'static str {
    match approval {
        McpApproval::Ask => "ask",
        McpApproval::Never => "never",
        McpApproval::Writes => "writes",
    }
}

pub fn archive_word(kind: ArchiveKind) -> &'static str {
    match kind {
        ArchiveKind::None => "none",
        ArchiveKind::Zip => "zip",
        ArchiveKind::TarGz => "tar.gz",
    }
}

pub fn parse_archive(text: &str) -> ArchiveKind {
    match text {
        "zip" => ArchiveKind::Zip,
        "tar.gz" => ArchiveKind::TarGz,
        _ => ArchiveKind::None,
    }
}

#[component]
fn KvRows(title: String, id: String, key_label: String, rows: Vec<(String, String)>, editable: bool, on_change: EventHandler<Vec<(String, String)>>) -> Element {
    let count = rows.len();
    rsx! {
        div { class: "kv",
            h4 { "{title}", small { "values may be ${{SECRET_NAME}}, never a secret itself" } }
            for (index, (key, value)) in rows.clone().into_iter().enumerate() {
                div { key: "{index}", class: "kv-row",
                    label { class: "sr-only", r#for: "{id}-key-{index}", "{key_label} {index + 1} name" }
                    input { id: "{id}-key-{index}", class: "mono", r#type: "text", value: "{key}", placeholder: "{key_label}", disabled: !editable, oninput: {
                        let rows = rows.clone();
                        move |event: Event<FormData>| { let mut next = rows.clone(); next[index].0 = event.value(); on_change.call(next); }
                    } }
                    label { class: "sr-only", r#for: "{id}-value-{index}", "{key_label} {index + 1} value" }
                    input { id: "{id}-value-{index}", class: "mono", r#type: "text", value: "{value}", placeholder: "value or ${{SECRET_NAME}}", disabled: !editable, oninput: {
                        let rows = rows.clone();
                        move |event: Event<FormData>| { let mut next = rows.clone(); next[index].1 = event.value(); on_change.call(next); }
                    } }
                    button { class: "plain remove", "aria-label": "Remove {key_label} {index + 1}", disabled: !editable, onclick: {
                        let rows = rows.clone();
                        move |_| { let mut next = rows.clone(); next.remove(index); on_change.call(next); }
                    }, "×" }
                }
            }
            button { class: "plain", disabled: !editable || count >= 50, onclick: move |_| { let mut next = rows.clone(); next.push((String::new(), String::new())); on_change.call(next); }, "Add {key_label}" }
        }
    }
}

#[component]
fn DownloadFields(os: String, download: DownloadDraft, problems: Vec<Problem>, on_change: EventHandler<DownloadDraft>) -> Element {
    let field = format!("entry.downloads.{os}");
    let (toggle_id, url_id, sha_id, archive_id, exe_id, error_id) = (format!("dl-{os}"), format!("dl-{os}-url"), format!("dl-{os}-sha"), format!("dl-{os}-archive"), format!("dl-{os}-exe"), format!("dl-{os}-error"));
    let enabled = download.enabled;
    let (on_toggle, on_url, on_sha, on_archive, on_exe) = (download.clone(), download.clone(), download.clone(), download.clone(), download.clone());
    rsx! {
        div { class: "download",
            label { class: "check", r#for: "{toggle_id}",
                input { id: "{toggle_id}", r#type: "checkbox", checked: enabled, onchange: move |event: Event<FormData>| on_change.call(DownloadDraft { enabled: event.checked(), ..on_toggle.clone() }) }
                span { b { "{os}" } }
            }
            if enabled {
                div { class: "download-fields",
                    div { class: "field",
                        label { r#for: "{url_id}", "https address of the file" }
                        input { id: "{url_id}", class: "mono", r#type: "text", value: "{download.url}", placeholder: "https://…", "aria-describedby": "{error_id}", oninput: move |event| on_change.call(DownloadDraft { url: event.value(), ..on_url.clone() }) }
                    }
                    div { class: "field",
                        label { r#for: "{sha_id}", "SHA-256 of the file" }
                        input { id: "{sha_id}", class: "mono", r#type: "text", value: "{download.sha256}", placeholder: "64 lowercase hex characters", spellcheck: false, "aria-describedby": "{error_id}", oninput: move |event| on_change.call(DownloadDraft { sha256: event.value(), ..on_sha.clone() }) }
                    }
                    div { class: "field-row",
                        div { class: "field",
                            label { r#for: "{archive_id}", "Archive" }
                            select { id: "{archive_id}", value: "{archive_word(download.archive)}", onchange: move |event| on_change.call(DownloadDraft { archive: parse_archive(&event.value()), ..on_archive.clone() }),
                                option { value: "none", selected: download.archive == ArchiveKind::None, "none: the file is the executable" }
                                option { value: "zip", selected: download.archive == ArchiveKind::Zip, "zip" }
                                option { value: "tar.gz", selected: download.archive == ArchiveKind::TarGz, "tar.gz" }
                            }
                        }
                        div { class: "field",
                            label { r#for: "{exe_id}", "Executable path" }
                            input { id: "{exe_id}", class: "mono", r#type: "text", value: "{download.executable}", placeholder: "bin/server", "aria-describedby": "{error_id}", oninput: move |event| on_change.call(DownloadDraft { executable: event.value(), ..on_exe.clone() }) }
                        }
                    }
                }
            }
            FieldMessage { problems, field, id: error_id }
        }
    }
}

#[component]
fn EntryRevisions(name: String, editable: bool, on_load: EventHandler<McpEntry>) -> Element {
    let list = use_api::<CatalogRevisionList>(format!("/catalog/{}/revisions", api::segment(&name)), None);
    let live = use_context::<Live>();
    let now = *live.now.read();
    let Some(data) = list.get() else {
        return rsx! { Waiting { what: "the revisions", failure: list.failed() } };
    };
    rsx! {
        h3 { class: "sub", "Revisions" }
        if let Some(failure) = list.failed() { ErrorNotice { failure } }
        div { class: "revisions",
            for item in data.revisions {
                article { key: "{item.revision}", class: "platform-card revision", "aria-label": "Revision {item.revision} of {item.name}",
                    h4 { "Revision {item.revision}", if item.entry.is_none() { span { class: "chip bad", "deleted" } }, small { "{when_ago(Some(&item.created_at), now)}" } }
                    p { class: "meta", "{item.author} · {note_of(&item.note)}" }
                    details { summary { "Changed: {summary(&item.diff)}" }, DiffView { entries: item.diff.clone() } }
                    if editable { if let Some(entry) = item.entry.clone() { div { class: "buttons", button { class: "plain", onclick: move |_| on_load.call(entry.clone()), "Load into the editor" } } } }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stdio_entry() -> McpEntry {
        McpEntry {
            name: "docs".into(),
            description: Some("Documentation search".into()),
            transport: McpTransport::Stdio,
            command: Some("${LOCAL}".into()),
            args: Some(vec!["--stdio".into(), "--root=/work".into()]),
            env: Some(BTreeMap::from([("DOCS_TOKEN".to_string(), "${DOCS_TOKEN}".to_string())])),
            url: None,
            headers: None,
            secrets: Some(vec!["DOCS_TOKEN".into()]),
            approval: McpApproval::Writes,
            downloads: Some(BTreeMap::from([("linux".to_string(), McpDownload { url: "https://example.com/docs.tgz".into(), sha256: "a".repeat(64), archive: ArchiveKind::TarGz, executable: "bin/docs".into() })])),
            timeout_seconds: Some(30),
        }
    }

    #[test]
    fn an_entry_goes_through_the_form_and_back_unchanged() {
        let entry = stdio_entry();
        assert_eq!(to_entry(&from_entry(&entry)).unwrap(), entry);
        let http = McpEntry { transport: McpTransport::Http, command: None, args: None, env: None, url: Some("https://mcp.example.com/sse".into()), headers: Some(BTreeMap::from([("Authorization".to_string(), "Bearer ${MCP_TOKEN}".to_string())])), secrets: Some(vec!["MCP_TOKEN".into()]), downloads: None, timeout_seconds: None, ..stdio_entry() };
        assert_eq!(to_entry(&from_entry(&http)).unwrap(), http);
    }

    #[test]
    fn a_new_form_has_no_downloads_enabled_and_offers_all_three_systems() {
        let draft = EntryDraft::default();
        assert_eq!(draft.downloads.keys().map(String::as_str).collect::<Vec<_>>(), ["darwin", "linux", "windows"]);
        assert!(draft.downloads.values().all(|download| !download.enabled));
        assert_eq!(to_entry(&draft).unwrap().downloads, None);
    }

    #[test]
    fn the_other_transports_fields_are_not_sent() {
        let mut draft = from_entry(&stdio_entry());
        draft.transport = McpTransport::Http;
        draft.url = "https://mcp.example.com".into();
        let entry = to_entry(&draft).unwrap();
        assert_eq!((entry.command, entry.args, entry.url.as_deref()), (None, None, Some("https://mcp.example.com")));
    }

    #[test]
    fn empty_rows_blank_lines_and_empty_text_are_left_out() {
        let mut draft = from_entry(&stdio_entry());
        draft.env.push((String::new(), "orphan".into()));
        draft.args = "--a\n\n  \n--b".into();
        draft.description = "  ".into();
        let entry = to_entry(&draft).unwrap();
        assert_eq!(entry.env.unwrap().len(), 1);
        assert_eq!(entry.args.unwrap(), ["--a", "--b"]);
        assert_eq!(entry.description, None);
    }

    #[test]
    fn a_timeout_must_be_a_number_and_secrets_split_on_commas_and_spaces() {
        let mut draft = from_entry(&stdio_entry());
        draft.timeout = "soon".into();
        assert_eq!(to_entry(&draft).unwrap_err().field, "entry.timeoutSeconds");
        draft.timeout = String::new();
        assert_eq!(to_entry(&draft).unwrap().timeout_seconds, None);
        assert_eq!(split_names("A_ONE, B_TWO  C_THREE\nD"), ["A_ONE", "B_TWO", "C_THREE", "D"]);
    }

    #[test]
    fn an_unticked_download_is_dropped_but_kept_in_the_form() {
        let mut draft = from_entry(&stdio_entry());
        draft.downloads.get_mut("linux").unwrap().enabled = false;
        assert_eq!(to_entry(&draft).unwrap().downloads, None);
        assert_eq!(draft.downloads["linux"].url, "https://example.com/docs.tgz", "ticking it again brings the values back");
    }

    #[test]
    fn archives_are_written_the_way_the_contract_spells_them() {
        for kind in [ArchiveKind::None, ArchiveKind::Zip, ArchiveKind::TarGz] {
            assert_eq!(parse_archive(archive_word(kind)), kind);
        }
        assert_eq!(archive_word(ArchiveKind::TarGz), "tar.gz");
    }

    #[test]
    fn the_checks_that_run_while_typing_agree_with_the_form() {
        let mut draft = from_entry(&stdio_entry());
        assert!(entry_problems(&to_entry(&draft).unwrap(), true).is_empty());
        draft.secrets = String::new();
        assert!(entry_problems(&to_entry(&draft).unwrap(), true)[0].message.contains("DOCS_TOKEN"));
    }
}

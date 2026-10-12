//! Fleet limits: one set of budget limits for every agent, edited by administrators and sent to all agents. An agent uses its own
//! environment values until it has received one.

use crate::{
    api::{self, Method},
    format::when_ago,
    live::Live,
    ops::{
        diff::{DiffView, summary},
        form::{model_from_texts, model_texts},
        state::delivery_problem,
        validate::{Problem, global_prompt_counter, limits_from_text, note_counter, note_problem},
    },
    session::use_session,
    shell::Gate,
    widgets::{CounterText, ErrorNotice, FieldMessage, Outcome, OutcomeNotice, Waiting, use_api},
};
use dioxus::prelude::*;
use fleet_shared::operations::{AgentLimitsState, DEFAULT_GLOBAL_PROMPT, Effort, LimitsPut, LimitsRevision, LimitsRevisionList, LimitsValues, LimitsView};

const FIELDS: [(&str, &str, &str); 4] = [
    ("values.maxTokensCap", "Maximum tokens per job", "The most tokens one job may be given."),
    ("values.maxMinutesCap", "Maximum minutes per job", "The longest one job may run."),
    ("values.dailyTokenLimit", "Daily token limit", "Tokens an agent may spend on jobs per day."),
    ("values.budgetRaiseCeiling", "Budget raise ceiling", "The most extra tokens an agent accepts per pool and day, over all raises."),
];

fn texts_of(values: &LimitsValues) -> [String; 4] {
    [values.max_tokens_cap.to_string(), values.max_minutes_cap.to_string(), values.daily_token_limit.to_string(), values.budget_raise_ceiling.to_string()]
}

/// What the global prompt editor holds: whether the agents' built-in text is used, and the text typed for a text of the fleet's own.
#[derive(Clone, Debug, PartialEq, Eq)]
struct PromptDraft {
    built_in: bool,
    text: String,
}

impl PromptDraft {
    fn of(values: Option<&LimitsValues>) -> Self {
        match values.and_then(|values| values.global_prompt.clone()) {
            Some(text) => Self { built_in: false, text },
            None => Self { built_in: true, text: DEFAULT_GLOBAL_PROMPT.to_string() },
        }
    }

    /// What is sent: nothing keeps the agents' built-in text, an empty text means no global prompt.
    fn value(&self) -> Option<String> {
        (!self.built_in).then(|| self.text.trim().to_string())
    }
}

/// How an agent stands against the saved limits, in words.
pub fn agent_line(agent: &AgentLimitsState, current: u64) -> String {
    if let Some(rejected) = &agent.rejected {
        return format!("rejected revision {}: {}", rejected.revision, rejected.reason);
    }
    match agent.applied_revision {
        Some(applied) if applied >= current => format!("applied revision {applied}"),
        Some(applied) => format!("at revision {applied}, waiting for {current}"),
        None => "no revision reported".into(),
    }
}

#[component]
pub fn Limits() -> Element {
    rsx! { Gate { admin: true, LimitsPage {} } }
}

#[component]
fn LimitsPage() -> Element {
    let view = use_api::<LimitsView>("/limits".into(), Some(15_000));
    let Some(data) = view.get() else {
        return rsx! { h1 { class: "page-title", "Fleet limits" }, Waiting { what: "the fleet limits", failure: view.failed() } };
    };
    let current = data.current.clone();
    let revision = current.as_ref().map_or(0, |current| current.revision);
    rsx! {
        h1 { class: "page-title", "Fleet limits" }
        p { class: "lede", "One set of budget limits for every agent. It is sent separately from any setup override; an agent uses its own environment values until it has received one." }
        if let Some(failure) = view.failed() { ErrorNotice { failure } }
        for saved in [revision] { LimitsForm { key: "{saved}", current: current.clone(), on_saved: move |_| view.restart() } }
        h3 { class: "sub", "Agents" }
        div { class: "machine-table", table {
            caption { "Which limits revision each agent reports" }
            thead { tr { th { "Agent" }, th { "Limits" }, th { "Delivery" } } }
            tbody {
                if data.agents.is_empty() { tr { td { colspan: "3", class: "empty", "No agents are known yet." } } }
                for agent in data.agents.clone() { LimitsAgentRow { key: "{agent.id}", agent, current: revision } }
            }
        } }
        for saved in [revision] { LimitsRevisions { key: "{saved}" } }
    }
}

#[component]
fn LimitsAgentRow(agent: AgentLimitsState, current: u64) -> Element {
    let line = agent_line(&agent, current);
    let problem = delivery_problem(&agent.delivery);
    let sent = agent.delivery.sent_revision.map(|revision| format!("sent revision {revision}")).unwrap_or_else(|| "nothing sent".into());
    rsx! {
        tr {
            td { Link { class: "machine-name agent-link-name", to: crate::Route::AgentPage { slug: agent.slug.clone(), tab: crate::ops::agent_page::AgentTab::Overview }, "{agent.id}" } }
            td { span { class: "numeric", "{line}" } }
            td { small { "{sent}" }, if let Some(text) = problem { small { class: "wrap bad-text", "{text}" } } }
        }
    }
}

#[component]
fn LimitsForm(current: Option<LimitsRevision>, on_saved: EventHandler<()>) -> Element {
    let session = use_session();
    let editable = session.is_admin();
    let start = current.as_ref().map(|current| texts_of(&current.values)).unwrap_or_default();
    let start_prompt = PromptDraft::of(current.as_ref().map(|current| &current.values));
    let start_model = model_texts(current.as_ref().and_then(|current| current.values.model.as_ref()));
    let mut model = use_signal(|| start_model.clone());
    let mut prompt = use_signal(|| start_prompt.clone());
    let mut texts = use_signal(|| start.clone());
    let mut base = use_signal(|| current.as_ref().map_or(0, |current| current.revision));
    let mut note = use_signal(String::new);
    let mut outcome = use_signal(|| Outcome::None);
    let mut server_problems = use_signal(Vec::<Problem>::new);
    let mut busy = use_signal(|| false);

    use_effect(move || {
        texts.read();
        prompt.read();
        model.read();
        if !server_problems.peek().is_empty() {
            server_problems.set(Vec::new());
        }
    });
    let typed = texts.read().clone();
    let typed_prompt = prompt.read().clone();
    let typed_model = model.read().clone();
    let parsed = limits_from_text([&typed[0], &typed[1], &typed[2], &typed[3]], typed_prompt.value(), model_from_texts(&typed_model));
    let mut problems: Vec<Problem> = match &parsed {
        Err(found) => found.iter().filter(|problem| !typed_empty_and_new(&typed, &problem.field, current.is_none())).cloned().collect(),
        Ok(_) => Vec::new(),
    };
    let note_text = note.read().clone();
    problems.extend(note_problem(&note_text));
    let all: Vec<Problem> = problems.iter().cloned().chain(server_problems.read().iter().cloned()).collect();
    let changed = typed != start || typed_prompt != start_prompt || typed_model != start_model;
    let blocked = parsed.is_err() || note_problem(&note_text).is_some();
    let note_count = note_counter(&note_text);
    let saved_by = current.as_ref().map(|current| format!("Revision {} saved by {}", current.revision, current.author));

    let save = move |_| {
        let Ok(values) = limits_from_text([&texts.read()[0], &texts.read()[1], &texts.read()[2], &texts.read()[3]], prompt.read().value(), model_from_texts(&model.read())) else { return };
        let body = LimitsPut { base_revision: base(), values, note: Some(note.read().trim().to_string()).filter(|text| !text.is_empty()) };
        busy.set(true);
        server_problems.set(Vec::new());
        outcome.set(Outcome::None);
        spawn(async move {
            match api::write::<_, LimitsRevision>(Method::Put, "/limits", Some(&body)).await {
                Ok(saved) => {
                    base.set(saved.revision);
                    note.set(String::new());
                    outcome.set(Outcome::Saved(format!("Saved revision {}. It is sent to every agent; the table below shows when each has applied it.", saved.revision)));
                    on_saved.call(());
                }
                Err(failure) => {
                    if failure.status == 422 {
                        server_problems.set(vec![Problem { field: failure.error.field.clone().unwrap_or_default(), message: failure.error.message.clone() }]);
                    }
                    outcome.set(Outcome::Failed(failure));
                }
            }
            busy.set(false);
        });
    };

    rsx! {
        section { class: "platform-card editor limits-form", "aria-label": "Fleet limits",
            if let Some(text) = saved_by { p { class: "hint", "{text}" } } else { p { class: "hint", "No limits are saved: agents use the values of their own environment." } }
            if !editable { div { class: "notice", role: "status", "Only administrators change the fleet limits." } }
            fieldset { class: "group", disabled: !editable,
                legend { "Limits" }
                for (index, (field, label, hint)) in FIELDS.into_iter().enumerate() {
                    div { key: "{field}", class: "field",
                        label { r#for: "limit-{index}", "{label}" }
                        input { id: "limit-{index}", r#type: "text", inputmode: "numeric", value: "{typed[index]}", "aria-describedby": "limit-{index}-hint limit-{index}-error",
                            oninput: move |event| texts.write()[index] = event.value() }
                        small { id: "limit-{index}-hint", class: "hint", "{hint}" }
                        FieldMessage { problems: all.clone(), field: field.to_string(), id: format!("limit-{index}-error") }
                    }
                }
            }
            fieldset { class: "group", disabled: !editable,
                legend { "Model" }
                p { class: "hint", "The provider, model and reasoning effort of every agent. Each is set on its own and a blank one means the agents' environment (PI_PROVIDER, PI_MODEL, PI_EFFORT). An agent's own setup can replace single parts on its page. The model must be one the agent allows; an agent whose model does not take the effort rejects the revision and says why. Applies from each agent's next model run." }
                div { class: "field",
                    label { r#for: "fleet-model-provider", "Provider" }
                    input { id: "fleet-model-provider", r#type: "text", value: "{typed_model[0]}", placeholder: "inherit: the agents' environment", autocomplete: "off", spellcheck: false, "aria-describedby": "fleet-model-error",
                        oninput: move |event| model.write()[0] = event.value() }
                }
                div { class: "field",
                    label { r#for: "fleet-model-id", "Model" }
                    input { id: "fleet-model-id", r#type: "text", value: "{typed_model[1]}", placeholder: "inherit: the agents' environment", autocomplete: "off", spellcheck: false, "aria-describedby": "fleet-model-error",
                        oninput: move |event| model.write()[1] = event.value() }
                }
                div { class: "field",
                    label { r#for: "fleet-model-effort", "Reasoning effort" }
                    select { id: "fleet-model-effort", value: "{typed_model[2]}", "aria-describedby": "fleet-model-error",
                        onchange: move |event| model.write()[2] = event.value(),
                        option { value: "", selected: typed_model[2].is_empty(), "Inherit (the agents' environment)" }
                        for effort in Effort::ALL { option { key: "{effort.as_str()}", value: "{effort.as_str()}", selected: effort.as_str() == typed_model[2], "{effort.as_str()}" } }
                    }
                }
                FieldMessage { problems: all.clone(), field: "values.model".to_string(), id: "fleet-model-error".to_string() }
            }
            fieldset { class: "group", disabled: !editable,
                legend { "Global prompt" }
                p { class: "hint", "Added to every agent's prompt after its role's own prompt and before its operator instructions. An agent can switch it off on its own page. Applies from each agent's next model run." }
                label { class: "check",
                    input { r#type: "checkbox", checked: typed_prompt.built_in, onchange: move |event: Event<FormData>| {
                        let built_in = event.checked();
                        let mut next = prompt.read().clone();
                        if built_in { next = PromptDraft { built_in: true, text: DEFAULT_GLOBAL_PROMPT.to_string() }; } else { next.built_in = false; }
                        prompt.set(next);
                    } }
                    span { b { "Use the agents' built-in text" }, small { class: "wrap", " It tells an agent to ask the other agents for help and how (agents_list, agents_search, message_send). Untick it to write your own; an empty text means no global prompt at all." } }
                }
                label { r#for: "global-prompt", "Text" }
                textarea {
                    id: "global-prompt", class: "mono", rows: "12", value: "{typed_prompt.text}", disabled: !editable || typed_prompt.built_in, spellcheck: false,
                    "aria-describedby": "global-prompt-count global-prompt-error",
                    oninput: move |event| { let mut next = prompt.read().clone(); next.text = event.value(); prompt.set(next); },
                }
                div { class: "field-foot", CounterText { counter: global_prompt_counter(&typed_prompt.text), unit: "characters".to_string(), id: "global-prompt-count".to_string() } }
                FieldMessage { problems: all.clone(), field: "values.globalPrompt".to_string(), id: "global-prompt-error".to_string() }
            }
            if editable {
                label { r#for: "limits-note", "Note for this revision (optional)" }
                textarea { id: "limits-note", rows: "2", value: "{note_text}", "aria-describedby": "limits-note-count", oninput: move |event| note.set(event.value()) }
                div { class: "field-foot", CounterText { counter: note_count, unit: "characters".to_string(), id: "limits-note-count".to_string() } }
                div { class: "buttons", button { class: "primary", disabled: blocked || busy() || !changed, onclick: save, if busy() { "Saving…" } else { "Save as a new revision" } } }
            }
            OutcomeNotice { outcome: outcome.read().clone() }
        }
    }
}

/// A form that has never saved anything starts empty: do not scold it for fields nobody has typed in yet.
fn typed_empty_and_new(typed: &[String; 4], field: &str, is_new: bool) -> bool {
    let index = FIELDS.iter().position(|(name, _, _)| *name == field);
    is_new && index.is_some_and(|index| typed[index].trim().is_empty())
}

#[component]
fn LimitsRevisions() -> Element {
    let list = use_api::<LimitsRevisionList>("/limits/revisions".into(), None);
    let live = use_context::<Live>();
    let now = *live.now.read();
    let Some(data) = list.get() else {
        return rsx! { Waiting { what: "the revisions", failure: list.failed() } };
    };
    rsx! {
        h3 { class: "sub", "Revisions" }
        if data.revisions.is_empty() { p { class: "empty", "No limits have been saved yet." } }
        div { class: "revisions",
            for item in data.revisions {
                article { key: "{item.revision.revision}", class: "platform-card revision", "aria-label": "Limits revision {item.revision.revision}",
                    h4 { "Revision {item.revision.revision}", small { "{when_ago(Some(&item.revision.created_at), now)}" } }
                    p { class: "meta", "{item.revision.author} · {note_of(&item.revision.note)}" }
                    details { summary { "Changed: {summary(&item.diff)}" }, DiffView { entries: item.diff.clone() } }
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
    use fleet_shared::operations::RejectedSetup;

    #[test]
    fn the_values_are_shown_as_typed_numbers() {
        let values = LimitsValues { max_tokens_cap: 1_000_000, max_minutes_cap: 30, daily_token_limit: 5_000_000, budget_raise_ceiling: 8_000_000, global_prompt: None, model: None };
        assert_eq!(texts_of(&values), ["1000000", "30", "5000000", "8000000"]);
        assert_eq!(limits_from_text([&texts_of(&values)[0], &texts_of(&values)[1], &texts_of(&values)[2], &texts_of(&values)[3]], None, None).unwrap(), values);
    }

    #[test]
    fn the_global_prompt_is_the_built_in_text_until_the_fleet_writes_its_own() {
        let with = |global_prompt: Option<&str>| LimitsValues { max_tokens_cap: 1, max_minutes_cap: 1, daily_token_limit: 1, budget_raise_ceiling: 1, global_prompt: global_prompt.map(str::to_string), model: None };
        let built_in = PromptDraft::of(Some(&with(None)));
        assert_eq!((built_in.built_in, built_in.text.as_str(), built_in.value()), (true, DEFAULT_GLOBAL_PROMPT, None), "nothing is sent for the built-in text");
        assert_eq!(PromptDraft::of(None), built_in, "a fleet that saved nothing uses it too");
        let own = PromptDraft::of(Some(&with(Some("Be kind."))));
        assert_eq!((own.built_in, own.value().as_deref()), (false, Some("Be kind.")));
        assert_eq!(PromptDraft { built_in: false, text: "  \n".into() }.value().as_deref(), Some(""), "an empty text is sent: it means no global prompt");
    }

    #[test]
    fn an_agent_is_described_against_the_saved_revision() {
        let agent = |applied: Option<u64>| AgentLimitsState { applied_revision: applied, ..Default::default() };
        assert_eq!(agent_line(&agent(Some(4)), 4), "applied revision 4");
        assert_eq!(agent_line(&agent(Some(3)), 4), "at revision 3, waiting for 4");
        assert_eq!(agent_line(&agent(None), 4), "no revision reported");
        let rejected = AgentLimitsState { rejected: Some(RejectedSetup { kind: "limits".into(), revision: 5, reason: "not a positive integer".into(), at: None }), ..Default::default() };
        assert_eq!(agent_line(&rejected, 5), "rejected revision 5: not a positive integer");
    }

    #[test]
    fn a_form_that_has_saved_nothing_is_not_scolded_for_empty_fields() {
        let empty = [String::new(), "x".into(), String::new(), String::new()];
        assert!(typed_empty_and_new(&empty, "values.maxTokensCap", true));
        assert!(!typed_empty_and_new(&empty, "values.maxTokensCap", false), "once limits exist, an emptied field is a mistake");
        assert!(!typed_empty_and_new(&empty, "values.maxMinutesCap", true), "a field that has text is checked");
    }
}

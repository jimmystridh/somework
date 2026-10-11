//! Small pieces the Operations pages share: loading with a poll, error and state notices, counters and the inline confirmation.

use crate::{
    api::{self, Failure},
    ops::{
        state::SetupState,
        validate::{Counter, Problem, message_for},
    },
};
use dioxus::prelude::*;
use gloo_timers::future::TimeoutFuture;
use serde::de::DeserializeOwned;

/// A resource of the Operations API that reloads on demand and, with `poll_ms`, by itself. A failed reload keeps the last good value and
/// records the failure beside it, so a hiccup does not blank the page.
pub struct Api<T: 'static> {
    pub data: Signal<Option<T>>,
    pub failure: Signal<Option<Failure>>,
    reload: Signal<u32>,
}

impl<T> Clone for Api<T> {
    fn clone(&self) -> Self {
        *self
    }
}

impl<T> Copy for Api<T> {}

impl<T: Clone + 'static> Api<T> {
    pub fn get(&self) -> Option<T> {
        self.data.read().clone()
    }

    pub fn failed(&self) -> Option<Failure> {
        self.failure.read().clone()
    }

    pub fn restart(&self) {
        let mut reload = self.reload;
        reload += 1;
    }
}

pub fn use_api<T: DeserializeOwned + Clone + 'static>(path: String, poll_ms: Option<u32>) -> Api<T> {
    let mut data = use_signal(|| None::<T>);
    let mut failure = use_signal(|| None::<Failure>);
    let reload = use_signal(|| 0u32);
    let mut tick = use_signal(|| 0u32);
    use_future(move || async move {
        let Some(wait) = poll_ms else { return };
        loop {
            TimeoutFuture::new(wait).await;
            tick += 1;
        }
    });
    use_resource(use_reactive!(|(path,)| {
        let _ = (reload(), tick());
        async move {
            match api::get::<T>(&path).await {
                Ok(value) => {
                    data.set(Some(value));
                    failure.set(None);
                }
                Err(error) => failure.set(Some(error)),
            }
        }
    }));
    Api { data, failure, reload }
}

/// The address to come back to after signing in again.
fn here() -> String {
    format!("/fleet{}", router().full_route_string())
}

#[component]
pub fn ErrorNotice(failure: Failure) -> Element {
    let message = failure.message();
    let sign_in = failure.not_signed_in().then(|| api::sign_in_url(&here()));
    rsx! {
        div { class: "notice error", role: "alert",
            "{message}"
            if let Some(url) = sign_in { " " a { href: "{url}", "Sign in again" } }
        }
    }
}

/// What a page shows while it has nothing: loading, or why it could not load.
#[component]
pub fn Waiting(what: String, failure: Option<Failure>) -> Element {
    match failure {
        Some(failure) => rsx! { ErrorNotice { failure } },
        None => rsx! { p { class: "empty", role: "status", "Loading {what}…" } },
    }
}

#[component]
pub fn StateBadge(state: SetupState) -> Element {
    let class = state.class();
    let label = state.label();
    let dot = if state == SetupState::Applied || state == SetupState::Default { "dot" } else { "dot pending" };
    rsx! { span { class: "status {class}", span { class: "{dot}" }, "{label}" } }
}

#[component]
pub fn CounterText(counter: Counter, unit: String, id: String) -> Element {
    let text = counter.text(&unit);
    let over = if counter.over() { "counter over" } else { "counter" };
    rsx! { span { id: "{id}", class: "{over}", "aria-live": "polite", "{text}", if counter.over() { " · too long" } } }
}

/// The message for a field, shown under it; `id` is what the input's `aria-describedby` names.
#[component]
pub fn FieldMessage(problems: Vec<Problem>, field: String, id: String) -> Element {
    match message_for(&problems, &field) {
        Some(message) => rsx! { p { id: "{id}", class: "field-error", role: "alert", "{message}" } },
        None => rsx! {},
    }
}

/// A labelled input row. The label is tied to the input by `id`.
#[component]
pub fn Field(id: String, label: String, hint: Option<String>, children: Element) -> Element {
    rsx! {
        div { class: "field",
            label { r#for: "{id}", "{label}" }
            {children}
            if let Some(hint) = hint { small { class: "hint", "{hint}" } }
        }
    }
}

/// A confirmation that stays on the page: the question, the action and a way back.
#[component]
pub fn Confirm(question: String, action: String, busy: bool, onconfirm: EventHandler<()>, oncancel: EventHandler<()>) -> Element {
    rsx! {
        div { class: "confirm", role: "alertdialog", "aria-label": "{question}",
            p { "{question}" }
            div { class: "buttons",
                button { class: "danger", disabled: busy, onclick: move |_| onconfirm.call(()), "{action}" }
                button { class: "plain", onclick: move |_| oncancel.call(()), "Cancel" }
            }
        }
    }
}

/// The result of the last save, shown where the buttons are.
#[derive(Clone, Debug, PartialEq)]
pub enum Outcome {
    None,
    Saved(String),
    Failed(Failure),
}

#[component]
pub fn OutcomeNotice(outcome: Outcome) -> Element {
    match outcome {
        Outcome::None => rsx! {},
        Outcome::Saved(text) => rsx! { div { class: "notice ok", role: "status", "{text}" } },
        Outcome::Failed(failure) => rsx! { ErrorNotice { failure } },
    }
}

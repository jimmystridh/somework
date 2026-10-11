//! The allow list: who may sign in to Operations and with which role. Administrators only; the last administrator cannot be removed.

use crate::{
    api::{self, Method},
    format::when_ago,
    live::Live,
    session::use_session,
    shell::Gate,
    widgets::{Confirm, ErrorNotice, Outcome, OutcomeNotice, Waiting, use_api},
};
use dioxus::prelude::*;
use fleet_shared::operations::{Role, UserList, UserPut, UserView};

pub const ROLES: [Role; 3] = [Role::Viewer, Role::Editor, Role::Admin];

pub fn role_help(role: Role) -> &'static str {
    match role {
        Role::Viewer => "reads everything",
        Role::Editor => "also edits agents, the MCP catalog and the skill library",
        Role::Admin => "also edits fleet limits and this list",
    }
}

/// A plausible email address: enough to catch a typo before the server does its own check.
pub fn email_problem(text: &str) -> Option<&'static str> {
    let email = text.trim();
    let valid = email.len() <= 254 && email.split_once('@').is_some_and(|(local, domain)| !local.is_empty() && domain.contains('.') && !domain.starts_with('.') && !domain.ends_with('.')) && !email.chars().any(|c| c.is_control() || c.is_whitespace());
    if valid { None } else { Some("That is not an email address.") }
}

pub fn parse_role(text: &str) -> Role {
    Role::parse(text).unwrap_or(Role::Viewer)
}

#[component]
pub fn Users() -> Element {
    rsx! { Gate { admin: true, UsersPage {} } }
}

#[component]
fn UsersPage() -> Element {
    let list = use_api::<UserList>("/users".into(), None);
    let Some(data) = list.get() else {
        return rsx! { h1 { class: "page-title", "Users" }, Waiting { what: "the users", failure: list.failed() } };
    };
    let admins = data.users.iter().filter(|user| user.role == Role::Admin).count();
    rsx! {
        h1 { class: "page-title", "Users" }
        p { class: "lede", "The allow list: a person signs in with Entra ID and needs an entry here. Whoever can edit can change every agent, so keep it short." }
        div { class: "machine-table", table {
            caption { "{data.users.len()} users · {admins} administrators" }
            thead { tr { th { "Email" }, th { "Role" }, th { "Added" }, th { "" } } }
            tbody {
                if data.users.is_empty() { tr { td { colspan: "4", class: "empty", "Nobody is on the list." } } }
                for user in data.users.clone() { UserRow { key: "{user.email}", user, on_changed: move |_| list.restart() } }
            }
        } }
        AddUser { on_added: move |_| list.restart() }
    }
}

#[component]
fn UserRow(user: UserView, on_changed: EventHandler<()>) -> Element {
    let session = use_session();
    let live = use_context::<Live>();
    let now = *live.now.read();
    let mut role = use_signal(|| user.role);
    let mut busy = use_signal(|| false);
    let mut confirming = use_signal(|| false);
    let mut outcome = use_signal(|| Outcome::None);
    let you = session.me().is_some_and(|me| me.email == user.email);
    let email = user.email.clone();
    let path = format!("/users/{}", api::segment(&user.email));
    let changed = *role.read() != user.role;
    let apply = {
        let path = path.clone();
        move |_| {
            let (path, body) = (path.clone(), UserPut { role: role() });
            busy.set(true);
            outcome.set(Outcome::None);
            spawn(async move {
                match api::write::<_, UserView>(Method::Put, &path, Some(&body)).await {
                    Ok(saved) => {
                        outcome.set(Outcome::Saved(format!("{} is now {}.", saved.email, saved.role.label())));
                        on_changed.call(());
                    }
                    Err(failure) => outcome.set(Outcome::Failed(failure)),
                }
                busy.set(false);
            });
        }
    };
    let remove = move |_| {
        let path = path.clone();
        busy.set(true);
        spawn(async move {
            match api::write_only::<()>(Method::Delete, &path, None).await {
                Ok(()) => on_changed.call(()),
                Err(failure) => {
                    outcome.set(Outcome::Failed(failure));
                    confirming.set(false);
                }
            }
            busy.set(false);
        });
    };
    let added = when_ago(Some(&user.added_at), now);
    let select_id = format!("role-{}", user.email);
    rsx! {
        tr {
            td { div { class: "machine-name", "{user.email}" }, if you { small { "you" } } }
            td {
                label { class: "sr-only", r#for: "{select_id}", "Role of {email}" }
                select { id: "{select_id}", value: "{role.read().label()}", onchange: move |event| role.set(parse_role(&event.value())),
                    for option in ROLES { option { key: "{option.label()}", value: "{option.label()}", selected: option == *role.read(), "{option.label()}" } }
                }
                small { class: "wrap plain-small", "{role_help(*role.read())}" }
                if changed { div { class: "buttons", button { class: "primary", disabled: busy(), onclick: apply, "Apply" } button { class: "plain", onclick: move |_| role.set(user.role), "Undo" } } }
            }
            td { small { class: "plain-small", "{user.added_by}" }, small { "{added}" } }
            td {
                button { class: "danger", disabled: busy(), onclick: move |_| confirming.set(true), "Remove" }
                if confirming() { Confirm { question: format!("Remove {email} from the list? They can no longer sign in."), action: "Remove".to_string(), busy: busy(), onconfirm: remove, oncancel: move |_| confirming.set(false) } }
                OutcomeNotice { outcome: outcome.read().clone() }
            }
        }
    }
}

#[component]
fn AddUser(on_added: EventHandler<()>) -> Element {
    let mut email = use_signal(String::new);
    let mut role = use_signal(|| Role::Viewer);
    let mut busy = use_signal(|| false);
    let mut failure = use_signal(|| None::<api::Failure>);
    let mut added = use_signal(String::new);
    let typed = email.read().clone();
    let problem = (!typed.trim().is_empty()).then(|| email_problem(&typed)).flatten();
    let add = move |_| {
        let address = email.read().trim().to_lowercase();
        if email_problem(&address).is_some() {
            return;
        }
        let (path, body) = (format!("/users/{}", api::segment(&address)), UserPut { role: role() });
        busy.set(true);
        failure.set(None);
        spawn(async move {
            match api::write::<_, UserView>(Method::Put, &path, Some(&body)).await {
                Ok(saved) => {
                    added.set(format!("{} was added as {}.", saved.email, saved.role.label()));
                    email.set(String::new());
                    on_added.call(());
                }
                Err(error) => failure.set(Some(error)),
            }
            busy.set(false);
        });
    };
    rsx! {
        section { class: "platform-card editor add-user", "aria-label": "Add a user",
            h3 { "Add a person" }
            div { class: "field-row",
                div { class: "field",
                    label { r#for: "new-user-email", "Email address" }
                    input { id: "new-user-email", r#type: "email", value: "{typed}", placeholder: "name@example.com", "aria-describedby": "new-user-error", oninput: move |event| email.set(event.value()) }
                    if let Some(text) = problem { p { id: "new-user-error", class: "field-error", role: "alert", "{text}" } }
                }
                div { class: "field",
                    label { r#for: "new-user-role", "Role" }
                    select { id: "new-user-role", value: "{role.read().label()}", onchange: move |event| role.set(parse_role(&event.value())),
                        for option in ROLES { option { key: "{option.label()}", value: "{option.label()}", selected: option == *role.read(), "{option.label()} · {role_help(option)}" } }
                    }
                }
            }
            div { class: "buttons", button { class: "primary", disabled: busy() || typed.trim().is_empty() || problem.is_some(), onclick: add, "Add to the list" } }
            if let Some(error) = failure.read().clone() { ErrorNotice { failure: error } }
            if !added.read().is_empty() { div { class: "notice ok", role: "status", "{added}" } }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_email_is_checked_for_the_obvious_mistakes() {
        assert_eq!(email_problem("jane@example.com"), None);
        assert_eq!(email_problem(" jane@example.com "), None, "surrounding spaces are trimmed away");
        for bad in ["", "jane", "@example.com", "jane@example", "jane@.com", "jane@example.", "ja ne@example.com"] {
            assert!(email_problem(bad).is_some(), "{bad}");
        }
    }

    #[test]
    fn a_role_is_read_back_from_its_word_and_explained() {
        for role in ROLES {
            assert_eq!(parse_role(role.label()), role);
            assert!(!role_help(role).is_empty());
        }
        assert_eq!(parse_role("root"), Role::Viewer, "an unknown word never grants anything");
    }
}

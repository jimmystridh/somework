//! Who is signed in. The page fetches `/me` once; what the role may do decides which buttons are shown, the server enforces it anyway.

use crate::api::{self, Failure};
use dioxus::prelude::*;
use fleet_shared::operations::{Me, Role};

#[derive(Clone, Debug, PartialEq)]
pub enum Access {
    Loading,
    Ready(Me),
    /// Operations is not configured on this server (no database): the rest of the dashboard still works.
    Unavailable(String),
    Failed(String),
}

#[derive(Clone, Copy, PartialEq)]
pub struct Session(pub Signal<Access>);

pub fn can_edit(role: Role) -> bool {
    role >= Role::Editor
}

pub fn is_admin(role: Role) -> bool {
    role >= Role::Admin
}

impl Session {
    pub fn me(&self) -> Option<Me> {
        match &*self.0.read() {
            Access::Ready(me) => Some(me.clone()),
            _ => None,
        }
    }

    pub fn can_edit(&self) -> bool {
        self.me().is_some_and(|me| can_edit(me.role))
    }

    pub fn is_admin(&self) -> bool {
        self.me().is_some_and(|me| is_admin(me.role))
    }
}

pub fn use_session() -> Session {
    use_context::<Session>()
}

/// What `/me` answered, as the page can act on it: the 401 case is handled by the caller (it redirects to sign-in).
pub fn access_from(result: Result<Me, Failure>) -> Result<Access, Failure> {
    match result {
        Ok(me) => Ok(Access::Ready(me)),
        Err(failure) if failure.not_signed_in() => Err(failure),
        Err(failure) if failure.status == 503 => Ok(Access::Unavailable(failure.message())),
        Err(failure) => Ok(Access::Failed(failure.message())),
    }
}

pub async fn load(mut session: Signal<Access>) -> Option<Failure> {
    match access_from(api::get::<Me>("/me").await) {
        Ok(access) => {
            session.set(access);
            None
        }
        Err(failure) => Some(failure),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn me(role: Role) -> Me {
        Me { email: "a@example.com".into(), role, auth: "entra".into() }
    }

    #[test]
    fn roles_gate_the_buttons() {
        assert!(!can_edit(Role::Viewer) && can_edit(Role::Editor) && can_edit(Role::Admin));
        assert!(!is_admin(Role::Editor) && is_admin(Role::Admin));
    }

    #[test]
    fn a_signed_in_user_is_ready_and_a_missing_database_is_not_a_sign_in_problem() {
        assert_eq!(access_from(Ok(me(Role::Editor))).unwrap(), Access::Ready(me(Role::Editor)));
        let unavailable = api::parse_failure(503, r#"{"code":"unavailable","message":"Operations is not configured on this server (no DATABASE_URL)"}"#);
        assert!(matches!(access_from(Err(unavailable)), Ok(Access::Unavailable(text)) if text.contains("DATABASE_URL")));
        assert!(matches!(access_from(Err(Failure::unreachable())), Ok(Access::Failed(_))));
    }

    #[test]
    fn a_401_sends_the_person_to_sign_in() {
        assert!(access_from(Err(api::parse_failure(401, "{}"))).is_err());
    }
}

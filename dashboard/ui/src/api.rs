//! The calls to `/fleet/api/ops`: JSON in and out, the write header on every change, and the failures in the shape of `ApiError`.

use fleet_shared::operations::{ApiError, SaveConflict};
use gloo_net::http::{Request, Response};
use serde::{Serialize, de::DeserializeOwned};

pub const API: &str = "/fleet/api/ops";
pub const SIGN_IN: &str = "/fleet/auth/login";
const SIGN_OUT: &str = "/fleet/auth/logout";
const WRITE_HEADER: (&str, &str) = ("X-Operations-Request", "1");

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Method {
    Put,
    Post,
    Delete,
}

/// Why a call did not succeed. `status` is 0 when the server could not be reached at all.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Failure {
    pub status: u16,
    pub error: ApiError,
    /// A 409 on an agent's setup carries the newer revision and what changed.
    pub conflict: Option<Box<SaveConflict>>,
}

impl Failure {
    pub fn unreachable() -> Self {
        Self { status: 0, error: ApiError { code: "network".into(), message: "Operations could not be reached. Check the connection and try again.".into(), ..Default::default() }, conflict: None }
    }

    pub fn not_signed_in(&self) -> bool {
        self.status == 401
    }

    /// The server's words, or a sentence that fits the status when it sent none.
    pub fn message(&self) -> String {
        if !self.error.message.is_empty() {
            return self.error.message.clone();
        }
        match self.status {
            0 => Self::unreachable().error.message,
            401 => "You are not signed in.".into(),
            403 => "Your role does not allow this.".into(),
            404 => "There is no such thing.".into(),
            409 => "Someone changed it first.".into(),
            503 => "Operations is not available right now.".into(),
            status => format!("The server answered {status}."),
        }
    }

    pub fn is_conflict(&self) -> bool {
        self.status == 409
    }
}

pub fn parse_failure(status: u16, body: &str) -> Failure {
    let error = serde_json::from_str::<ApiError>(body).unwrap_or_default();
    let conflict = if status == 409 { serde_json::from_str::<SaveConflict>(body).ok().map(Box::new) } else { None };
    Failure { status, error, conflict }
}

/// Where to send someone who is not signed in; `next` is the address (under `/fleet/`) to come back to.
pub fn sign_in_url(next: &str) -> String {
    format!("{SIGN_IN}?next={}", urlencoding::encode(next))
}

/// One path segment: names are restricted by the server, an email address is not.
pub fn segment(value: &str) -> String {
    urlencoding::encode(value).into_owned()
}

async fn failure(response: Response) -> Failure {
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    parse_failure(status, &body)
}

pub async fn get<T: DeserializeOwned>(path: &str) -> Result<T, Failure> {
    let response = Request::get(&format!("{API}{path}")).send().await.map_err(|_| Failure::unreachable())?;
    if !response.ok() {
        return Err(failure(response).await);
    }
    response.json::<T>().await.map_err(|_| Failure { status: 200, error: ApiError { message: "Operations answered in a form this page does not understand.".into(), ..Default::default() }, conflict: None })
}

async fn send(method: Method, path: &str, body: Option<String>) -> Result<Response, Failure> {
    let url = format!("{API}{path}");
    let builder = match method {
        Method::Put => Request::put(&url),
        Method::Post => Request::post(&url),
        Method::Delete => Request::delete(&url),
    }
    .header(WRITE_HEADER.0, WRITE_HEADER.1);
    let request = match body {
        Some(text) => builder.header("Content-Type", "application/json").body(text).map_err(|_| Failure::unreachable())?,
        None => builder.build().map_err(|_| Failure::unreachable())?,
    };
    let response = request.send().await.map_err(|_| Failure::unreachable())?;
    if response.ok() { Ok(response) } else { Err(failure(response).await) }
}

fn encode<B: Serialize>(body: &B) -> Result<String, Failure> {
    serde_json::to_string(body).map_err(|_| Failure { status: 0, error: ApiError { message: "The form could not be turned into a request.".into(), ..Default::default() }, conflict: None })
}

/// A change that answers with the changed thing.
pub async fn write<B: Serialize, T: DeserializeOwned>(method: Method, path: &str, body: Option<&B>) -> Result<T, Failure> {
    let response = send(method, path, body.map(encode).transpose()?).await?;
    response.json::<T>().await.map_err(|_| Failure { status: 200, error: ApiError { message: "Operations answered in a form this page does not understand.".into(), ..Default::default() }, conflict: None })
}

/// A change that answers with nothing (204) or with a body this page does not need.
pub async fn write_only<B: Serialize>(method: Method, path: &str, body: Option<&B>) -> Result<(), Failure> {
    send(method, path, body.map(encode).transpose()?).await.map(|_| ())
}

pub async fn sign_out() -> bool {
    Request::post(SIGN_OUT).header(WRITE_HEADER.0, WRITE_HEADER.1).send().await.is_ok_and(|response| response.ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_failure_keeps_the_servers_words_and_the_field_they_are_about() {
        let failure = parse_failure(422, r#"{"code":"invalid","message":"the MCP entry x needs a command","field":"entry.command"}"#);
        assert_eq!((failure.status, failure.error.code.as_str(), failure.error.field.as_deref()), (422, "invalid", Some("entry.command")));
        assert_eq!(failure.message(), "the MCP entry x needs a command");
    }

    #[test]
    fn a_failure_without_a_readable_body_still_says_something() {
        assert_eq!(parse_failure(403, "").message(), "Your role does not allow this.");
        assert_eq!(parse_failure(502, "<html>").message(), "The server answered 502.");
        assert!(parse_failure(401, "{}").not_signed_in());
        assert_eq!(Failure::unreachable().status, 0);
    }

    #[test]
    fn a_setup_conflict_carries_the_newer_revision() {
        let body = r#"{"code":"revision_conflict","message":"someone saved revision 4","current":{"agent":"agent/qa","revision":4,"form":{},"note":"n","author":"a@example.com","createdAt":"2026-10-10T10:00:00.000Z"},"diff":[]}"#;
        let failure = parse_failure(409, body);
        assert!(failure.is_conflict());
        assert_eq!(failure.conflict.as_ref().map(|conflict| conflict.current.revision), Some(4));
        assert!(parse_failure(409, r#"{"code":"revision_conflict","message":"x"}"#).conflict.is_none(), "a catalog conflict has no newer revision to show");
    }

    #[test]
    fn the_sign_in_address_returns_to_the_page_that_asked() {
        assert_eq!(sign_in_url("/fleet/agents/qa/setup"), "/fleet/auth/login?next=%2Ffleet%2Fagents%2Fqa%2Fsetup");
        assert_eq!(segment("a+b@example.com"), "a%2Bb%40example.com");
    }
}

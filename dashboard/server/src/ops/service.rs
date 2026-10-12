//! Service tokens: another service of the fleet (today the Manager) calls the `/fleet/api/ops` routes with a bearer token instead of a browser
//! session and acts with the role named for it, never above editor. The file holds only SHA-256 digests; the token itself lives on the caller's host.

use super::contract::sha256_hex;
use fleet_shared::operations::Role;
use serde::Deserialize;
use subtle::ConstantTimeEq;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ServiceToken {
    /// The name that appears as the author of a revision and in the audit log, for example `agent/manager`.
    pub name: String,
    sha256: String,
    pub role: Role,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Entry {
    name: String,
    sha256: String,
    role: String,
}

fn valid_name(name: &str) -> bool {
    (3..=64).contains(&name.len()) && name.starts_with(|c: char| c.is_ascii_lowercase()) && name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || "/._-".contains(c))
}

/// `[{"name": "agent/manager", "sha256": "<64 hex digits of the token's SHA-256>", "role": "editor"}]`
pub fn parse(contents: &str) -> Result<Vec<ServiceToken>, String> {
    let entries: Vec<Entry> = serde_json::from_str(contents).map_err(|error| format!("the service token file is not valid: {error}"))?;
    let mut tokens: Vec<ServiceToken> = Vec::new();
    for entry in entries {
        if !valid_name(&entry.name) {
            return Err(format!("service token name {:?} must be 3 to 64 characters of a-z, 0-9 and / . _ -", entry.name));
        }
        let role = Role::parse(&entry.role).filter(|role| *role <= Role::Editor).ok_or_else(|| format!("service token {} needs the role viewer or editor", entry.name))?;
        let sha256 = entry.sha256.trim().to_lowercase();
        if sha256.len() != 64 || !sha256.chars().all(|c| c.is_ascii_hexdigit()) {
            return Err(format!("service token {} needs the 64 hex digits of the token's SHA-256", entry.name));
        }
        if tokens.iter().any(|token| token.name == entry.name || token.sha256 == sha256) {
            return Err(format!("service token {} is listed twice", entry.name));
        }
        tokens.push(ServiceToken { name: entry.name, sha256, role });
    }
    Ok(tokens)
}

/// The service the presented token belongs to. The digests are compared in constant time.
pub fn find<'a>(tokens: &'a [ServiceToken], presented: &str) -> Option<&'a ServiceToken> {
    let digest = sha256_hex(presented.as_bytes());
    tokens.iter().find(|token| bool::from(token.sha256.as_bytes().ct_eq(digest.as_bytes())))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(name: &str, token: &str, role: &str) -> String {
        format!(r#"{{"name": "{name}", "sha256": "{}", "role": "{role}"}}"#, sha256_hex(token.as_bytes()))
    }

    #[test]
    fn a_token_finds_its_service_and_nothing_else() {
        let tokens = parse(&format!("[{}, {}]", entry("agent/manager", "one", "editor"), entry("agent/viewer", "two", "viewer"))).unwrap();
        assert_eq!(find(&tokens, "one").map(|token| (token.name.as_str(), token.role)), Some(("agent/manager", Role::Editor)));
        assert_eq!(find(&tokens, "two").map(|token| token.role), Some(Role::Viewer));
        assert!(find(&tokens, "three").is_none());
        assert!(find(&tokens, "").is_none());
    }

    #[test]
    fn the_file_is_checked() {
        let good = entry("agent/manager", "one", "editor");
        assert!(parse("[]").unwrap().is_empty());
        assert!(parse(&format!("[{good}]")).is_ok());
        assert!(parse(&format!("[{}]", entry("agent/manager", "one", "admin"))).is_err(), "no service is an administrator");
        assert!(parse(&format!("[{}]", entry("Agent Manager", "one", "editor"))).is_err());
        assert!(parse(&format!("[{good}, {good}]")).is_err());
        assert!(parse(r#"[{"name": "agent/manager", "sha256": "abc", "role": "editor"}]"#).is_err());
        assert!(parse(r#"[{"name": "agent/manager", "sha256": "", "role": "editor", "extra": 1}]"#).is_err());
        assert!(parse("not json").is_err());
    }
}

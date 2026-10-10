//! An agent's `/profile` document turned into what the dashboard shows about how the agent is set up.
//!
//! Same structural rule as the rest of the integration: values are picked by name and pass a reader (`identifier`, `count`, `flag`, or `text`
//! for the few fields that are operator wording: the system prompt, approval patterns and their reasons). Nothing is copied wholesale, so a
//! field a newer agent adds is not shown until it is read here, and a profile that holds something it should not (a key, a path) cannot
//! put it on the page. The agent builds the document without secrets in the first place; this is the second line.

use crate::somework::{count, identifier};
use fleet_shared::somework::{AgentSetup, ApprovalPattern, RepositoryAccess};
use serde_json::Value;

const MAX_PROMPT_CHARS: usize = 16_000;
const MAX_LIST: usize = 60;

/// Plain text without control characters, cut at `max` characters. Free wording: shown as text, never as markup.
fn text(value: Option<&Value>, max: usize) -> Option<String> {
    let raw = value?.as_str()?;
    let cleaned: String = raw.chars().filter(|c| !c.is_control() || matches!(c, '\n' | '\t')).take(max).collect();
    (!cleaned.is_empty()).then_some(cleaned)
}

fn flag(value: Option<&Value>) -> bool {
    value.and_then(Value::as_bool).unwrap_or(false)
}

fn identifiers(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|list| list.iter().take(MAX_LIST).filter_map(|item| identifier(Some(item))).collect())
        .unwrap_or_default()
}

/// A `YYYY-MM-DD` date or an RFC 3339 time: the characters a date has, and nothing longer than a timestamp.
fn date(value: Option<&Value>) -> Option<String> {
    let raw = value?.as_str()?;
    let ok = raw.len() >= 10 && raw.len() <= 32 && raw.chars().all(|c| c.is_ascii_digit() || matches!(c, '-' | ':' | 'T' | 'Z' | '.' | '+'));
    ok.then(|| raw.to_string())
}

/// A GitHub login: letters, digits and hyphens, with the `[bot]` suffix an app's account has.
fn bot_login(value: Option<&Value>) -> Option<String> {
    let login = value?.as_str()?;
    let name = login.strip_suffix("[bot]").unwrap_or(login);
    let ok = !name.is_empty() && login.len() <= 64 && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
    ok.then(|| login.to_string())
}

fn capability_list(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .take(MAX_LIST)
                .filter_map(|item| Some(format!("{}@{}", identifier(item.get("id"))?, identifier(item.get("version"))?)))
                .collect()
        })
        .unwrap_or_default()
}

pub fn setup(profile: &Value) -> Option<AgentSetup> {
    if profile.get("schema").and_then(Value::as_u64) != Some(1) {
        return None;
    }
    let model = profile.get("model");
    let prompt = profile.get("systemPrompt");
    let tools = profile.get("tools");
    let budgets = profile.get("budgets");
    let repo = profile.get("repository");
    let chat = profile.get("chat");
    let events = profile.get("events");
    let observe = profile.get("observe");
    let all_tools = tools.and_then(|t| t.get("allowed")).is_some_and(|allowed| allowed.as_str() == Some("all"));
    Some(AgentSetup {
        role: identifier(profile.get("role"))?,
        version: identifier(profile.get("version")).unwrap_or_else(|| "unknown".into()),
        hash: identifier(profile.get("hash")).map(|hash| hash.chars().take(12).collect())?,
        changed_at: date(profile.get("changedAt")),
        capabilities: capability_list(profile.get("capabilities")),
        model: match (identifier(model.and_then(|m| m.get("provider"))), identifier(model.and_then(|m| m.get("modelId")))) {
            (Some(provider), Some(id)) => format!("{provider}/{id}"),
            _ => "unknown".into(),
        },
        allowed_models: identifiers(model.and_then(|m| m.get("allowed"))),
        prompt_sha256: identifier(prompt.and_then(|p| p.get("sha256"))).map(|hash| hash.chars().take(12).collect()).unwrap_or_default(),
        prompt_characters: count(prompt.and_then(|p| p.get("characters"))).unwrap_or(0),
        prompt: text(prompt.and_then(|p| p.get("text")), MAX_PROMPT_CHARS),
        all_tools,
        tools: if all_tools { Vec::new() } else { identifiers(tools.and_then(|t| t.get("allowed"))) },
        command_approvals: tools
            .and_then(|t| t.get("commandApprovals"))
            .and_then(Value::as_array)
            .map(|list| {
                list.iter()
                    .take(MAX_LIST)
                    .filter_map(|item| Some(ApprovalPattern { pattern: text(item.get("pattern"), 300)?, reason: text(item.get("reason"), 200).unwrap_or_default() }))
                    .collect()
            })
            .unwrap_or_default(),
        tool_approvals: identifiers(tools.and_then(|t| t.get("toolApprovals"))),
        extra_approval_patterns: count(tools.and_then(|t| t.get("extraApprovalPatterns"))).unwrap_or(0),
        default_tokens: count(budgets.and_then(|b| b.get("default")).and_then(|d| d.get("maxTokens"))).unwrap_or(0),
        default_minutes: count(budgets.and_then(|b| b.get("default")).and_then(|d| d.get("maxMinutes"))).unwrap_or(0),
        budget_required: flag(budgets.and_then(|b| b.get("required"))),
        max_tokens_cap: count(budgets.and_then(|b| b.get("maxTokensCap"))).unwrap_or(0),
        max_minutes_cap: count(budgets.and_then(|b| b.get("maxMinutesCap"))).unwrap_or(0),
        daily_token_limit: count(budgets.and_then(|b| b.get("dailyTokenLimit"))).unwrap_or(0),
        concurrency: count(profile.get("concurrency")).unwrap_or(0),
        repository: RepositoryAccess {
            push: flag(repo.and_then(|r| r.get("push"))),
            pull_request: flag(repo.and_then(|r| r.get("pullRequest"))),
            branch_prefix: identifier(repo.and_then(|r| r.get("branchPrefix"))).unwrap_or_default(),
            no_repository: flag(repo.and_then(|r| r.get("noRepository"))),
            credential: match repo.and_then(|r| r.get("credential")).and_then(Value::as_str) {
                Some("github-app") => "github-app".into(),
                Some("token") => "token".into(),
                _ => "none".into(),
            },
            github_identity: bot_login(repo.and_then(|r| r.get("githubIdentity"))),
            token_hosts: identifiers(repo.and_then(|r| r.get("tokenHosts"))),
            token_expires: date(repo.and_then(|r| r.get("tokenExpires"))),
            draft_pull_requests: flag(repo.and_then(|r| r.get("draftPullRequests"))),
            mirror_repositories: repo
                .and_then(|r| r.get("mirror"))
                .and_then(|m| m.get("repositories"))
                .and_then(Value::as_array)
                .map(|list| list.iter().take(10).filter_map(|item| text(Some(item), 200)).filter(|url| url.starts_with("https://") && !url.contains('@')).collect())
                .unwrap_or_default(),
        },
        skills: identifiers(profile.get("skills")),
        chat_mode: identifier(chat.and_then(|c| c.get("mode"))).unwrap_or_else(|| "unknown".into()),
        chat_approvers: identifiers(chat.and_then(|c| c.get("approvers"))),
        events_enabled: flag(events.and_then(|e| e.get("enabled"))),
        events_notify_to: identifier(events.and_then(|e| e.get("notifyTo"))),
        observe_enabled: flag(observe.and_then(|o| o.get("enabled"))),
        observe_scope: identifier(observe.and_then(|o| o.get("scope"))),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn profile() -> Value {
        json!({
            "schema": 1, "role": "developer", "agentId": "agent/pi-agent", "version": "pilot-12", "hash": "0123456789abcdef0123",
            "changedAt": "2026-10-06T10:00:00.000Z",
            "capabilities": [{"id": "code.agent", "version": "2"}],
            "model": {"provider": "openai-codex", "modelId": "gpt-5.5", "allowed": ["openai-codex/gpt-5.5"]},
            "systemPrompt": {"sha256": "abcdef0123456789abcdef", "characters": 41, "text": "You are the developer.\nNever push to main."},
            "tools": {"allowed": ["read", "bash"], "commandApprovals": [{"pattern": "\\bgit push\\b", "reason": "pushing needs approval"}], "toolApprovals": ["deploy"], "extraApprovalPatterns": 2},
            "budgets": {"default": {"maxTokens": 100000, "maxMinutes": 20}, "required": true, "maxTokensCap": 500000, "maxMinutesCap": 60, "dailyTokenLimit": 1000000},
            "concurrency": 2,
            "repository": {"push": true, "pullRequest": true, "branchPrefix": "agent", "noRepository": false, "credential": "github-app", "githubIdentity": "somework-developer[bot]",
                           "tokenHosts": ["github.com"], "tokenExpires": "2026-11-05", "draftPullRequests": false,
                           "mirror": {"repositories": ["https://github.com/o/r.git"], "refreshMinutes": 30}},
            "skills": ["review"],
            "chat": {"mode": "threads", "approvers": ["agent/manager"]},
            "events": {"enabled": true, "notifyTo": "agent/manager"},
            "observe": {"enabled": false}
        })
    }

    #[test]
    fn a_profile_becomes_the_setup_the_page_shows() {
        let setup = setup(&profile()).unwrap();
        assert_eq!((setup.role.as_str(), setup.version.as_str(), setup.hash.as_str()), ("developer", "pilot-12", "0123456789ab"));
        assert_eq!(setup.capabilities, vec!["code.agent@2"]);
        assert_eq!(setup.model, "openai-codex/gpt-5.5");
        assert_eq!(setup.prompt.as_deref(), Some("You are the developer.\nNever push to main."));
        assert_eq!(setup.prompt_sha256, "abcdef012345");
        assert_eq!(setup.tools, vec!["read", "bash"]);
        assert!(!setup.all_tools);
        assert_eq!(setup.command_approvals[0].pattern, "\\bgit push\\b");
        assert_eq!((setup.default_tokens, setup.max_tokens_cap, setup.daily_token_limit, setup.concurrency), (100_000, 500_000, 1_000_000, 2));
        assert_eq!(setup.repository.credential, "github-app");
        assert_eq!(setup.repository.github_identity.as_deref(), Some("somework-developer[bot]"));
        assert_eq!(setup.repository.token_expires.as_deref(), Some("2026-11-05"));
        assert_eq!(setup.repository.mirror_repositories, vec!["https://github.com/o/r.git"]);
        assert_eq!(setup.chat_approvers, vec!["agent/manager"]);
        assert!(setup.events_enabled && !setup.observe_enabled);
    }

    #[test]
    fn a_role_without_a_tool_list_shows_all_tools() {
        let mut value = profile();
        value["tools"]["allowed"] = json!("all");
        let setup = setup(&value).unwrap();
        assert!(setup.all_tools && setup.tools.is_empty());
    }

    #[test]
    fn the_prompt_text_is_optional_and_control_characters_are_dropped() {
        let mut value = profile();
        value["systemPrompt"] = json!({"sha256": "aa", "characters": 5, "text": "hi\u{7}\u{1b}[31m there"});
        assert_eq!(setup(&value).unwrap().prompt.as_deref(), Some("hi[31m there"));
        value["systemPrompt"] = json!({"sha256": "aa", "characters": 5});
        assert_eq!(setup(&value).unwrap().prompt, None);
    }

    #[test]
    fn fields_the_page_does_not_read_never_reach_it() {
        let mut value = profile();
        value["githubToken"] = json!("ghs_SECRETSECRET");
        value["repository"]["tokenFile"] = json!("/run/secrets/git-token");
        value["repository"]["token"] = json!("ghp_SECRETSECRET");
        value["env"] = json!({"OPENAI_API_KEY": "sk-SECRET"});
        let shown = serde_json::to_string(&setup(&value).unwrap()).unwrap();
        for secret in ["SECRETSECRET", "sk-SECRET", "/run/secrets", "OPENAI_API_KEY"] {
            assert!(!shown.contains(secret), "{secret} must not be shown");
        }
    }

    #[test]
    fn unsafe_values_are_refused_or_cleaned() {
        let mut value = profile();
        value["role"] = json!("<script>alert(1)</script>");
        assert!(setup(&value).is_none(), "a role that is not an identifier is not a profile we trust");
        let mut value = profile();
        value["repository"]["mirror"]["repositories"] = json!(["https://user:pw@github.com/o/r.git", "file:///etc/passwd", "https://github.com/o/ok.git"]);
        value["repository"]["tokenExpires"] = json!("soon; ghp_secret");
        value["repository"]["githubIdentity"] = json!("evil <b>bot</b>");
        value["repository"]["credential"] = json!("anything");
        let setup = setup(&value).unwrap();
        assert_eq!(setup.repository.mirror_repositories, vec!["https://github.com/o/ok.git"]);
        assert_eq!(setup.repository.token_expires, None);
        assert_eq!(setup.repository.github_identity, None);
        assert_eq!(setup.repository.credential, "none");
    }

    #[test]
    fn an_unknown_schema_is_not_shown() {
        let mut value = profile();
        value["schema"] = json!(2);
        assert!(setup(&value).is_none());
        assert!(setup(&json!({})).is_none());
    }
}

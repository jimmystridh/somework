//! An agent's `/profile` document turned into what the dashboard shows about how the agent is set up.
//!
//! Same structural rule as the rest of the integration: values are picked by name and pass a reader (`identifier`, `count`, `flag`, or `text`
//! for the few fields that are operator wording: the system prompt, approval patterns and their reasons). Nothing is copied wholesale, so a
//! field a newer agent adds is not shown until it is read here, and a profile that holds something it should not (a key, a path) cannot
//! put it on the page. The agent builds the document without secrets in the first place; this is the second line.

use crate::somework::{count, identifier};
use fleet_shared::{
    operations::{Effort, EffectiveMcp, EffectiveSetup, ModelSources, RejectedSetup, ReportedSetup, RoleDefaults},
    somework::{AgentSetup, ApprovalPattern, RepositoryAccess},
};
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

/// `provider/modelId` of a `{provider, modelId}` object.
fn model_name(value: Option<&Value>) -> Option<String> {
    Some(format!("{}/{}", identifier(value?.get("provider"))?, identifier(value?.get("modelId"))?))
}

/// The effort of a `{provider, modelId, effort}` object: one of the known levels, else nothing.
fn model_effort(value: Option<&Value>) -> Option<String> {
    Effort::parse(value?.get("effort")?.as_str()?).map(|effort| effort.as_str().to_string())
}

/// Which layer a part of the model comes from: `env`, `fleet` or `override`.
fn model_layer(value: Option<&Value>) -> Option<String> {
    let word = value?.as_str()?;
    ["env", "fleet", "override"].contains(&word).then(|| word.to_string())
}

fn model_sources(value: Option<&Value>) -> Option<ModelSources> {
    let sources = value.filter(|value| value.is_object())?;
    Some(ModelSources { provider: model_layer(sources.get("provider"))?, model_id: model_layer(sources.get("modelId"))?, effort: model_layer(sources.get("effort")) })
}

fn approval_patterns(value: Option<&Value>) -> Vec<ApprovalPattern> {
    value
        .and_then(Value::as_array)
        .map(|list| list.iter().take(MAX_LIST).filter_map(|item| Some(ApprovalPattern { pattern: text(item.get("pattern"), 300)?, reason: text(item.get("reason"), 200).unwrap_or_default() })).collect())
        .unwrap_or_default()
}

fn effective_setup(effective: &Value) -> EffectiveSetup {
    let instructions = effective.get("instructions");
    EffectiveSetup {
        instructions: text(instructions.and_then(|i| i.get("text")), MAX_PROMPT_CHARS),
        instructions_sha256: identifier(instructions.and_then(|i| i.get("sha256"))).map(|hash| hash.chars().take(12).collect()),
        instructions_characters: count(instructions.and_then(|i| i.get("characters"))).unwrap_or(0),
        model: model_name(effective.get("model")).unwrap_or_default(),
        effort: model_effort(effective.get("model")),
        model_sources: model_sources(effective.get("modelSources")),
        approval_patterns: approval_patterns(effective.get("approvalPatterns")),
        repository_skills: identifiers(effective.get("repositorySkills")),
        library_skills: effective
            .get("librarySkills")
            .and_then(Value::as_array)
            .map(|list| list.iter().take(MAX_LIST).filter_map(|item| Some(format!("{}@{}", identifier(item.get("name"))?, count(item.get("version"))?))).collect())
            .unwrap_or_default(),
        mcp: effective
            .get("mcp")
            .and_then(Value::as_array)
            .map(|list| {
                list.iter()
                    .take(MAX_LIST)
                    .filter_map(|item| {
                        let word = |name: &str, allowed: &[&str]| item.get(name).and_then(Value::as_str).filter(|value| allowed.contains(value)).map(str::to_string);
                        Some(EffectiveMcp {
                            name: identifier(item.get("name"))?,
                            transport: word("transport", &["stdio", "http"])?,
                            approval: word("approval", &["ask", "never", "writes"])?,
                            error: text(item.get("error"), 300),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default(),
    }
}

/// What the agent reports of the documents it applied (`setup` of the profile, `SetupReport` of `packages/agent-kit/src/setup/contract.ts`).
/// `None` when the profile has no `setup` at all: an agent that cannot take a setup document yet. Every part may be missing (the manager
/// serves a subset), and nothing but the named fields is read.
pub fn reported_setup(profile: &Value) -> Option<ReportedSetup> {
    let setup = profile.get("setup").filter(|value| value.is_object())?;
    let applied = |name: &str| setup.get(name).filter(|value| value.is_object());
    let rejected = setup.get("rejected").filter(|value| value.is_object()).and_then(|rejected| {
        let kind = match rejected.get("kind").and_then(Value::as_str)? {
            "override" => "override",
            "limits" => "limits",
            _ => return None,
        };
        Some(RejectedSetup { kind: kind.into(), revision: count(rejected.get("revision"))?, reason: text(rejected.get("reason"), 300).unwrap_or_default(), at: date(rejected.get("at")) })
    });
    Some(ReportedSetup {
        override_revision: applied("override").and_then(|o| count(o.get("revision"))),
        override_applied_at: applied("override").and_then(|o| date(o.get("appliedAt"))),
        limits_revision: applied("limits").and_then(|l| count(l.get("revision"))),
        limits_applied_at: applied("limits").and_then(|l| date(l.get("appliedAt"))),
        rejected,
        effective: applied("effective").map(effective_setup),
    })
}

/// The role's built-in setup, to show what an override changes: `setup.defaults` (its approval patterns, repository skills, model and allowed
/// models) and the role's own prompt, which an override only appends to. `None` for an agent that reports no defaults.
pub fn role_defaults(profile: &Value) -> Option<RoleDefaults> {
    let defaults = profile.get("setup").and_then(|setup| setup.get("defaults")).filter(|value| value.is_object())?;
    let prompt = profile.get("systemPrompt");
    Some(RoleDefaults {
        role: identifier(profile.get("role")).unwrap_or_default(),
        prompt: text(prompt.and_then(|p| p.get("text")), MAX_PROMPT_CHARS),
        prompt_sha256: identifier(prompt.and_then(|p| p.get("sha256"))).map(|hash| hash.chars().take(12).collect()).unwrap_or_default(),
        prompt_characters: count(prompt.and_then(|p| p.get("characters"))).unwrap_or(0),
        model: model_name(defaults.get("model")).unwrap_or_default(),
        effort: model_effort(defaults.get("model")),
        allowed_models: defaults.get("allowedModels").and_then(Value::as_array).map(|list| list.iter().take(MAX_LIST).filter_map(|item| model_name(Some(item))).collect()).unwrap_or_default(),
        approval_patterns: approval_patterns(defaults.get("approvalPatterns")),
        repository_skills: identifiers(defaults.get("repositorySkills")),
    })
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
        reported: reported_setup(profile),
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
    fn the_reported_setup_is_read_by_name() {
        let mut value = profile();
        assert!(reported_setup(&value).is_none(), "an agent without `setup` cannot take a document");
        value["setup"] = json!({
            "override": {"revision": 7, "hash": "abc", "appliedAt": "2026-10-10T10:00:00.000Z", "secret": "PRIVATE"},
            "limits": {"revision": 2, "appliedAt": "2026-10-10T09:00:00.000Z"},
            "rejected": {"kind": "override", "revision": 8, "reason": "the MCP entry docs needs a command\u{7}", "at": "2026-10-10T10:05:00.000Z", "document": "PRIVATE"}
        });
        let reported = reported_setup(&value).unwrap();
        assert_eq!((reported.override_revision, reported.limits_revision), (Some(7), Some(2)));
        assert_eq!(reported.override_applied_at.as_deref(), Some("2026-10-10T10:00:00.000Z"));
        let rejected = reported.rejected.clone().unwrap();
        assert_eq!((rejected.kind.as_str(), rejected.revision, rejected.reason.as_str()), ("override", 8, "the MCP entry docs needs a command"));
        assert!(reported.effective.is_none(), "a report without `effective` (the manager's subset) is still a report");
        assert!(!format!("{reported:?}").contains("PRIVATE"));
        value["setup"] = json!({"override": null, "limits": null});
        let reported = reported_setup(&value).unwrap();
        assert_eq!((reported.override_revision, reported.limits_revision, reported.rejected), (None, None, None));
        value["setup"] = json!({"rejected": {"kind": "somethingelse", "revision": 1, "reason": "x"}});
        assert!(reported_setup(&value).unwrap().rejected.is_none());
        value["setup"] = json!({"rejected": {"kind": "limits", "revision": 3, "reason": "x".repeat(900)}});
        assert_eq!(reported_setup(&value).unwrap().rejected.unwrap().reason.len(), 300, "the agent's words are cut");
    }

    #[test]
    fn what_is_in_effect_is_read_without_urls_commands_or_unknown_fields() {
        let mut value = profile();
        value["setup"] = json!({"override": null, "limits": null, "effective": {
            "instructions": {"sha256": "0123456789abcdef0123", "characters": 11, "text": "Be brief.\nOk"},
            "model": {"provider": "anthropic", "modelId": "claude"},
            "approvalPatterns": [{"pattern": "rm -rf", "reason": "dangerous"}],
            "repositorySkills": ["review"],
            "librarySkills": [{"name": "triage", "version": 3}, {"name": "<b>", "version": 1}],
            "mcp": [
                {"name": "docs", "transport": "stdio", "approval": "ask", "command": "PRIVATE-COMMAND", "url": "https://PRIVATE"},
                {"name": "gh", "transport": "http", "approval": "writes", "error": "secret GITHUB_TOKEN is missing"},
                {"name": "odd", "transport": "carrier-pigeon", "approval": "ask"}
            ]
        }});
        let effective = reported_setup(&value).unwrap().effective.unwrap();
        assert_eq!((effective.instructions.as_deref(), effective.instructions_sha256.as_deref(), effective.instructions_characters), (Some("Be brief.\nOk"), Some("0123456789ab"), 11));
        assert_eq!((effective.model.as_str(), effective.library_skills.clone(), effective.repository_skills.clone()), ("anthropic/claude", vec!["triage@3".to_string()], vec!["review".to_string()]));
        assert_eq!(effective.mcp.iter().map(|m| (m.name.as_str(), m.transport.as_str(), m.approval.as_str(), m.error.as_deref())).collect::<Vec<_>>(), vec![("docs", "stdio", "ask", None), ("gh", "http", "writes", Some("secret GITHUB_TOKEN is missing"))]);
        assert!(!format!("{effective:?}").contains("PRIVATE"));
    }

    #[test]
    fn the_effort_and_where_each_part_of_the_model_comes_from_are_read_by_name() {
        let mut value = profile();
        value["setup"] = json!({"override": null, "limits": null, "defaults": {"model": {"provider": "openai-codex", "modelId": "gpt-5.5", "effort": "medium"}}, "effective": {
            "model": {"provider": "openai-codex", "modelId": "gpt-6.1-sol", "effort": "high"},
            "modelSources": {"provider": "env", "modelId": "fleet", "effort": "override", "path": "/PRIVATE"}
        }});
        let effective = reported_setup(&value).unwrap().effective.unwrap();
        assert_eq!((effective.model.as_str(), effective.effort.as_deref()), ("openai-codex/gpt-6.1-sol", Some("high")));
        assert_eq!(effective.model_sources, Some(ModelSources { provider: "env".into(), model_id: "fleet".into(), effort: Some("override".into()) }));
        assert!(!format!("{effective:?}").contains("PRIVATE"));
        assert_eq!(role_defaults(&value).unwrap().effort.as_deref(), Some("medium"), "the environment's effort is what a blank effort inherits");

        value["setup"]["effective"] = json!({"model": {"provider": "p", "modelId": "m", "effort": "extreme"}, "modelSources": {"provider": "somewhere", "modelId": "env"}});
        let odd = reported_setup(&value).unwrap().effective.unwrap();
        assert_eq!((odd.effort, odd.model_sources), (None, None), "an unknown level or layer is not shown");
        value["setup"]["effective"] = json!({"model": {"provider": "p", "modelId": "m"}, "modelSources": {"provider": "env", "modelId": "env"}});
        let plain = reported_setup(&value).unwrap().effective.unwrap();
        assert_eq!((plain.effort, plain.model_sources.unwrap().effort), (None, None), "an agent that sets no effort reports none");
    }

    #[test]
    fn role_defaults_come_from_setup_defaults_and_the_roles_own_prompt() {
        let mut value = profile();
        assert!(role_defaults(&value).is_none(), "no `setup.defaults`, no defaults to show");
        value["setup"] = json!({"override": {"revision": 3, "appliedAt": "2026-10-10T10:00:00.000Z"}, "defaults": {
            "approvalPatterns": [{"pattern": "\\bgit push\\b", "reason": "pushing needs approval"}],
            "repositorySkills": ["triage"],
            "model": {"provider": "anthropic", "modelId": "claude"},
            "allowedModels": [{"provider": "anthropic", "modelId": "claude"}, {"provider": "openai-codex", "modelId": "gpt-5.5"}],
            "apiKey": "PRIVATE"
        }});
        let defaults = role_defaults(&value).unwrap();
        assert_eq!((defaults.role.as_str(), defaults.model.as_str(), defaults.prompt_sha256.as_str()), ("developer", "anthropic/claude", "abcdef012345"));
        assert_eq!(defaults.prompt.as_deref(), Some("You are the developer.\nNever push to main."));
        assert_eq!(defaults.allowed_models, vec!["anthropic/claude", "openai-codex/gpt-5.5"]);
        assert_eq!((defaults.approval_patterns[0].pattern.as_str(), defaults.repository_skills.clone()), ("\\bgit push\\b", vec!["triage".to_string()]));
        assert!(!format!("{defaults:?}").contains("PRIVATE"));
        let mut manager = json!({"role": "manager", "setup": {"override": null, "limits": null, "defaults": {}}});
        assert!(role_defaults(&manager).is_some(), "a subset profile still gives what it has");
        manager.as_object_mut().unwrap().remove("role");
        assert_eq!(role_defaults(&manager).unwrap().role, "");
    }

    #[test]
    fn an_unknown_schema_is_not_shown() {
        let mut value = profile();
        value["schema"] = json!(2);
        assert!(setup(&value).is_none());
        assert!(setup(&json!({})).is_none());
    }
}

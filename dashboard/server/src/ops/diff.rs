//! Differences between two revisions, in the shape the UI shows: one entry per changed field, with a line diff for long text.

use fleet_shared::operations::*;
use serde_json::Value;
use std::collections::BTreeSet;

const CONTEXT: usize = 3;
const MAX_LINES: usize = 3000;

/// A line diff of two texts. Lines far from a change are left out and one `…` line marks the gap.
pub fn diff_lines(before: &str, after: &str) -> Vec<DiffLine> {
    let a: Vec<&str> = before.lines().take(MAX_LINES).collect();
    let b: Vec<&str> = after.lines().take(MAX_LINES).collect();
    let prefix = a.iter().zip(&b).take_while(|(x, y)| x == y).count();
    let suffix = a[prefix..].iter().rev().zip(b[prefix..].iter().rev()).take_while(|(x, y)| x == y).count();
    let (middle_a, middle_b) = (&a[prefix..a.len() - suffix], &b[prefix..b.len() - suffix]);
    // longest common subsequence of the middle, by dynamic programming
    let (n, m) = (middle_a.len(), middle_b.len());
    let mut table = vec![0u32; (n + 1) * (m + 1)];
    let at = |i: usize, j: usize| i * (m + 1) + j;
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            table[at(i, j)] = if middle_a[i] == middle_b[j] { table[at(i + 1, j + 1)] + 1 } else { table[at(i + 1, j)].max(table[at(i, j + 1)]) };
        }
    }
    let mut full: Vec<DiffLine> = a[..prefix].iter().map(|line| DiffLine { op: LineOp::Same, text: (*line).into() }).collect();
    let (mut i, mut j) = (0, 0);
    while i < n || j < m {
        if i < n && j < m && middle_a[i] == middle_b[j] {
            full.push(DiffLine { op: LineOp::Same, text: middle_a[i].into() });
            i += 1;
            j += 1;
        } else if j < m && (i == n || table[at(i, j + 1)] >= table[at(i + 1, j)]) {
            full.push(DiffLine { op: LineOp::Add, text: middle_b[j].into() });
            j += 1;
        } else {
            full.push(DiffLine { op: LineOp::Del, text: middle_a[i].into() });
            i += 1;
        }
    }
    full.extend(a[a.len() - suffix..].iter().map(|line| DiffLine { op: LineOp::Same, text: (*line).into() }));
    with_context(full)
}

fn with_context(lines: Vec<DiffLine>) -> Vec<DiffLine> {
    let changed: Vec<usize> = lines.iter().enumerate().filter(|(_, line)| line.op != LineOp::Same).map(|(index, _)| index).collect();
    if changed.is_empty() {
        return Vec::new();
    }
    let keep: BTreeSet<usize> = changed.iter().flat_map(|index| index.saturating_sub(CONTEXT)..(index + CONTEXT + 1).min(lines.len())).collect();
    let mut out = Vec::new();
    let mut previous: Option<usize> = None;
    for index in keep {
        let gap = match previous {
            Some(last) => index > last + 1,
            None => index > 0,
        };
        if gap {
            out.push(DiffLine { op: LineOp::Same, text: "…".into() });
        }
        out.push(lines[index].clone());
        previous = Some(index);
    }
    if previous.is_some_and(|last| last + 1 < lines.len()) {
        out.push(DiffLine { op: LineOp::Same, text: "…".into() });
    }
    out
}

fn kind_of(before: bool, after: bool) -> DiffKind {
    match (before, after) {
        (false, true) => DiffKind::Added,
        (true, false) => DiffKind::Removed,
        _ => DiffKind::Changed,
    }
}

fn text_entry(field: &str, before: Option<&str>, after: Option<&str>) -> Option<DiffEntry> {
    if before == after {
        return None;
    }
    Some(DiffEntry {
        field: field.into(),
        kind: kind_of(before.is_some(), after.is_some()),
        before: before.map(summary),
        after: after.map(summary),
        lines: diff_lines(before.unwrap_or(""), after.unwrap_or("")),
    })
}

fn summary(text: &str) -> String {
    let first: String = text.lines().next().unwrap_or("").chars().take(120).collect();
    if text.lines().count() > 1 || text.chars().count() > 120 { format!("{first}…") } else { first }
}

fn value_entry(field: &str, before: Option<String>, after: Option<String>) -> Option<DiffEntry> {
    if before == after {
        return None;
    }
    Some(DiffEntry { field: field.into(), kind: kind_of(before.is_some(), after.is_some()), before, after, lines: Vec::new() })
}

fn list(items: &[String]) -> Option<String> {
    (!items.is_empty()).then(|| items.join(", "))
}

fn patterns(items: &Option<Vec<ApprovalPatternSetting>>) -> Option<String> {
    items.as_ref().map(|list| if list.is_empty() { "(none: nothing needs approval)".to_string() } else { list.iter().map(|p| format!("{}  # {}", p.pattern, p.reason)).collect::<Vec<_>>().join("\n") })
}

/// What changed in a model choice, one entry per part: `<prefix>.provider`, `<prefix>.modelId` and `<prefix>.effort`. A part that is unset inherits, so setting or clearing it is a change.
fn model_entries(prefix: &str, before: Option<&ModelChoice>, after: Option<&ModelChoice>) -> Vec<DiffEntry> {
    let parts = |choice: Option<&ModelChoice>| [choice.and_then(|m| m.provider.clone()), choice.and_then(|m| m.model_id.clone()), choice.and_then(|m| m.effort).map(|effort| effort.as_str().to_string())];
    let (old, new) = (parts(before), parts(after));
    ["provider", "modelId", "effort"].iter().enumerate().filter_map(|(index, name)| value_entry(&format!("{prefix}.{name}"), old[index].clone(), new[index].clone())).collect()
}

/// What changed in an agent's form from `before` to `after`.
pub fn diff_forms(before: &SetupForm, after: &SetupForm) -> Vec<DiffEntry> {
    let mut out = Vec::new();
    out.extend(text_entry("instructions", before.instructions.as_deref(), after.instructions.as_deref()));
    let global = |form: &SetupForm| form.disable_global_prompt.then(|| "switched off for this agent".to_string());
    out.extend(value_entry("disableGlobalPrompt", global(before), global(after)));
    out.extend(model_entries("model", before.model.as_ref(), after.model.as_ref()));
    out.extend(text_entry("approvalPatterns", patterns(&before.approval_patterns).as_deref(), patterns(&after.approval_patterns).as_deref()));
    let repository = |form: &SetupForm| form.repository_skills.as_ref().map(|names| names.join(", "));
    out.extend(value_entry("repositorySkills", repository(before), repository(after)));
    out.extend(value_entry("librarySkills", list(&before.library_skills), list(&after.library_skills)));
    out.extend(value_entry("mcp", list(&before.mcp), list(&after.mcp)));
    let names: BTreeSet<&String> = before.overlays.keys().chain(after.overlays.keys()).collect();
    for name in names {
        out.extend(text_entry(&format!("overlay:{name}"), before.overlays.get(name).map(String::as_str), after.overlays.get(name).map(String::as_str)));
    }
    out
}

fn shown(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

/// What changed in a catalog entry: one entry per top-level field.
pub fn diff_entries(before: Option<&McpEntry>, after: Option<&McpEntry>) -> Vec<DiffEntry> {
    let to_map = |entry: Option<&McpEntry>| match entry.map(serde_json::to_value) {
        Some(Ok(Value::Object(map))) => map,
        _ => serde_json::Map::new(),
    };
    let (a, b) = (to_map(before), to_map(after));
    let keys: BTreeSet<&String> = a.keys().chain(b.keys()).collect();
    keys.into_iter().filter_map(|key| value_entry(&format!("entry.{key}"), a.get(key).map(shown), b.get(key).map(shown))).collect()
}

/// The content of a library skill from one version to the next.
pub fn diff_content(before: Option<&str>, after: Option<&str>) -> Vec<DiffEntry> {
    text_entry("content", before, after).into_iter().collect()
}

pub fn diff_limits(before: Option<&LimitsValues>, after: &LimitsValues) -> Vec<DiffEntry> {
    let fields = |values: Option<&LimitsValues>| {
        values.map(|v| [("maxTokensCap", v.max_tokens_cap), ("maxMinutesCap", v.max_minutes_cap), ("dailyTokenLimit", v.daily_token_limit), ("budgetRaiseCeiling", v.budget_raise_ceiling)])
    };
    let (a, b) = (fields(before), fields(Some(after)).expect("always present"));
    let mut out: Vec<DiffEntry> = b
        .iter()
        .enumerate()
        .filter_map(|(index, (name, value))| value_entry(&format!("limits.{name}"), a.map(|old| old[index].1.to_string()), Some(value.to_string())))
        .collect();
    out.extend(model_entries("limits.model", before.and_then(|values| values.model.as_ref()), after.model.as_ref()));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn text(lines: &[DiffLine], op: LineOp) -> Vec<&str> {
        lines.iter().filter(|line| line.op == op).map(|line| line.text.as_str()).collect()
    }

    #[test]
    fn a_line_diff_shows_added_and_removed_lines_with_context() {
        let before = (1..=20).map(|n| format!("line {n}")).collect::<Vec<_>>().join("\n");
        let after = before.replace("line 10", "line ten").replace("line 11\n", "line 11\nline 11b\n");
        let lines = diff_lines(&before, &after);
        assert_eq!(text(&lines, LineOp::Del), vec!["line 10"]);
        assert_eq!(text(&lines, LineOp::Add), vec!["line ten", "line 11b"]);
        assert!(lines.iter().any(|line| line.text == "…"), "far lines are left out");
        assert!(!lines.iter().any(|line| line.text == "line 1"));
        assert!(lines.iter().any(|line| line.op == LineOp::Same && line.text == "line 8"), "three lines of context");
    }

    #[test]
    fn equal_texts_have_no_diff() {
        assert!(diff_lines("a\nb", "a\nb").is_empty());
    }

    #[test]
    fn a_form_diff_lists_each_changed_field_once() {
        let before = SetupForm { instructions: Some("one\ntwo".into()), mcp: vec!["docs".into()], ..Default::default() };
        let after = SetupForm {
            instructions: Some("one\nthree".into()),
            mcp: vec!["docs".into(), "files".into()],
            model: Some(ModelChoice { provider: Some("p".into()), model_id: Some("m".into()), effort: Some(Effort::High) }),
            overlays: BTreeMap::from([("review".to_string(), "overlay".to_string())]),
            ..Default::default()
        };
        let diff = diff_forms(&before, &after);
        let fields: Vec<&str> = diff.iter().map(|entry| entry.field.as_str()).collect();
        assert_eq!(fields, vec!["instructions", "model.provider", "model.modelId", "model.effort", "mcp", "overlay:review"]);
        assert_eq!(diff[0].kind, DiffKind::Changed);
        assert_eq!(text(&diff[0].lines, LineOp::Add), vec!["three"]);
        assert_eq!((diff[1].kind, diff[1].after.as_deref()), (DiffKind::Added, Some("p")));
        assert_eq!((diff[2].kind, diff[2].after.as_deref()), (DiffKind::Added, Some("m")));
        assert_eq!((diff[3].kind, diff[3].after.as_deref()), (DiffKind::Added, Some("high")));
        assert_eq!((diff[4].before.as_deref(), diff[4].after.as_deref()), (Some("docs"), Some("docs, files")));
        assert_eq!(diff[5].kind, DiffKind::Added);
        assert!(diff_forms(&after, &after).is_empty());
    }

    fn choice(provider: Option<&str>, model_id: Option<&str>, effort: Option<Effort>) -> Option<ModelChoice> {
        Some(ModelChoice { provider: provider.map(str::to_string), model_id: model_id.map(str::to_string), effort })
    }

    #[test]
    fn the_model_diff_names_the_part_that_changed_and_an_unset_part_is_a_part_too() {
        let form = |model: Option<ModelChoice>| SetupForm { model, ..Default::default() };
        let diff = diff_forms(&form(choice(Some("openai-codex"), Some("gpt-5.5"), None)), &form(choice(Some("openai-codex"), Some("gpt-6.1-sol"), Some(Effort::High))));
        let seen: Vec<(&str, DiffKind, Option<&str>, Option<&str>)> = diff.iter().map(|entry| (entry.field.as_str(), entry.kind, entry.before.as_deref(), entry.after.as_deref())).collect();
        assert_eq!(seen, vec![("model.modelId", DiffKind::Changed, Some("gpt-5.5"), Some("gpt-6.1-sol")), ("model.effort", DiffKind::Added, None, Some("high"))]);
        let cleared = diff_forms(&form(choice(None, None, Some(Effort::Low))), &form(None));
        assert_eq!(cleared.iter().map(|entry| (entry.field.as_str(), entry.kind)).collect::<Vec<_>>(), vec![("model.effort", DiffKind::Removed)]);
        assert!(diff_forms(&form(choice(None, None, Some(Effort::Low))), &form(choice(None, None, Some(Effort::Low)))).is_empty());
    }

    #[test]
    fn the_fleets_model_shows_in_the_limits_diff_under_its_own_names() {
        let base = LimitsValues { max_tokens_cap: 1, max_minutes_cap: 2, daily_token_limit: 3, budget_raise_ceiling: 4, global_prompt: None, model: None };
        let with = LimitsValues { model: choice(Some("openai-codex"), Some("gpt-6.1-sol"), Some(Effort::High)), ..base.clone() };
        let fields: Vec<String> = diff_limits(Some(&base), &with).into_iter().map(|entry| entry.field).collect();
        assert_eq!(fields, vec!["limits.model.provider", "limits.model.modelId", "limits.model.effort"]);
        let first: Vec<String> = diff_limits(None, &with).into_iter().map(|entry| entry.field).collect();
        assert_eq!(first.len(), 7, "the first revision shows the four numbers and the model");
        assert!(diff_limits(Some(&with), &with).is_empty());
    }

    #[test]
    fn removing_the_approval_patterns_is_not_the_same_as_having_none_to_override() {
        let none = SetupForm::default();
        let empty = SetupForm { approval_patterns: Some(vec![]), ..Default::default() };
        let diff = diff_forms(&none, &empty);
        assert_eq!(diff.len(), 1);
        assert_eq!(diff[0].after.as_deref(), Some("(none: nothing needs approval)"));
    }

    #[test]
    fn a_catalog_diff_names_the_fields() {
        let entry = |command: &str, timeout: Option<u64>| McpEntry {
            name: "docs".into(),
            description: None,
            transport: McpTransport::Stdio,
            command: Some(command.into()),
            args: Some(vec!["-y".into()]),
            env: None,
            url: None,
            headers: None,
            secrets: None,
            approval: McpApproval::Ask,
            downloads: None,
            timeout_seconds: timeout,
        };
        let diff = diff_entries(Some(&entry("npx", None)), Some(&entry("uvx", Some(30))));
        let fields: Vec<&str> = diff.iter().map(|d| d.field.as_str()).collect();
        assert_eq!(fields, vec!["entry.command", "entry.timeoutSeconds"]);
        assert_eq!(diff[0].before.as_deref(), Some("npx"));
        assert_eq!(diff_entries(None, Some(&entry("npx", None))).iter().filter(|d| d.kind == DiffKind::Added).count(), 5);
    }

    #[test]
    fn a_limits_diff_lists_the_changed_numbers() {
        let a = LimitsValues { max_tokens_cap: 1, max_minutes_cap: 2, daily_token_limit: 3, budget_raise_ceiling: 4, global_prompt: None, model: None };
        let b = LimitsValues { max_minutes_cap: 20, ..a.clone() };
        let diff = diff_limits(Some(&a), &b);
        assert_eq!(diff.len(), 1);
        assert_eq!((diff[0].field.as_str(), diff[0].before.as_deref(), diff[0].after.as_deref()), ("limits.maxMinutesCap", Some("2"), Some("20")));
        assert_eq!(diff_limits(None, &b).len(), 4);
    }
}

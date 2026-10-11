//! Differences between two revisions as the server computes them: short values as before and after, long text as a line diff.
//! Everything is shown as text.

use dioxus::prelude::*;
use fleet_shared::operations::{DiffEntry, DiffKind, DiffLine, LineOp};

/// What a diff field is called on the page.
pub fn field_label(field: &str) -> String {
    match field {
        "instructions" => "Operator instructions".into(),
        "model" => "Model".into(),
        "approvalPatterns" => "Approval patterns".into(),
        "repositorySkills" => "Repository skills".into(),
        "librarySkills" => "Library skills".into(),
        "mcp" => "MCP servers".into(),
        "content" => "SKILL.md".into(),
        other => {
            if let Some(skill) = other.strip_prefix("overlay:") {
                return format!("Overlay of {skill}");
            }
            if let Some(name) = other.strip_prefix("entry.") {
                return entry_field_label(name);
            }
            if let Some(name) = other.strip_prefix("limits.") {
                return limit_label(name);
            }
            other.to_string()
        }
    }
}

fn entry_field_label(name: &str) -> String {
    match name {
        "name" => "Name".into(),
        "description" => "Description".into(),
        "transport" => "Transport".into(),
        "command" => "Command".into(),
        "args" => "Arguments".into(),
        "env" => "Environment".into(),
        "url" => "URL".into(),
        "headers" => "Headers".into(),
        "secrets" => "Secrets".into(),
        "approval" => "Approval".into(),
        "downloads" => "Downloads".into(),
        "timeoutSeconds" => "Timeout".into(),
        other => format!("Entry {other}"),
    }
}

fn limit_label(name: &str) -> String {
    match name {
        "maxTokensCap" => "Maximum tokens per job".into(),
        "maxMinutesCap" => "Maximum minutes per job".into(),
        "dailyTokenLimit" => "Daily token limit".into(),
        "budgetRaiseCeiling" => "Budget raise ceiling".into(),
        other => other.to_string(),
    }
}

pub fn kind_label(kind: DiffKind) -> &'static str {
    match kind {
        DiffKind::Added => "added",
        DiffKind::Removed => "removed",
        DiffKind::Changed => "changed",
    }
}

/// The marker in front of a line: the diff reads without colour.
pub fn marker(op: LineOp) -> &'static str {
    match op {
        LineOp::Same => "  ",
        LineOp::Add => "+ ",
        LineOp::Del => "- ",
    }
}

fn line_class(op: LineOp) -> &'static str {
    match op {
        LineOp::Same => "diff-line same",
        LineOp::Add => "diff-line add",
        LineOp::Del => "diff-line del",
    }
}

/// `Operator instructions, Model`: the fields a revision changed, for its heading.
pub fn summary(entries: &[DiffEntry]) -> String {
    if entries.is_empty() {
        return "no change".into();
    }
    entries.iter().map(|entry| field_label(&entry.field)).collect::<Vec<_>>().join(", ")
}

pub fn count_lines(lines: &[DiffLine], op: LineOp) -> usize {
    lines.iter().filter(|line| line.op == op).count()
}

fn shown(value: &Option<String>) -> String {
    match value.as_deref() {
        Some("") | None => "(nothing)".into(),
        Some(text) => text.to_string(),
    }
}

#[component]
pub fn DiffView(entries: Vec<DiffEntry>) -> Element {
    if entries.is_empty() {
        return rsx! { p { class: "diff-empty", "No differences." } };
    }
    rsx! {
        div { class: "diff",
            for (index, entry) in entries.into_iter().enumerate() {
                DiffBlock { key: "{index}{entry.field}", entry }
            }
        }
    }
}

#[component]
fn DiffBlock(entry: DiffEntry) -> Element {
    let label = field_label(&entry.field);
    let kind = kind_label(entry.kind);
    let (added, removed) = (count_lines(&entry.lines, LineOp::Add), count_lines(&entry.lines, LineOp::Del));
    let before = shown(&entry.before);
    let after = shown(&entry.after);
    rsx! {
        section { class: "diff-block",
            h5 { "{label}", span { class: "chip {kind}", "{kind}" }, if !entry.lines.is_empty() { small { "+{added} −{removed} lines" } } }
            if entry.lines.is_empty() {
                dl { class: "diff-values",
                    dt { "Before" } dd { class: "del", "{before}" }
                    dt { "After" } dd { class: "add", "{after}" }
                }
            } else {
                div { class: "diff-lines", role: "group", "aria-label": "Line changes in {label}",
                    for (index, line) in entry.lines.iter().enumerate() {
                        div { key: "{index}", class: "{line_class(line.op)}", span { class: "marker", "aria-hidden": "true", "{marker(line.op)}" }, span { class: "sr-only", "{sr_word(line.op)}" }, "{line.text}" }
                    }
                }
            }
        }
    }
}

fn sr_word(op: LineOp) -> &'static str {
    match op {
        LineOp::Same => "",
        LineOp::Add => "added: ",
        LineOp::Del => "removed: ",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(field: &str, kind: DiffKind) -> DiffEntry {
        DiffEntry { field: field.into(), kind, before: None, after: None, lines: vec![] }
    }

    #[test]
    fn fields_are_named_for_people() {
        assert_eq!(field_label("instructions"), "Operator instructions");
        assert_eq!(field_label("approvalPatterns"), "Approval patterns");
        assert_eq!(field_label("overlay:review"), "Overlay of review");
        assert_eq!(field_label("entry.command"), "Command");
        assert_eq!(field_label("entry.timeoutSeconds"), "Timeout");
        assert_eq!(field_label("entry.something"), "Entry something");
        assert_eq!(field_label("limits.dailyTokenLimit"), "Daily token limit");
        assert_eq!(field_label("something.new"), "something.new", "a field this page does not know is shown as the server named it");
    }

    #[test]
    fn a_revision_is_headed_by_what_it_changed() {
        assert_eq!(summary(&[]), "no change");
        assert_eq!(summary(&[entry("instructions", DiffKind::Changed), entry("mcp", DiffKind::Added)]), "Operator instructions, MCP servers");
    }

    #[test]
    fn lines_carry_a_marker_so_colour_is_not_the_only_signal() {
        assert_eq!((marker(LineOp::Add), marker(LineOp::Del), marker(LineOp::Same)), ("+ ", "- ", "  "));
        let lines = vec![DiffLine { op: LineOp::Same, text: "a".into() }, DiffLine { op: LineOp::Del, text: "b".into() }, DiffLine { op: LineOp::Add, text: "c".into() }, DiffLine { op: LineOp::Add, text: "d".into() }];
        assert_eq!((count_lines(&lines, LineOp::Add), count_lines(&lines, LineOp::Del)), (2, 1));
    }

    #[test]
    fn an_empty_side_reads_as_nothing() {
        assert_eq!(shown(&None), "(nothing)");
        assert_eq!(shown(&Some(String::new())), "(nothing)");
        assert_eq!(shown(&Some("<b>x</b>".into())), "<b>x</b>", "markup is text: Dioxus escapes it when it is rendered");
    }
}

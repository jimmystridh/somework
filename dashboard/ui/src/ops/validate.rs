//! The checks the editors make before they send: the same limits as the contract, so a form says what is wrong at once. The server checks
//! again and has the last word (it also compiles the approval patterns and looks for secrets); its messages are shown next to the field.

use fleet_shared::operations::{
    ApprovalPatternSetting, LimitsValues, MAX_APPROVAL_PATTERNS, MAX_INSTRUCTIONS_CHARS, MAX_NOTE_CHARS, MAX_OVERLAY_BYTES, MAX_SKILL_BYTES, McpDownload, McpEntry, McpTransport, SetupForm,
};
use std::collections::BTreeSet;

/// A problem with one field of a form: the field as the server names it (`instructions`, `entry.command`) and what is wrong.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Problem {
    pub field: String,
    pub message: String,
}

fn problem(field: impl Into<String>, message: impl Into<String>) -> Problem {
    Problem { field: field.into(), message: message.into() }
}

/// The length JavaScript's `String.length` gives, which is what the agent's limits count.
pub fn js_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// A counter next to a text field: `1,234 / 16,000`, and whether it is over.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Counter {
    pub used: usize,
    pub max: usize,
}

impl Counter {
    pub fn over(self) -> bool {
        self.used > self.max
    }

    pub fn text(self, unit: &str) -> String {
        format!("{} / {} {unit}", thousands(self.used), thousands(self.max))
    }
}

/// `16000` as `16,000`.
pub fn thousands(value: usize) -> String {
    let digits = value.to_string();
    let mut out = String::new();
    for (index, digit) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index).is_multiple_of(3) {
            out.push(',');
        }
        out.push(digit);
    }
    out
}

pub fn instructions_counter(text: &str) -> Counter {
    Counter { used: js_len(text), max: MAX_INSTRUCTIONS_CHARS }
}

pub fn note_counter(text: &str) -> Counter {
    Counter { used: text.trim().chars().count(), max: MAX_NOTE_CHARS }
}

pub fn overlay_counter(text: &str) -> Counter {
    Counter { used: text.len(), max: MAX_OVERLAY_BYTES }
}

pub fn skill_counter(text: &str) -> Counter {
    Counter { used: text.len(), max: MAX_SKILL_BYTES }
}

fn tail_ok(rest: &str, allowed: impl Fn(char) -> bool, max_tail: usize) -> bool {
    rest.chars().count() <= max_tail && rest.chars().all(allowed)
}

/// `^[a-z0-9][a-z0-9_-]{0,39}$`
pub fn is_mcp_name(name: &str) -> bool {
    let mut chars = name.chars();
    matches!(chars.next(), Some(first) if first.is_ascii_lowercase() || first.is_ascii_digit())
        && tail_ok(chars.as_str(), |c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '_' | '-'), 39)
}

/// `^[a-z0-9][a-z0-9-]{0,63}$`
pub fn is_skill_name(name: &str) -> bool {
    let mut chars = name.chars();
    matches!(chars.next(), Some(first) if first.is_ascii_lowercase() || first.is_ascii_digit()) && tail_ok(chars.as_str(), |c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-', 63)
}

/// `^[A-Z][A-Z0-9_]{0,63}$`
pub fn is_secret_name(name: &str) -> bool {
    let mut chars = name.chars();
    matches!(chars.next(), Some(first) if first.is_ascii_uppercase()) && tail_ok(chars.as_str(), |c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_', 63)
}

pub fn note_problem(note: &str) -> Option<Problem> {
    let counter = note_counter(note);
    counter.over().then(|| problem("note", format!("The note is longer than {MAX_NOTE_CHARS} characters.")))
}

pub fn pattern_problem(pattern: &ApprovalPatternSetting) -> Option<String> {
    if pattern.pattern.is_empty() {
        Some("A pattern cannot be empty.".into())
    } else if js_len(&pattern.pattern) > 300 {
        Some("A pattern is at most 300 characters.".into())
    } else if pattern.reason.trim().is_empty() {
        Some("Say why the command needs approval.".into())
    } else if js_len(&pattern.reason) > 200 {
        Some("A reason is at most 200 characters.".into())
    } else {
        None
    }
}

/// Everything wrong with a setup form that can be seen without the agent or the catalog.
pub fn form_problems(form: &SetupForm) -> Vec<Problem> {
    let mut problems = Vec::new();
    if let Some(text) = &form.instructions
        && instructions_counter(text).over()
    {
        problems.push(problem("instructions", format!("The instructions are longer than {} characters.", thousands(MAX_INSTRUCTIONS_CHARS))));
    }
    if let Some(patterns) = &form.approval_patterns {
        if patterns.len() > MAX_APPROVAL_PATTERNS {
            problems.push(problem("approvalPatterns", format!("At most {MAX_APPROVAL_PATTERNS} approval patterns.")));
        }
        for (index, pattern) in patterns.iter().enumerate() {
            if let Some(message) = pattern_problem(pattern) {
                problems.push(problem(format!("approvalPatterns.{index}"), message));
            }
        }
    }
    for (name, overlay) in &form.overlays {
        if overlay_counter(overlay).over() {
            problems.push(problem(format!("overlays.{name}"), format!("The overlay for {name} is larger than 16 KiB.")));
        }
    }
    problems
}

pub fn skill_problems(name: &str, content: &str, is_new: bool) -> Vec<Problem> {
    let mut problems = Vec::new();
    if is_new && !is_skill_name(name) {
        problems.push(problem("name", "Lowercase letters, digits and -, at most 64 characters, starting with a letter or digit."));
    }
    if content.trim().is_empty() {
        problems.push(problem("content", "The SKILL.md is empty."));
    } else if skill_counter(content).over() {
        problems.push(problem("content", format!("The SKILL.md is larger than {} bytes.", thousands(MAX_SKILL_BYTES))));
    }
    problems
}

/// The `description:` of the front matter of a `SKILL.md`, as the server will read it: a plain or quoted value, or a folded or literal block.
/// Empty when there is none.
pub fn skill_description(content: &str) -> String {
    let mut lines = content.lines();
    if lines.next().map(str::trim_end) != Some("---") {
        return String::new();
    }
    let front: Vec<&str> = lines.take_while(|line| line.trim_end() != "---").collect();
    let Some(position) = front.iter().position(|line| line.starts_with("description:")) else { return String::new() };
    let value = front[position]["description:".len()..].trim();
    let text = if matches!(value.chars().next(), Some('>' | '|')) {
        front[position + 1..].iter().take_while(|line| line.starts_with(' ') || line.starts_with('\t') || line.is_empty()).map(|line| line.trim()).filter(|line| !line.is_empty()).collect::<Vec<_>>().join(" ")
    } else {
        value.strip_prefix('"').and_then(|v| v.strip_suffix('"')).or_else(|| value.strip_prefix('\'').and_then(|v| v.strip_suffix('\''))).unwrap_or(value).to_string()
    };
    text.trim().chars().take(500).collect()
}

/// Every `${NAME}` in a text; `${LOCAL}` is the downloaded executable, not a secret.
pub fn references(text: &str) -> Vec<String> {
    let mut names = Vec::new();
    let mut rest = text;
    while let Some(start) = rest.find("${") {
        let Some(end) = rest[start + 2..].find('}') else { break };
        names.push(rest[start + 2..start + 2 + end].to_string());
        rest = &rest[start + 2 + end + 1..];
    }
    names
}

fn download_problem(os: &str, download: &McpDownload) -> Option<String> {
    if !matches!(os, "linux" | "windows" | "darwin") {
        return Some(format!("{os} is not linux, windows or darwin."));
    }
    if download.url.is_empty() || !download.url.starts_with("https://") {
        return Some(format!("The {os} download needs an https address."));
    }
    if download.sha256.len() != 64 || !download.sha256.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f')) {
        return Some(format!("The {os} download needs a SHA-256: 64 lowercase hex characters."));
    }
    if download.executable.is_empty() || download.executable.starts_with('/') || download.executable.contains("..") {
        return Some(format!("The {os} executable is a path inside the download, never absolute and never with .."));
    }
    None
}

/// The rules of a catalog entry that need no knowledge of what looks like a token.
pub fn entry_problems(entry: &McpEntry, is_new: bool) -> Vec<Problem> {
    let mut problems = Vec::new();
    if is_new && !is_mcp_name(&entry.name) {
        problems.push(problem("entry.name", "Lowercase letters, digits, - and _, at most 40 characters, starting with a letter or digit."));
    }
    if entry.description.as_deref().is_some_and(|text| js_len(text) > 300) {
        problems.push(problem("entry.description", "The description is at most 300 characters."));
    }
    let mut used: BTreeSet<String> = BTreeSet::new();
    let mut scan = |text: &str, allow_local: bool| {
        for name in references(text) {
            if !(allow_local && name == "LOCAL") {
                used.insert(name);
            }
        }
    };
    match entry.transport {
        McpTransport::Stdio => {
            match entry.command.as_deref().filter(|command| !command.is_empty()) {
                None => problems.push(problem("entry.command", "A stdio server needs a command, or ${LOCAL} for the downloaded executable.")),
                Some(command) => scan(command, true),
            }
            for arg in entry.args.iter().flatten() {
                scan(arg, true);
            }
        }
        McpTransport::Http => match entry.url.as_deref().filter(|url| url.starts_with("http://") || url.starts_with("https://")) {
            None => problems.push(problem("entry.url", "An http server needs an address starting with http:// or https://.")),
            Some(url) => scan(url, false),
        },
    }
    for map in [&entry.env, &entry.headers].into_iter().flatten() {
        for value in map.values() {
            scan(value, false);
        }
    }
    let declared: BTreeSet<&String> = entry.secrets.iter().flatten().collect();
    for secret in entry.secrets.iter().flatten() {
        if !is_secret_name(secret) {
            problems.push(problem("entry.secrets", format!("{secret} is not a secret name: capital letters, digits and _, starting with a letter.")));
        }
    }
    for name in &used {
        if !declared.contains(name) {
            problems.push(problem("entry.secrets", format!("${{{name}}} is used but {name} is not listed under secrets.")));
        }
    }
    for (os, download) in entry.downloads.iter().flatten() {
        if let Some(message) = download_problem(os, download) {
            problems.push(problem(format!("entry.downloads.{os}"), message));
        }
    }
    let uses_local = entry.command.as_deref().is_some_and(|command| command.contains("${LOCAL}")) || entry.args.iter().flatten().any(|arg| arg.contains("${LOCAL}"));
    if uses_local && entry.downloads.as_ref().is_none_or(|downloads| downloads.is_empty()) {
        problems.push(problem("entry.downloads", "${LOCAL} needs a download for at least one operating system."));
    }
    if entry.timeout_seconds == Some(0) {
        problems.push(problem("entry.timeoutSeconds", "The timeout is a positive number of seconds."));
    }
    problems
}

/// A positive whole number typed into a form.
pub fn parse_positive(text: &str) -> Result<u64, String> {
    match text.trim().replace([',', ' '], "").parse::<u64>() {
        Ok(0) => Err("Must be greater than zero.".into()),
        Ok(value) if value > 9_007_199_254_740_991 => Err("Too large.".into()),
        Ok(value) => Ok(value),
        Err(_) => Err("Must be a whole number.".into()),
    }
}

/// The four fleet limits as typed; the problems are by field name as the server names them (`values.maxTokensCap`).
pub fn limits_from_text(texts: [&str; 4]) -> Result<LimitsValues, Vec<Problem>> {
    let names = ["values.maxTokensCap", "values.maxMinutesCap", "values.dailyTokenLimit", "values.budgetRaiseCeiling"];
    let parsed: Vec<Result<u64, String>> = texts.iter().map(|text| parse_positive(text)).collect();
    let problems: Vec<Problem> = parsed.iter().zip(names).filter_map(|(result, name)| result.as_ref().err().map(|message| problem(name, message.clone()))).collect();
    if !problems.is_empty() {
        return Err(problems);
    }
    let value = |index: usize| *parsed[index].as_ref().expect("checked above");
    Ok(LimitsValues { max_tokens_cap: value(0), max_minutes_cap: value(1), daily_token_limit: value(2), budget_raise_ceiling: value(3) })
}

/// The message for a field (or anything under it) out of a list of problems.
pub fn message_for<'a>(problems: &'a [Problem], field: &str) -> Option<&'a str> {
    problems.iter().find(|problem| problem.field == field || problem.field.strip_prefix(field).is_some_and(|rest| rest.starts_with('.'))).map(|problem| problem.message.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;
    use fleet_shared::operations::{ArchiveKind, McpApproval};
    use std::collections::BTreeMap;

    fn stdio() -> McpEntry {
        McpEntry {
            name: "docs".into(),
            description: None,
            transport: McpTransport::Stdio,
            command: Some("npx".into()),
            args: None,
            env: None,
            url: None,
            headers: None,
            secrets: None,
            approval: McpApproval::Ask,
            downloads: None,
            timeout_seconds: None,
        }
    }

    fn download() -> McpDownload {
        McpDownload { url: "https://example.com/x.tgz".into(), sha256: "a".repeat(64), archive: ArchiveKind::TarGz, executable: "bin/x".into() }
    }

    fn fields(problems: &[Problem]) -> Vec<&str> {
        problems.iter().map(|problem| problem.field.as_str()).collect()
    }

    #[test]
    fn instructions_are_counted_the_way_the_agent_counts_them() {
        assert_eq!(instructions_counter("abc").used, 3);
        assert_eq!(instructions_counter("😀").used, 2, "two UTF-16 units, as JavaScript counts");
        assert!(!instructions_counter(&"a".repeat(16_000)).over());
        assert!(instructions_counter(&"a".repeat(16_001)).over());
        assert_eq!(instructions_counter("x").text("characters"), "1 / 16,000 characters");
    }

    #[test]
    fn thousands_are_grouped() {
        assert_eq!((thousands(0), thousands(999), thousands(1000), thousands(65_536), thousands(2_097_152)), ("0".to_string(), "999".to_string(), "1,000".to_string(), "65,536".to_string(), "2,097,152".to_string()));
    }

    #[test]
    fn names_follow_the_contracts_alphabets() {
        assert!(is_mcp_name("docs") && is_mcp_name("a_b-c9") && is_mcp_name(&"a".repeat(40)));
        assert!(!is_mcp_name("") && !is_mcp_name("Docs") && !is_mcp_name("_x") && !is_mcp_name(&"a".repeat(41)));
        assert!(is_skill_name("review-pr") && !is_skill_name("review_pr") && !is_skill_name("-x"));
        assert!(is_secret_name("GITHUB_TOKEN") && !is_secret_name("github_token") && !is_secret_name("1TOKEN"));
    }

    #[test]
    fn a_form_is_checked_for_length_and_count() {
        let mut form = SetupForm { instructions: Some("a".repeat(16_001)), ..Default::default() };
        form.approval_patterns = Some(vec![ApprovalPatternSetting { pattern: String::new(), reason: "x".into() }, ApprovalPatternSetting { pattern: "rm ".into(), reason: " ".into() }, ApprovalPatternSetting { pattern: "ok".into(), reason: "fine".into() }]);
        form.overlays = BTreeMap::from([("review".to_string(), "x".repeat(16 * 1024 + 1))]);
        let problems = form_problems(&form);
        assert_eq!(fields(&problems), ["instructions", "approvalPatterns.0", "approvalPatterns.1", "overlays.review"]);
        assert_eq!(message_for(&problems, "approvalPatterns"), Some("A pattern cannot be empty."), "a field also finds the problems under it");
        assert_eq!(message_for(&problems, "approvalPattern"), None, "but not a field that merely starts with the same letters");
        assert!(form_problems(&SetupForm::default()).is_empty());
    }

    #[test]
    fn a_note_is_cut_at_five_hundred_characters() {
        assert!(note_problem(&"n".repeat(500)).is_none());
        assert_eq!(note_problem(&"n".repeat(501)).map(|p| p.field), Some("note".to_string()));
    }

    #[test]
    fn a_stdio_entry_needs_a_command_and_an_http_entry_an_address() {
        assert!(entry_problems(&stdio(), true).is_empty());
        let mut no_command = stdio();
        no_command.command = None;
        assert_eq!(fields(&entry_problems(&no_command, true)), ["entry.command"]);
        let http = McpEntry { transport: McpTransport::Http, command: None, url: Some("ftp://x".into()), ..stdio() };
        assert_eq!(fields(&entry_problems(&http, true)), ["entry.url"]);
        let ok = McpEntry { url: Some("https://mcp.example.com/sse".into()), ..http };
        assert!(entry_problems(&ok, true).is_empty());
    }

    #[test]
    fn every_secret_the_entry_uses_must_be_listed_and_named_properly() {
        let mut entry = stdio();
        entry.env = Some(BTreeMap::from([("API_TOKEN".to_string(), "${DOCS_TOKEN}".to_string())]));
        entry.args = Some(vec!["--key=${OTHER_KEY}".into()]);
        let problems = entry_problems(&entry, true);
        assert_eq!(problems.len(), 2);
        assert!(problems[0].message.contains("DOCS_TOKEN") && problems[1].message.contains("OTHER_KEY"));
        entry.secrets = Some(vec!["DOCS_TOKEN".into(), "OTHER_KEY".into()]);
        assert!(entry_problems(&entry, true).is_empty());
        entry.secrets = Some(vec!["DOCS_TOKEN".into(), "OTHER_KEY".into(), "lower".into()]);
        assert!(entry_problems(&entry, true)[0].message.contains("lower"));
    }

    #[test]
    fn local_is_a_download_not_a_secret_and_needs_one() {
        let mut entry = McpEntry { command: Some("${LOCAL}".into()), ..stdio() };
        assert_eq!(fields(&entry_problems(&entry, true)), ["entry.downloads"]);
        entry.downloads = Some(BTreeMap::from([("linux".to_string(), download())]));
        assert!(entry_problems(&entry, true).is_empty(), "${{LOCAL}} must not be asked for under secrets");
    }

    #[test]
    fn a_download_is_https_checksummed_and_stays_in_its_folder() {
        let bad = |change: fn(&mut McpDownload)| {
            let mut value = download();
            change(&mut value);
            download_problem("linux", &value)
        };
        assert_eq!(bad(|_| {}), None);
        assert!(bad(|d| d.url = "http://example.com/x".into()).is_some());
        assert!(bad(|d| d.sha256 = "A".repeat(64)).is_some(), "lowercase only");
        assert!(bad(|d| d.sha256 = "a".repeat(63)).is_some());
        assert!(bad(|d| d.executable = "/usr/bin/x".into()).is_some());
        assert!(bad(|d| d.executable = "../x".into()).is_some());
        assert!(download_problem("freebsd", &download()).is_some());
    }

    #[test]
    fn a_timeout_of_zero_is_refused() {
        let entry = McpEntry { timeout_seconds: Some(0), ..stdio() };
        assert_eq!(fields(&entry_problems(&entry, true)), ["entry.timeoutSeconds"]);
    }

    #[test]
    fn an_existing_entry_keeps_its_name_unchecked() {
        let entry = McpEntry { name: "Legacy Name".into(), ..stdio() };
        assert!(entry_problems(&entry, false).is_empty());
        assert_eq!(fields(&entry_problems(&entry, true)), ["entry.name"]);
    }

    #[test]
    fn a_skill_needs_a_name_and_content_within_64_kib() {
        assert!(skill_problems("review-pr", "---\nname: x\n---\nbody", true).is_empty());
        assert_eq!(fields(&skill_problems("Bad Name", " ", true)), ["name", "content"]);
        assert_eq!(fields(&skill_problems("ok", &"x".repeat(65_537), false)), ["content"]);
    }

    #[test]
    fn the_description_comes_from_the_front_matter_in_its_three_forms() {
        assert_eq!(skill_description("---\nname: x\ndescription: Review a pull request\n---\nBody"), "Review a pull request");
        assert_eq!(skill_description("---\ndescription: \"Quoted, with: colon\"\n---\n"), "Quoted, with: colon");
        assert_eq!(skill_description("---\ndescription: >\n  Folded text\n  on two lines\nname: x\n---\n"), "Folded text on two lines");
        assert_eq!(skill_description("No front matter\ndescription: not this"), "");
        assert_eq!(skill_description("---\nname: x\n---\n"), "");
    }

    #[test]
    fn limits_are_positive_whole_numbers() {
        assert_eq!(parse_positive(" 1,000 "), Ok(1000));
        assert!(parse_positive("0").is_err() && parse_positive("-3").is_err() && parse_positive("1.5").is_err() && parse_positive("").is_err());
        let values = limits_from_text(["100", "30", "5000000", "200000"]).unwrap();
        assert_eq!((values.max_tokens_cap, values.max_minutes_cap, values.daily_token_limit, values.budget_raise_ceiling), (100, 30, 5_000_000, 200_000));
        let problems = limits_from_text(["100", "x", "5", "0"]).unwrap_err();
        assert_eq!(fields(&problems), ["values.maxMinutesCap", "values.budgetRaiseCeiling"]);
    }

    #[test]
    fn references_are_found_in_order_and_an_open_one_is_ignored() {
        assert_eq!(references("a ${ONE} b ${TWO}"), ["ONE", "TWO"]);
        assert!(references("a ${OPEN").is_empty());
    }
}

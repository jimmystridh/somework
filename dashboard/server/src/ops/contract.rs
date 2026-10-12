//! The rules of `packages/agent-kit/src/setup/contract.ts`, ported with the same limits, plus the rules that only Operations enforces
//! (https-only downloads, no secret values in a catalog entry or a skill, every `${SECRET}` listed). Everything here is pure.
//!
//! A message of the contract that the agent would refuse must be refused here first, at save time, with a reason an operator can read:
//! a rejected document leaves the agent on its previous setup and the operator waiting for nothing.

use fleet_shared::operations::*;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

/// A broken rule: what is wrong in words an operator can read, and the field it is about.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Invalid {
    pub message: String,
    pub field: Option<String>,
}

pub type Check<T> = Result<T, Invalid>;

pub fn invalid<T>(field: &str, message: impl Into<String>) -> Check<T> {
    Err(Invalid { message: message.into(), field: (!field.is_empty()).then(|| field.to_string()) })
}

pub fn sha256_hex(data: &[u8]) -> String {
    Sha256::digest(data).iter().map(|byte| format!("{byte:02x}")).collect()
}

/// The length JavaScript's `String.length` gives, which is what the agent's limits count.
pub fn js_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// Text cut to what the contract allows, for places where cutting is better than refusing (our own notes).
pub fn cut(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

const JS_INTEGER_MAX: u64 = 9_007_199_254_740_991;

// ---------------------------------------------------------------------------------------------------------------- names

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
    matches!(chars.next(), Some(first) if first.is_ascii_lowercase() || first.is_ascii_digit())
        && tail_ok(chars.as_str(), |c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-', 63)
}

/// `^[A-Z][A-Z0-9_]{0,63}$`
pub fn is_secret_name(name: &str) -> bool {
    let mut chars = name.chars();
    matches!(chars.next(), Some(first) if first.is_ascii_uppercase()) && tail_ok(chars.as_str(), |c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_', 63)
}

// ----------------------------------------------------------------------------------------------------- secret detection

/// Every `${NAME}` in a text, and the text with them removed. A `${` without a closing brace is returned as a malformed reference.
fn references(text: &str) -> (Vec<String>, String, bool) {
    let mut names = Vec::new();
    let mut rest = String::new();
    let mut malformed = false;
    let mut remaining = text;
    while let Some(start) = remaining.find("${") {
        rest.push_str(&remaining[..start]);
        match remaining[start + 2..].find('}') {
            Some(end) => {
                names.push(remaining[start + 2..start + 2 + end].to_string());
                remaining = &remaining[start + 2 + end + 1..];
            }
            None => {
                malformed = true;
                remaining = "";
            }
        }
    }
    rest.push_str(remaining);
    (names, rest, malformed)
}

fn has_run(text: &str, prefix: &str, min_tail: usize, tail: impl Fn(char) -> bool) -> bool {
    text.match_indices(prefix).any(|(at, _)| text[at + prefix.len()..].chars().take_while(|c| tail(*c)).count() >= min_tail)
}

/// Tokens whose shape is unmistakable: a provider's prefix followed by enough characters, a JWT, a PEM key. Used for free text too, where
/// the generic check below would flag ordinary prose and code.
pub fn contains_known_secret(text: &str) -> bool {
    let word = |c: char| c.is_ascii_alphanumeric() || matches!(c, '_' | '-');
    ["ghp_", "gho_", "ghu_", "ghs_", "ghr_"].iter().any(|prefix| has_run(text, prefix, 30, word))
        || has_run(text, "github_pat_", 30, word)
        || has_run(text, "glpat-", 16, word)
        || ["xoxb-", "xoxp-", "xoxa-", "xoxr-", "xoxs-", "xapp-"].iter().any(|prefix| has_run(text, prefix, 16, word))
        || has_run(text, "sk-", 20, word)
        || has_run(text, "sk_live_", 16, word)
        || has_run(text, "rk_live_", 16, word)
        || has_run(text, "npm_", 30, word)
        || has_run(text, "AKIA", 16, |c| c.is_ascii_uppercase() || c.is_ascii_digit())
        || has_run(text, "ASIA", 16, |c| c.is_ascii_uppercase() || c.is_ascii_digit())
        || has_run(text, "AIza", 30, word)
        || has_run(text, "ya29.", 30, |c| word(c) || c == '.')
        || text.contains("-----BEGIN") && text.contains("PRIVATE KEY")
        || looks_like_jwt(text)
        || has_run(text, "Bearer ", 24, |c| word(c) || matches!(c, '.' | '+' | '/' | '='))
}

fn looks_like_jwt(text: &str) -> bool {
    text.match_indices("eyJ").any(|(at, _)| {
        let token: String = text[at..].chars().take_while(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.')).collect();
        token.matches('.').count() >= 2 && token.len() >= 30
    })
}

/// A long unbroken run of key characters mixing letters and digits: what an API key looks like even when its provider is unknown.
fn has_key_shaped_run(text: &str) -> bool {
    let mut run = String::new();
    let check = |run: &str| run.len() >= 32 && run.chars().any(|c| c.is_ascii_digit()) && run.chars().any(|c| c.is_ascii_alphabetic());
    for c in text.chars() {
        if c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '+' | '=') {
            run.push(c);
        } else {
            if check(&run) {
                return true;
            }
            run.clear();
        }
    }
    check(&run)
}

/// `scheme://user:password@host`
fn has_url_credentials(text: &str) -> bool {
    text.match_indices("://").any(|(at, _)| {
        let authority: String = text[at + 3..].chars().take_while(|c| !matches!(c, '/' | '?' | '#') && !c.is_whitespace()).collect();
        authority.contains('@')
    })
}

const SECRET_QUERY_KEYS: [&str; 12] = ["token", "access_token", "api_key", "apikey", "key", "secret", "password", "passwd", "auth", "signature", "sig", "code"];

fn has_secret_query(text: &str) -> bool {
    let Some((_, query)) = text.split_once('?') else { return false };
    query.split(['&', ';']).any(|pair| {
        let Some((key, value)) = pair.split_once('=') else { return false };
        let (_, rest, _) = references(value);
        SECRET_QUERY_KEYS.contains(&key.to_ascii_lowercase().as_str()) && !rest.is_empty()
    })
}

fn sensitive_name(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();
    ["KEY", "TOKEN", "SECRET", "PASSWORD", "PASSWD", "CREDENTIAL", "PRIVATE"].iter().any(|word| upper.contains(word))
        || matches!(upper.as_str(), "AUTHORIZATION" | "PROXY-AUTHORIZATION" | "COOKIE" | "X-API-KEY" | "API-KEY" | "X-AUTH-TOKEN")
}

/// A value that may stand where a secret goes: only references, plus at most an authentication scheme word.
fn only_references(value: &str) -> bool {
    let (names, rest, _) = references(value);
    !names.is_empty() && matches!(rest.trim(), "" | "Bearer" | "Basic" | "Token" | "token" | "bearer")
}

/// Why a literal in a catalog entry must not be stored, in words that do not repeat the value.
fn literal_problem(value: &str) -> Option<&'static str> {
    let (_, rest, _) = references(value);
    if contains_known_secret(&rest) || has_key_shaped_run(&rest) {
        Some("looks like a token or key")
    } else if has_url_credentials(&rest) {
        Some("holds credentials in an address")
    } else if has_secret_query(value) {
        Some("holds a credential in the query of an address")
    } else {
        None
    }
}

// --------------------------------------------------------------------------------------------------------- MCP entries

fn check_download(os: &str, download: &McpDownload) -> Check<()> {
    let field = format!("entry.downloads.{os}");
    if !matches!(os, "linux" | "windows" | "darwin") {
        return invalid(&field, format!("the download for {os} names an operating system other than linux, windows or darwin"));
    }
    if download.url.is_empty() || js_len(&download.url) > 1000 || !download.url.starts_with("https://") {
        return invalid(&field, format!("the download for {os} needs an https url"));
    }
    if has_url_credentials(&download.url) || has_secret_query(&download.url) {
        return invalid(&field, format!("the download for {os} must not carry credentials in its address"));
    }
    if download.sha256.len() != 64 || !download.sha256.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f')) {
        return invalid(&field, format!("the download for {os} needs a SHA-256 (64 lowercase hex characters)"));
    }
    let executable = &download.executable;
    if executable.is_empty() || js_len(executable) > 300 || executable.starts_with('/') || executable.contains("..") {
        return invalid(&field, format!("the download for {os} names an executable outside its folder"));
    }
    Ok(())
}

fn check_map(name: &str, kind: &str, map: &BTreeMap<String, String>, header: bool) -> Check<()> {
    let field = format!("entry.{kind}");
    if map.len() > 50 {
        return invalid(&field, format!("the MCP entry {name} has more than 50 {kind} values"));
    }
    for (key, value) in map {
        let key_ok = !key.is_empty() && key.len() <= 100 && if header { key.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') } else { key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') };
        if !key_ok {
            return invalid(&format!("{field}.{key}"), format!("the MCP entry {name} has a {kind} name that is not allowed"));
        }
        if js_len(value) > 2000 {
            return invalid(&format!("{field}.{key}"), format!("the MCP entry {name} has invalid {kind}"));
        }
        if sensitive_name(key) {
            if !only_references(value) {
                return invalid(&format!("{field}.{key}"), format!("{key} looks like it holds a secret: write a reference such as ${{SECRET_NAME}} and list the secret in secrets, never the value"));
            }
        } else if let Some(problem) = literal_problem(value) {
            return invalid(&format!("{field}.{key}"), format!("the value of {key} {problem}: write a reference such as ${{SECRET_NAME}} and list the secret in secrets"));
        }
    }
    Ok(())
}

/// Drops what the agent would not read for the entry's transport, so the stored entry is what an agent sees.
pub fn normalize_entry(mut entry: McpEntry) -> McpEntry {
    match entry.transport {
        McpTransport::Stdio => entry.url = None,
        McpTransport::Http => {
            entry.command = None;
            entry.args = None;
        }
    }
    entry.description = entry.description.map(|text| text.trim().to_string()).filter(|text| !text.is_empty());
    for map in [&mut entry.env, &mut entry.headers, ] {
        if map.as_ref().is_some_and(|values| values.is_empty()) {
            *map = None;
        }
    }
    if entry.secrets.as_ref().is_some_and(Vec::is_empty) {
        entry.secrets = None;
    }
    if entry.downloads.as_ref().is_some_and(BTreeMap::is_empty) {
        entry.downloads = None;
    }
    if let Some(secrets) = &mut entry.secrets {
        secrets.sort();
        secrets.dedup();
    }
    entry
}

/// Checks an MCP entry as `validateMcp` of the contract does, then the rules of Operations. Returns the entry as it will be stored and sent.
pub fn check_mcp(entry: McpEntry) -> Check<McpEntry> {
    let entry = normalize_entry(entry);
    let name = entry.name.clone();
    if !is_mcp_name(&name) {
        return invalid("entry.name", "an MCP entry has an invalid name (lowercase letters, digits, - and _, at most 40 characters, starting with a letter or digit)");
    }
    if let Some(description) = &entry.description {
        if js_len(description) > 300 {
            return invalid("entry.description", format!("the MCP entry {name} has a long description (at most 300 characters)"));
        }
        if contains_known_secret(description) {
            return invalid("entry.description", format!("the description of {name} looks like it holds a token or key"));
        }
    }
    let mut referenced: BTreeSet<String> = BTreeSet::new();
    let mut scan = |field: &str, text: &str, allow_local: bool| -> Check<()> {
        let (names, _, malformed) = references(text);
        if malformed {
            return invalid(field, format!("the MCP entry {name} has a ${{ without a closing brace"));
        }
        for reference in names {
            if allow_local && reference == "LOCAL" {
                continue;
            }
            if !is_secret_name(&reference) {
                return invalid(field, format!("the MCP entry {name} uses a reference that is not a secret name: ${{{}}}", cut(&reference, 40)));
            }
            referenced.insert(reference);
        }
        Ok(())
    };
    match entry.transport {
        McpTransport::Stdio => {
            let Some(command) = entry.command.as_deref().filter(|command| !command.is_empty() && js_len(command) <= 300) else {
                return invalid("entry.command", format!("the MCP entry {name} needs a command (at most 300 characters)"));
            };
            scan("entry.command", command, true)?;
            if let Some(problem) = literal_problem(command) {
                return invalid("entry.command", format!("the command of {name} {problem}"));
            }
            if let Some(args) = &entry.args {
                if args.len() > 100 || args.iter().any(|arg| js_len(arg) > 500) {
                    return invalid("entry.args", format!("the MCP entry {name} has invalid arguments (at most 100, each at most 500 characters)"));
                }
                for (index, arg) in args.iter().enumerate() {
                    let field = format!("entry.args.{index}");
                    scan(&field, arg, true)?;
                    if let Some(problem) = literal_problem(arg) {
                        return invalid(&field, format!("argument {} of {name} {problem}: pass it as an environment value with a ${{SECRET_NAME}} reference", index + 1));
                    }
                }
            }
        }
        McpTransport::Http => {
            let Some(url) = entry.url.as_deref().filter(|url| js_len(url) <= 1000 && (url.starts_with("http://") || url.starts_with("https://"))) else {
                return invalid("entry.url", format!("the MCP entry {name} needs an http(s) url (at most 1000 characters)"));
            };
            scan("entry.url", url, false)?;
            if has_url_credentials(url) || has_secret_query(url) {
                return invalid("entry.url", format!("the address of {name} must not carry credentials: use a header with a ${{SECRET_NAME}} reference"));
            }
        }
    }
    for (kind, map, header) in [("env", &entry.env, false), ("headers", &entry.headers, true)] {
        if let Some(map) = map {
            check_map(&name, kind, map, header)?;
            for (key, value) in map {
                scan(&format!("entry.{kind}.{key}"), value, false)?;
            }
        }
    }
    let declared: BTreeSet<&String> = entry.secrets.iter().flatten().collect();
    if let Some(secrets) = &entry.secrets
        && (secrets.len() > 50 || secrets.iter().any(|secret| js_len(secret) > 500 || !is_secret_name(secret)))
    {
        return invalid("entry.secrets", format!("the MCP entry {name} names an invalid secret (capital letters, digits and _, starting with a letter)"));
    }
    if let Some(missing) = referenced.iter().find(|reference| !declared.contains(reference)) {
        return invalid("entry.secrets", format!("the MCP entry {name} uses ${{{missing}}} but does not list {missing} in secrets"));
    }
    let uses_local = entry.command.as_deref().is_some_and(|command| command.contains("${LOCAL}")) || entry.args.iter().flatten().any(|arg| arg.contains("${LOCAL}"));
    match &entry.downloads {
        Some(downloads) => {
            for (os, download) in downloads {
                check_download(os, download)?;
            }
        }
        None if uses_local => return invalid("entry.downloads", format!("the MCP entry {name} runs ${{LOCAL}} but has no download for any operating system")),
        None => {}
    }
    if entry.timeout_seconds.is_some_and(|seconds| seconds == 0 || seconds > JS_INTEGER_MAX) {
        return invalid("entry.timeoutSeconds", format!("the MCP entry {name} has an invalid timeout"));
    }
    Ok(entry)
}

// -------------------------------------------------------------------------------------------------------- library skills

/// The `description:` of the front matter of a `SKILL.md`: a plain or quoted value, or a folded or literal block. Empty when there is none.
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
        let unquoted = value.strip_prefix('"').and_then(|v| v.strip_suffix('"')).or_else(|| value.strip_prefix('\'').and_then(|v| v.strip_suffix('\''))).unwrap_or(value);
        unquoted.to_string()
    };
    cut(text.trim(), 500)
}

/// What a library skill is made of: the validated `SKILL.md` and what the server computes from it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CheckedSkill {
    pub content: String,
    pub description: String,
    pub sha256: String,
    pub size_bytes: u64,
}

pub fn check_skill(name: &str, content: &str) -> Check<CheckedSkill> {
    if !is_skill_name(name) {
        return invalid("name", "a library skill has an invalid name (lowercase letters, digits and -, at most 64 characters, starting with a letter or digit)");
    }
    if content.trim().is_empty() {
        return invalid("content", format!("the library skill {name} is empty"));
    }
    if content.len() > MAX_SKILL_BYTES {
        return invalid("content", format!("the library skill {name} is larger than {MAX_SKILL_BYTES} bytes"));
    }
    if content.contains('\0') {
        return invalid("content", format!("the library skill {name} holds a NUL character"));
    }
    if contains_known_secret(content) {
        return invalid("content", format!("the library skill {name} looks like it holds a token or key: skills are sent to every agent that uses them"));
    }
    Ok(CheckedSkill { content: content.to_string(), description: skill_description(content), sha256: sha256_hex(content.as_bytes()), size_bytes: content.len() as u64 })
}

// ----------------------------------------------------------------------------------------------------------------- form

/// What exists in Operations now: the names a form may enable.
#[derive(Clone, Debug, Default)]
pub struct Known {
    pub library: BTreeSet<String>,
    pub catalog: BTreeSet<String>,
}

pub fn check_pattern(pattern: &ApprovalPatternSetting) -> Check<()> {
    if pattern.pattern.is_empty() || js_len(&pattern.pattern) > 300 || pattern.reason.trim().is_empty() || js_len(&pattern.reason) > 200 {
        return invalid("approvalPatterns", "an approval pattern needs a pattern (at most 300 characters) and a reason (at most 200)");
    }
    if fancy_regex::Regex::new(&pattern.pattern).is_err() {
        return invalid("approvalPatterns", format!("the approval pattern {} is not a regular expression", cut(&pattern.pattern, 60)));
    }
    Ok(())
}

pub fn check_note(note: Option<&str>) -> Check<String> {
    let note = note.map(str::trim).unwrap_or_default();
    if note.chars().count() > MAX_NOTE_CHARS {
        return invalid("note", format!("the note is longer than {MAX_NOTE_CHARS} characters"));
    }
    Ok(note.chars().filter(|c| !c.is_control() || *c == '\n').collect())
}

fn sorted_unique(names: &[String]) -> Vec<String> {
    names.iter().cloned().collect::<BTreeSet<_>>().into_iter().collect()
}

/// Checks a form as the agent would check the document made from it, and that every name it enables exists. Returns the form in its
/// canonical shape (names sorted and unique, empty text gone), which is what is stored and compared.
pub fn check_form(form: &SetupForm, known: &Known) -> Check<SetupForm> {
    let mut out = SetupForm::default();
    if let Some(text) = form.instructions.as_deref().filter(|text| !text.trim().is_empty()) {
        if js_len(text) > MAX_INSTRUCTIONS_CHARS {
            return invalid("instructions", format!("the instructions are longer than {MAX_INSTRUCTIONS_CHARS} characters"));
        }
        if contains_known_secret(text) {
            return invalid("instructions", "the instructions look like they hold a token or key; instructions are sent to the agent and shown in Operations");
        }
        out.instructions = Some(text.trim_end().to_string());
    }
    out.disable_global_prompt = form.disable_global_prompt;
    if let Some(model) = &form.model {
        out.model = Some(model.checked().or_else(|message| invalid("model", message))?);
    }
    if let Some(patterns) = &form.approval_patterns {
        if patterns.len() > MAX_APPROVAL_PATTERNS {
            return invalid("approvalPatterns", format!("approvalPatterns is not a list of at most {MAX_APPROVAL_PATTERNS}"));
        }
        for pattern in patterns {
            check_pattern(pattern)?;
        }
        out.approval_patterns = Some(patterns.iter().map(|p| ApprovalPatternSetting { pattern: p.pattern.clone(), reason: p.reason.trim().to_string() }).collect());
    }
    if let Some(names) = &form.repository_skills {
        if names.len() > 200 || names.iter().any(|name| !is_skill_name(name)) {
            return invalid("repositorySkills", "skills.repository names an invalid skill");
        }
        out.repository_skills = Some(sorted_unique(names));
    }
    if form.library_skills.len() > MAX_LIBRARY_SKILLS {
        return invalid("librarySkills", format!("skills.library is not a list of at most {MAX_LIBRARY_SKILLS}"));
    }
    for name in &form.library_skills {
        if !is_skill_name(name) {
            return invalid("librarySkills", "a library skill has an invalid name");
        }
        if !known.library.contains(name) {
            return invalid("librarySkills", format!("the library skill {name} does not exist"));
        }
    }
    out.library_skills = sorted_unique(&form.library_skills);
    for (name, overlay) in &form.overlays {
        if !is_skill_name(name) || overlay.len() > MAX_OVERLAY_BYTES {
            return invalid(&format!("overlays.{name}"), format!("the overlay for {name} is invalid or larger than 16 KiB"));
        }
        if contains_known_secret(overlay) {
            return invalid(&format!("overlays.{name}"), format!("the overlay for {name} looks like it holds a token or key"));
        }
        if !overlay.trim().is_empty() {
            out.overlays.insert(name.clone(), overlay.clone());
        }
    }
    if form.mcp.len() > MAX_MCP_ENTRIES {
        return invalid("mcp", format!("mcp is not a list of at most {MAX_MCP_ENTRIES}"));
    }
    for name in &form.mcp {
        if !is_mcp_name(name) {
            return invalid("mcp", "an MCP entry has an invalid name");
        }
        if !known.catalog.contains(name) {
            return invalid("mcp", format!("the catalog has no entry {name}"));
        }
    }
    out.mcp = sorted_unique(&form.mcp);
    Ok(out)
}

// ------------------------------------------------------------------------------------------------------------ documents

/// What a revision is composed from: the library skills and catalog entries as they are at this moment.
pub struct Resolved<'a> {
    pub library: &'a BTreeMap<String, LibrarySkill>,
    pub catalog: &'a BTreeMap<String, McpEntry>,
}

pub fn compose_override(revision: &SetupRevision, resolved: &Resolved) -> Check<SetupOverride> {
    let form = &revision.form;
    let mut library = Vec::new();
    for name in &form.library_skills {
        match resolved.library.get(name) {
            Some(skill) => library.push(skill.clone()),
            None => return invalid("librarySkills", format!("the library skill {name} no longer exists")),
        }
    }
    let mut mcp = Vec::new();
    for name in &form.mcp {
        match resolved.catalog.get(name) {
            Some(entry) => mcp.push(entry.clone()),
            None => return invalid("mcp", format!("the catalog entry {name} no longer exists")),
        }
    }
    let document = SetupOverride {
        schema: SETUP_SCHEMA,
        kind: "override".into(),
        agent: revision.agent.clone(),
        revision: revision.revision,
        saved_by: revision.author.clone(),
        saved_at: revision.created_at.clone(),
        instructions: form.instructions.clone(),
        disable_global_prompt: form.disable_global_prompt,
        model: form.model.clone(),
        approval_patterns: form.approval_patterns.clone(),
        skills: SetupSkills { repository: form.repository_skills.clone(), library, overlays: form.overlays.clone() },
        mcp,
    };
    check_document(&document)?;
    Ok(document)
}

/// What `parseOverride` of the contract checks, so a document that the agent would refuse is never sent.
pub fn check_document(document: &SetupOverride) -> Check<()> {
    if document.revision == 0 {
        return invalid("", "the override has no revision");
    }
    if document.instructions.as_deref().is_some_and(|text| js_len(text) > MAX_INSTRUCTIONS_CHARS) {
        return invalid("instructions", format!("the instructions are longer than {MAX_INSTRUCTIONS_CHARS} characters"));
    }
    if let Some(patterns) = &document.approval_patterns {
        if patterns.len() > MAX_APPROVAL_PATTERNS {
            return invalid("approvalPatterns", "approvalPatterns is not a list of at most 100");
        }
        patterns.iter().try_for_each(check_pattern)?;
    }
    if document.skills.library.len() > MAX_LIBRARY_SKILLS {
        return invalid("librarySkills", "skills.library is not a list of at most 100");
    }
    for skill in &document.skills.library {
        if !is_skill_name(&skill.name) || skill.content.len() > MAX_SKILL_BYTES || skill.sha256 != sha256_hex(skill.content.as_bytes()) || skill.version == 0 || js_len(&skill.description) > 500 {
            return invalid("librarySkills", format!("the library skill {} is missing, larger than {MAX_SKILL_BYTES} bytes or does not match its checksum", skill.name));
        }
    }
    if document.mcp.len() > MAX_MCP_ENTRIES {
        return invalid("mcp", "mcp is not a list of at most 50");
    }
    let mut seen = BTreeSet::new();
    for entry in &document.mcp {
        check_mcp(entry.clone())?;
        if !seen.insert(&entry.name) {
            return invalid("mcp", format!("the MCP entry {} appears twice", entry.name));
        }
    }
    let size = serde_json::to_vec(document).map(|bytes| bytes.len()).unwrap_or(usize::MAX);
    if size > MAX_DOCUMENT_BYTES {
        return invalid("", format!("the document is {size} bytes, more than the {MAX_DOCUMENT_BYTES} an agent accepts: enable fewer or smaller skills"));
    }
    Ok(())
}

pub fn check_limits(values: &LimitsValues) -> Check<()> {
    for (field, value) in [
        ("maxTokensCap", values.max_tokens_cap),
        ("maxMinutesCap", values.max_minutes_cap),
        ("dailyTokenLimit", values.daily_token_limit),
        ("budgetRaiseCeiling", values.budget_raise_ceiling),
    ] {
        if value == 0 || value > JS_INTEGER_MAX {
            return invalid(&format!("values.{field}"), format!("{field} must be a positive integer"));
        }
    }
    if let Some(model) = &values.model {
        model.checked().or_else(|message| invalid("values.model", message))?;
    }
    if let Some(text) = &values.global_prompt {
        if js_len(text) > MAX_GLOBAL_PROMPT_CHARS {
            return invalid("values.globalPrompt", format!("the global prompt is longer than {MAX_GLOBAL_PROMPT_CHARS} characters"));
        }
        if contains_known_secret(text) {
            return invalid("values.globalPrompt", "the global prompt looks like it holds a token or key; it is sent to every agent and shown in Operations");
        }
    }
    Ok(())
}

pub fn compose_limits(revision: &LimitsRevision) -> FleetLimits {
    FleetLimits {
        schema: SETUP_SCHEMA,
        kind: "limits".into(),
        revision: revision.revision,
        saved_by: revision.author.clone(),
        saved_at: revision.created_at.clone(),
        max_tokens_cap: revision.values.max_tokens_cap,
        max_minutes_cap: revision.values.max_minutes_cap,
        daily_token_limit: revision.values.daily_token_limit,
        budget_raise_ceiling: revision.values.budget_raise_ceiling,
        global_prompt: revision.values.global_prompt.as_deref().map(|text| text.trim().to_string()),
        model: revision.values.model.as_ref().and_then(|model| model.checked().ok()),
    }
}

// ------------------------------------------------------------------------------------------------------------- agent ids

/// The part of an agent id that goes into URLs: `agent/pi-agent` becomes `pi-agent`.
pub fn slug_of(agent_id: &str) -> String {
    agent_id.strip_prefix("agent/").unwrap_or(agent_id).replace('/', "--")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stdio(name: &str) -> McpEntry {
        McpEntry {
            name: name.into(),
            description: None,
            transport: McpTransport::Stdio,
            command: Some("npx".into()),
            args: Some(vec!["-y".into(), "@modelcontextprotocol/server-filesystem".into()]),
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
        McpDownload { url: "https://example.com/tool.zip".into(), sha256: "ab".repeat(32), archive: ArchiveKind::Zip, executable: "bin/tool.exe".into() }
    }

    fn message(result: Check<McpEntry>) -> String {
        result.unwrap_err().message
    }

    #[test]
    fn names_follow_the_contract_patterns() {
        assert!(is_mcp_name("docs") && is_mcp_name("a_b-c9") && is_mcp_name(&"a".repeat(40)));
        assert!(!is_mcp_name("") && !is_mcp_name("-a") && !is_mcp_name("A") && !is_mcp_name(&"a".repeat(41)) && !is_mcp_name("a b"));
        assert!(is_skill_name("review-2") && !is_skill_name("review_2") && !is_skill_name(&"a".repeat(65)) && is_skill_name(&"a".repeat(64)));
        assert!(is_secret_name("GITHUB_TOKEN") && !is_secret_name("github") && !is_secret_name("1TOKEN") && !is_secret_name(&format!("A{}", "B".repeat(64))));
    }

    #[test]
    fn lengths_count_like_javascript() {
        assert_eq!(js_len("abc"), 3);
        assert_eq!(js_len("\u{1F600}"), 2, "an emoji is two UTF-16 units, as `String.length` counts it");
    }

    #[test]
    fn a_plain_stdio_entry_passes_and_keeps_what_the_agent_reads() {
        let checked = check_mcp(stdio("files")).unwrap();
        assert_eq!(checked.command.as_deref(), Some("npx"));
        let mut http = stdio("remote");
        http.transport = McpTransport::Http;
        http.url = Some("https://mcp.example.com/sse".into());
        let checked = check_mcp(http).unwrap();
        assert!(checked.command.is_none() && checked.args.is_none(), "the agent does not read a command for an http server");
    }

    #[test]
    fn the_contract_rules_for_an_entry_hold() {
        let mut entry = stdio("Bad Name");
        assert!(message(check_mcp(entry.clone())).contains("invalid name"));
        entry = stdio("ok");
        entry.command = None;
        assert!(message(check_mcp(entry)).contains("needs a command"));
        let mut http = stdio("remote");
        http.transport = McpTransport::Http;
        http.url = Some("ftp://x".into());
        assert!(message(check_mcp(http)).contains("http(s) url"));
        let mut entry = stdio("long");
        entry.description = Some("x".repeat(301));
        assert!(message(check_mcp(entry)).contains("long description"));
        let mut entry = stdio("timeout");
        entry.timeout_seconds = Some(0);
        assert!(message(check_mcp(entry)).contains("invalid timeout"));
        let mut entry = stdio("secret");
        entry.secrets = Some(vec!["lowercase".into()]);
        assert!(message(check_mcp(entry)).contains("invalid secret"));
    }

    #[test]
    fn downloads_need_https_a_checksum_and_an_executable_inside_the_folder() {
        let with = |change: &dyn Fn(&mut McpDownload)| {
            let mut entry = stdio("local");
            entry.command = Some("${LOCAL}".into());
            let mut d = download();
            change(&mut d);
            entry.downloads = Some(BTreeMap::from([("windows".to_string(), d)]));
            check_mcp(entry)
        };
        assert!(with(&|_| {}).is_ok());
        assert!(message(with(&|d| d.url = "http://example.com/a".into())).contains("https url"));
        assert!(message(with(&|d| d.sha256 = "AB".repeat(32))).contains("SHA-256"));
        assert!(message(with(&|d| d.sha256 = String::new())).contains("SHA-256"));
        assert!(message(with(&|d| d.executable = "/usr/bin/x".into())).contains("outside its folder"));
        assert!(message(with(&|d| d.executable = "../x".into())).contains("outside its folder"));
        assert!(message(with(&|d| d.url = "https://user:pw@example.com/a".into())).contains("credentials"));
        let mut entry = stdio("local");
        entry.command = Some("${LOCAL}".into());
        assert!(message(check_mcp(entry.clone())).contains("no download"));
        entry.downloads = Some(BTreeMap::from([("plan9".to_string(), download())]));
        assert!(message(check_mcp(entry)).contains("operating system"));
    }

    #[test]
    fn secret_values_are_refused_but_references_to_secret_names_pass() {
        let mut entry = stdio("gh");
        entry.env = Some(BTreeMap::from([("GITHUB_TOKEN".to_string(), "${GITHUB_TOKEN}".to_string())]));
        entry.secrets = Some(vec!["GITHUB_TOKEN".into()]);
        assert!(check_mcp(entry.clone()).is_ok());
        for literal in ["ghp_abcdefghijklmnopqrstuvwxyz0123456789", "hunter2", "sk-abcdefghijklmnopqrstuvwxyz"] {
            let mut bad = entry.clone();
            bad.env = Some(BTreeMap::from([("GITHUB_TOKEN".to_string(), literal.to_string())]));
            let reason = message(check_mcp(bad));
            assert!(reason.contains("GITHUB_TOKEN") && !reason.contains(literal), "the message names the field and never repeats the value: {reason}");
        }
        let mut bad = entry.clone();
        bad.env = Some(BTreeMap::from([("PLAIN".to_string(), "AKIAABCDEFGHIJKLMNOP".to_string())]));
        assert!(message(check_mcp(bad)).contains("looks like a token"));
        let mut bad = entry.clone();
        bad.env = Some(BTreeMap::from([("PLAIN".to_string(), "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop".to_string())]));
        assert!(message(check_mcp(bad)).contains("looks like a token"));
        let mut bad = entry.clone();
        bad.env = Some(BTreeMap::from([("PLAIN".to_string(), "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6".to_string())]));
        assert!(message(check_mcp(bad)).contains("looks like a token"), "an unknown provider's key is still key-shaped");
        let mut ok = entry.clone();
        ok.env = Some(BTreeMap::from([("LOG_LEVEL".to_string(), "debug".to_string()), ("ROOT".to_string(), "/srv/some/long/path/to/the/workspace-directory-1".to_string())]));
        assert!(check_mcp(ok).is_ok(), "ordinary values and long paths are fine");
    }

    #[test]
    fn headers_take_references_with_a_scheme_word_and_nothing_else() {
        let mut entry = stdio("remote");
        entry.transport = McpTransport::Http;
        entry.url = Some("https://mcp.example.com/sse".into());
        entry.secrets = Some(vec!["MCP_TOKEN".into()]);
        entry.headers = Some(BTreeMap::from([("Authorization".to_string(), "Bearer ${MCP_TOKEN}".to_string())]));
        assert!(check_mcp(entry.clone()).is_ok());
        entry.headers = Some(BTreeMap::from([("Authorization".to_string(), "Bearer abcdef".to_string())]));
        assert!(message(check_mcp(entry.clone())).contains("holds a secret"));
        entry.headers = Some(BTreeMap::from([("Authorization".to_string(), "Bearer ${OTHER}".to_string())]));
        assert!(message(check_mcp(entry.clone())).contains("does not list OTHER"));
        entry.headers = None;
        entry.url = Some("https://user:pw@mcp.example.com/sse".into());
        assert!(message(check_mcp(entry.clone())).contains("credentials"));
        entry.url = Some("https://mcp.example.com/sse?api_key=abc123".into());
        assert!(message(check_mcp(entry.clone())).contains("credentials"));
        entry.url = Some("https://mcp.example.com/sse?api_key=${MCP_TOKEN}".into());
        assert!(check_mcp(entry).is_ok());
    }

    #[test]
    fn arguments_are_checked_for_tokens_too() {
        let mut entry = stdio("args");
        entry.args = Some(vec!["--token".into(), "ghp_abcdefghijklmnopqrstuvwxyz0123456789".into()]);
        let reason = message(check_mcp(entry));
        assert!(reason.contains("argument 2") && !reason.contains("ghp_"));
    }

    #[test]
    fn a_malformed_or_unknown_reference_is_refused() {
        let mut entry = stdio("refs");
        entry.args = Some(vec!["${oops}".into()]);
        assert!(message(check_mcp(entry.clone())).contains("not a secret name"));
        entry.args = Some(vec!["${UNCLOSED".into()]);
        assert!(message(check_mcp(entry)).contains("closing brace"));
    }

    #[test]
    fn a_skill_is_checked_and_its_checksum_and_description_come_from_the_server() {
        let content = "---\nname: review\ndescription: Reviews a pull request for risk\n---\n# Review\nDo it.\n";
        let skill = check_skill("review", content).unwrap();
        assert_eq!(skill.description, "Reviews a pull request for risk");
        assert_eq!(skill.sha256, sha256_hex(content.as_bytes()));
        assert_eq!(skill.size_bytes, content.len() as u64);
        assert!(check_skill("Bad", content).is_err());
        assert!(check_skill("review", "   ").is_err());
        assert!(check_skill("review", &"x".repeat(MAX_SKILL_BYTES + 1)).unwrap_err().message.contains("larger"));
        assert!(check_skill("review", &"x".repeat(MAX_SKILL_BYTES)).is_ok());
        assert!(check_skill("review", "token ghp_abcdefghijklmnopqrstuvwxyz0123456789 inside").unwrap_err().message.contains("token or key"));
        assert!(check_skill("review", "-----BEGIN RSA PRIVATE KEY-----\nabc").is_err());
    }

    #[test]
    fn descriptions_come_from_plain_quoted_and_block_front_matter() {
        assert_eq!(skill_description("---\ndescription: \"Quoted one\"\n---\nbody"), "Quoted one");
        assert_eq!(skill_description("---\ndescription: 'Single'\n---\n"), "Single");
        assert_eq!(skill_description("---\nname: x\ndescription: >\n  folded over\n  two lines\nother: 1\n---\n"), "folded over two lines");
        assert_eq!(skill_description("# no front matter\ndescription: nope"), "");
        assert_eq!(skill_description("---\nname: x\n---\n"), "");
        assert_eq!(skill_description(&format!("---\ndescription: {}\n---\n", "d".repeat(900))).chars().count(), 500);
    }

    fn known() -> Known {
        Known { library: ["review".to_string()].into(), catalog: ["docs".to_string(), "files".to_string()].into() }
    }

    #[test]
    fn a_form_is_checked_and_canonicalised() {
        let form = SetupForm {
            instructions: Some("  \n".into()),
            library_skills: vec!["review".into(), "review".into()],
            mcp: vec!["files".into(), "docs".into(), "docs".into()],
            overlays: BTreeMap::from([("review".to_string(), "  ".to_string()), ("other".to_string(), "x".to_string())]),
            repository_skills: Some(vec!["b".into(), "a".into()]),
            ..Default::default()
        };
        let checked = check_form(&form, &known()).unwrap();
        assert_eq!(checked.instructions, None, "blank instructions are no instructions");
        assert_eq!(checked.library_skills, vec!["review"]);
        assert_eq!(checked.mcp, vec!["docs", "files"]);
        assert_eq!(checked.repository_skills, Some(vec!["a".into(), "b".into()]));
        assert_eq!(checked.overlays.keys().collect::<Vec<_>>(), vec!["other"], "an empty overlay is no overlay");
    }

    #[test]
    fn a_form_that_the_agent_would_refuse_is_refused_here() {
        let check = |form: SetupForm| check_form(&form, &known()).unwrap_err();
        assert_eq!(check(SetupForm { instructions: Some("x".repeat(MAX_INSTRUCTIONS_CHARS + 1)), ..Default::default() }).field.as_deref(), Some("instructions"));
        assert!(check_form(&SetupForm { instructions: Some("x".repeat(MAX_INSTRUCTIONS_CHARS)), ..Default::default() }, &known()).is_ok());
        assert_eq!(check(SetupForm { mcp: vec!["nope".into()], ..Default::default() }).message, "the catalog has no entry nope");
        assert_eq!(check(SetupForm { library_skills: vec!["nope".into()], ..Default::default() }).field.as_deref(), Some("librarySkills"));
        assert!(check(SetupForm { model: Some(ModelChoice { provider: Some(String::new()), model_id: Some("m".into()), effort: None }), ..Default::default() }).message.contains("provider"));
        assert!(check(SetupForm { approval_patterns: Some(vec![ApprovalPatternSetting { pattern: "(unclosed".into(), reason: "r".into() }]), ..Default::default() }).message.contains("not a regular expression"));
        assert!(check(SetupForm { approval_patterns: Some(vec![ApprovalPatternSetting { pattern: "x".repeat(301), reason: "r".into() }]), ..Default::default() }).message.contains("at most 300"));
        assert!(check(SetupForm { approval_patterns: Some(vec![ApprovalPatternSetting { pattern: "x".into(), reason: " ".into() }]), ..Default::default() }).message.contains("reason"));
        assert!(check(SetupForm { approval_patterns: Some(vec![ApprovalPatternSetting { pattern: "x".into(), reason: "r".into() }; 101]), ..Default::default() }).message.contains("at most 100"));
        assert!(check(SetupForm { overlays: BTreeMap::from([("review".to_string(), "x".repeat(MAX_OVERLAY_BYTES + 1))]), ..Default::default() }).message.contains("16 KiB"));
        assert!(check(SetupForm { overlays: BTreeMap::from([("Bad Name".to_string(), "x".into())]), ..Default::default() }).message.contains("invalid"));
        assert!(check(SetupForm { instructions: Some("use ghp_abcdefghijklmnopqrstuvwxyz0123456789 please".into()), ..Default::default() }).message.contains("token or key"));
        assert!(check(SetupForm { repository_skills: Some(vec!["Bad".into()]), ..Default::default() }).message.contains("invalid skill"));
        let model = ModelChoice { provider: Some("openai-codex".into()), model_id: Some("gpt-5.5".into()), effort: None };
        assert!(check_form(&SetupForm { model: Some(model), approval_patterns: Some(vec![]), ..Default::default() }, &known()).is_ok(), "an empty pattern list is allowed: nothing needs approval");
    }

    fn model(provider: Option<&str>, model_id: Option<&str>, effort: Option<Effort>) -> ModelChoice {
        ModelChoice { provider: provider.map(str::to_string), model_id: model_id.map(str::to_string), effort }
    }

    #[test]
    fn an_agents_model_is_provider_model_and_effort_each_optional_and_at_least_one() {
        let checked = |choice: ModelChoice| check_form(&SetupForm { model: Some(choice), ..Default::default() }, &known());
        for choice in [model(Some("openai-codex"), Some("gpt-6.1-sol"), Some(Effort::High)), model(Some("openai-codex"), None, None), model(None, Some("gpt-6.1-sol"), None), model(None, None, Some(Effort::Max))] {
            assert_eq!(checked(choice.clone()).unwrap().model, Some(choice));
        }
        assert_eq!(checked(model(Some("  openai-codex "), Some(" gpt-6.1-sol "), None)).unwrap().model, Some(model(Some("openai-codex"), Some("gpt-6.1-sol"), None)), "names are trimmed");
        assert_eq!(checked(ModelChoice::default()).unwrap_err().field.as_deref(), Some("model"));
        assert!(checked(ModelChoice::default()).unwrap_err().message.contains("at least one of provider, model id and effort"));
        assert!(checked(model(Some("  "), None, Some(Effort::Low))).unwrap_err().message.contains("provider is empty"));
        assert!(checked(model(Some(&"p".repeat(81)), None, None)).is_err());
        assert!(checked(model(Some(&"p".repeat(80)), None, None)).is_ok());
        assert!(checked(model(None, Some(&"m".repeat(201)), None)).unwrap_err().message.contains("model id is empty or longer than 200"));
    }

    #[test]
    fn the_efforts_are_the_levels_of_the_agents_and_nothing_else() {
        let kit = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../packages/agent-kit/src/setup/contract.ts")).expect("the kit's contract");
        let listed = Effort::ALL.iter().map(|effort| format!("\"{}\"", effort.as_str())).collect::<Vec<_>>().join(", ");
        assert!(kit.contains(&format!("export const EFFORTS = [{listed}] as const;")), "the kit's list differs from Effort::ALL");
        for effort in Effort::ALL {
            assert_eq!(serde_json::to_value(effort).unwrap(), effort.as_str());
            assert_eq!(Effort::parse(effort.as_str()), Some(effort));
        }
        assert_eq!(Effort::parse("extreme"), None);
        assert!(serde_json::from_value::<ModelChoice>(serde_json::json!({"effort": "extreme"})).is_err());
        assert_eq!(serde_json::from_value::<ModelChoice>(serde_json::json!({"provider": "p", "modelId": "m"})).unwrap(), model(Some("p"), Some("m"), None), "a model saved before the effort existed still reads");
    }

    #[test]
    fn the_override_document_carries_only_the_fields_that_are_set() {
        let empty = Resolved { library: &BTreeMap::new(), catalog: &BTreeMap::new() };
        let composed = |choice: ModelChoice| serde_json::to_value(compose_override(&revision(SetupForm { model: Some(choice), ..Default::default() }), &empty).unwrap()).unwrap();
        assert_eq!(composed(model(None, None, Some(Effort::High)))["model"], serde_json::json!({"effort": "high"}));
        assert_eq!(composed(model(Some("openai-codex"), Some("gpt-6.1-sol"), Some(Effort::Xhigh)))["model"], serde_json::json!({"provider": "openai-codex", "modelId": "gpt-6.1-sol", "effort": "xhigh"}));
        assert_eq!(composed(model(Some("p"), Some("m"), None))["model"], serde_json::json!({"provider": "p", "modelId": "m"}), "the document an agent already understands");
        assert!(serde_json::to_value(compose_override(&revision(SetupForm::default()), &empty).unwrap()).unwrap().get("model").is_none());
    }

    #[test]
    fn the_fleets_model_travels_in_the_limits_and_is_checked_like_an_agents() {
        let values = |choice: Option<ModelChoice>| LimitsValues { max_tokens_cap: 1, max_minutes_cap: 1, daily_token_limit: 1, budget_raise_ceiling: 1, global_prompt: None, model: choice };
        let revision = |choice: Option<ModelChoice>| LimitsRevision { revision: 2, values: values(choice), note: String::new(), author: "admin@example.com".into(), created_at: "2026-10-12T10:00:00.000Z".into() };
        assert!(serde_json::to_value(compose_limits(&revision(None))).unwrap().get("model").is_none(), "no model sent leaves every agent on its environment");
        let owner = model(Some("openai-codex"), Some(" gpt-6.1-sol"), Some(Effort::High));
        assert_eq!(serde_json::to_value(compose_limits(&revision(Some(owner.clone())))).unwrap()["model"], serde_json::json!({"provider": "openai-codex", "modelId": "gpt-6.1-sol", "effort": "high"}));
        assert!(check_limits(&values(Some(owner))).is_ok());
        assert!(check_limits(&values(Some(model(None, None, Some(Effort::Low))))).is_ok(), "an effort alone is a fleet setting");
        let empty = check_limits(&values(Some(ModelChoice::default()))).unwrap_err();
        assert_eq!((empty.field.as_deref(), empty.message.contains("at least one")), (Some("values.model"), true));
        assert_eq!(check_limits(&values(Some(model(Some(""), None, None)))).unwrap_err().field.as_deref(), Some("values.model"));
        assert!(check_limits(&values(Some(model(None, Some(&"m".repeat(201)), None)))).is_err());
    }

    #[test]
    fn notes_are_trimmed_and_limited() {
        assert_eq!(check_note(Some("  why  ")).unwrap(), "why");
        assert_eq!(check_note(None).unwrap(), "");
        assert!(check_note(Some(&"n".repeat(501))).is_err());
    }

    fn revision(form: SetupForm) -> SetupRevision {
        SetupRevision { agent: "agent/pi-agent".into(), revision: 4, form, note: String::new(), author: "ops@example.com".into(), created_at: "2026-10-10T10:00:00.000Z".into() }
    }

    fn resolved_library() -> BTreeMap<String, LibrarySkill> {
        let checked = check_skill("review", "---\ndescription: Reviews\n---\nbody").unwrap();
        BTreeMap::from([("review".to_string(), LibrarySkill { name: "review".into(), version: 3, description: checked.description, content: checked.content, sha256: checked.sha256 })])
    }

    #[test]
    fn the_document_resolves_library_and_catalog_at_this_moment() {
        let library = resolved_library();
        let catalog = BTreeMap::from([("docs".to_string(), check_mcp(stdio("docs")).unwrap())]);
        let form = SetupForm { instructions: Some("Be brief".into()), library_skills: vec!["review".into()], mcp: vec!["docs".into()], ..Default::default() };
        let document = compose_override(&revision(form), &Resolved { library: &library, catalog: &catalog }).unwrap();
        assert_eq!((document.schema, document.kind.as_str(), document.revision, document.agent.as_str()), (1, "override", 4, "agent/pi-agent"));
        assert_eq!((document.saved_by.as_str(), document.saved_at.as_str()), ("ops@example.com", "2026-10-10T10:00:00.000Z"));
        assert_eq!(document.skills.library[0].version, 3);
        assert_eq!(document.mcp[0].name, "docs");
        let missing = compose_override(&revision(SetupForm { mcp: vec!["gone".into()], ..Default::default() }), &Resolved { library: &library, catalog: &catalog });
        assert!(missing.unwrap_err().message.contains("no longer exists"));
    }

    #[test]
    fn the_global_prompt_travels_in_the_fleet_limits_and_its_switch_in_the_override() {
        let limits = |global_prompt: Option<&str>| LimitsRevision {
            revision: 2,
            values: LimitsValues { max_tokens_cap: 1, max_minutes_cap: 1, daily_token_limit: 1, budget_raise_ceiling: 1, global_prompt: global_prompt.map(str::to_string), model: None },
            note: String::new(),
            author: "admin@example.com".into(),
            created_at: "2026-10-12T10:00:00.000Z".into(),
        };
        assert!(serde_json::to_value(compose_limits(&limits(None))).unwrap().get("globalPrompt").is_none(), "no text sent keeps the agents' own default");
        assert_eq!(serde_json::to_value(compose_limits(&limits(Some("  Be kind.\n")))).unwrap()["globalPrompt"], "Be kind.");
        assert_eq!(serde_json::to_value(compose_limits(&limits(Some("")))).unwrap()["globalPrompt"], "", "an empty text is sent: it means none");

        let empty = Resolved { library: &BTreeMap::new(), catalog: &BTreeMap::new() };
        let off = serde_json::to_value(compose_override(&revision(SetupForm { disable_global_prompt: true, ..Default::default() }), &empty).unwrap()).unwrap();
        assert_eq!(off["disableGlobalPrompt"], true);
        assert!(serde_json::to_value(compose_override(&revision(SetupForm::default()), &empty).unwrap()).unwrap().get("disableGlobalPrompt").is_none());
        assert!(check_form(&SetupForm { disable_global_prompt: true, ..Default::default() }, &known()).unwrap().disable_global_prompt, "the switch survives the canonical form");
    }

    #[test]
    fn a_global_prompt_is_checked_like_instructions() {
        let with = |text: String| check_limits(&LimitsValues { max_tokens_cap: 1, max_minutes_cap: 1, daily_token_limit: 1, budget_raise_ceiling: 1, global_prompt: Some(text), model: None });
        assert!(with("x".repeat(MAX_GLOBAL_PROMPT_CHARS)).is_ok());
        assert_eq!(with("x".repeat(MAX_GLOBAL_PROMPT_CHARS + 1)).unwrap_err().field.as_deref(), Some("values.globalPrompt"));
        assert!(with("use ghp_abcdefghijklmnopqrstuvwxyz0123456789 please".into()).unwrap_err().message.contains("token or key"));
        assert!(with(String::new()).is_ok(), "an empty text switches the global prompt off for everyone");
    }

    #[test]
    fn the_default_global_prompt_is_the_one_the_agents_carry() {
        let kit = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../packages/agent-kit/src/setup/global-prompt.ts")).expect("the kit's file");
        for line in DEFAULT_GLOBAL_PROMPT.lines() {
            assert!(kit.contains(&format!("\"{line}\"")), "the kit's default lacks: {line}");
        }
        assert_eq!(kit.matches("\n\t\"").count(), DEFAULT_GLOBAL_PROMPT.lines().count(), "the kit's default has the same number of lines");
    }

    #[test]
    fn a_reset_is_an_empty_document() {
        let document = compose_override(&revision(SetupForm::default()), &Resolved { library: &BTreeMap::new(), catalog: &BTreeMap::new() }).unwrap();
        let json = serde_json::to_value(&document).unwrap();
        assert_eq!(json["skills"], serde_json::json!({"library": [], "overlays": {}}));
        assert_eq!(json["mcp"], serde_json::json!([]));
        for absent in ["instructions", "model", "approvalPatterns"] {
            assert!(json.get(absent).is_none(), "{absent} is absent in an empty override");
        }
    }

    #[test]
    fn a_document_over_two_mebibytes_is_not_sent() {
        let mut library = BTreeMap::new();
        for index in 0..40 {
            let content = format!("{index}{}", "x".repeat(MAX_SKILL_BYTES - 4));
            library.insert(format!("skill-{index}"), LibrarySkill { name: format!("skill-{index}"), version: 1, description: String::new(), sha256: sha256_hex(content.as_bytes()), content });
        }
        let form = SetupForm { library_skills: library.keys().cloned().collect(), ..Default::default() };
        let reason = compose_override(&revision(form), &Resolved { library: &library, catalog: &BTreeMap::new() }).unwrap_err().message;
        assert!(reason.contains("more than the"));
    }

    #[test]
    fn limits_are_positive_integers_an_agent_can_read() {
        let ok = LimitsValues { max_tokens_cap: 1, max_minutes_cap: 2, daily_token_limit: 3, budget_raise_ceiling: 4, global_prompt: None, model: None };
        assert!(check_limits(&ok).is_ok());
        assert_eq!(check_limits(&LimitsValues { max_minutes_cap: 0, ..ok.clone() }).unwrap_err().field.as_deref(), Some("values.maxMinutesCap"));
        assert!(check_limits(&LimitsValues { daily_token_limit: JS_INTEGER_MAX + 1, ..ok.clone() }).is_err());
        let document = compose_limits(&LimitsRevision { revision: 2, values: ok, note: String::new(), author: "a@b".into(), created_at: "t".into() });
        assert_eq!(serde_json::to_value(&document).unwrap(), serde_json::json!({"schema": 1, "kind": "limits", "revision": 2, "savedBy": "a@b", "savedAt": "t", "maxTokensCap": 1, "maxMinutesCap": 2, "dailyTokenLimit": 3, "budgetRaiseCeiling": 4}));
    }

    #[test]
    fn slugs_drop_the_agent_prefix() {
        assert_eq!(slug_of("agent/pi-agent"), "pi-agent");
        assert_eq!(slug_of("service/x/y"), "service--x--y");
    }
}

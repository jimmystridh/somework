//! Reaction input templates: `${/json/pointer}` references into the event payload.
//!
//! A string that is exactly one reference is replaced by the typed value found at the pointer; references inside a
//! longer string are replaced by their text form. A missing pointer is an error. `$${` writes a literal `${`.

use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TemplateError {
    MissingPointer(String),
    MalformedReference(String),
}

impl std::fmt::Display for TemplateError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::MissingPointer(pointer) => write!(f, "template pointer {pointer} does not exist in the event"),
            Self::MalformedReference(text) => write!(f, "malformed template reference in {text:?}"),
        }
    }
}

impl std::error::Error for TemplateError {}

pub fn render(template: &Value, source: &Value) -> Result<Value, TemplateError> {
    match template {
        Value::String(text) => render_string(text, source),
        Value::Array(items) => Ok(Value::Array(items.iter().map(|item| render(item, source)).collect::<Result<_, _>>()?)),
        Value::Object(map) => Ok(Value::Object(map.iter().map(|(key, value)| render(value, source).map(|v| (key.clone(), v))).collect::<Result<_, _>>()?)),
        other => Ok(other.clone()),
    }
}

/// Every pointer a template refers to, for validation when a rule is stored.
pub fn references(template: &Value) -> Vec<String> {
    let mut out = Vec::new();
    collect(template, &mut out);
    out
}

fn collect(template: &Value, out: &mut Vec<String>) {
    match template {
        Value::String(text) => {
            if let Ok(parts) = split(text) {
                out.extend(parts.into_iter().filter_map(|part| if let Part::Reference(p) = part { Some(p) } else { None }));
            }
        }
        Value::Array(items) => items.iter().for_each(|item| collect(item, out)),
        Value::Object(map) => map.values().for_each(|value| collect(value, out)),
        _ => {}
    }
}

enum Part {
    Text(String),
    Reference(String),
}

fn split(text: &str) -> Result<Vec<Part>, TemplateError> {
    let mut parts = Vec::new();
    let mut literal = String::new();
    let mut rest = text;
    while let Some(at) = rest.find("$") {
        literal.push_str(&rest[..at]);
        let after = &rest[at..];
        if let Some(escaped) = after.strip_prefix("$${") {
            literal.push_str("${");
            rest = escaped;
        } else if let Some(reference) = after.strip_prefix("${") {
            let end = reference.find('}').ok_or_else(|| TemplateError::MalformedReference(text.to_string()))?;
            let pointer = &reference[..end];
            if !pointer.starts_with('/') {
                return Err(TemplateError::MalformedReference(text.to_string()));
            }
            if !literal.is_empty() {
                parts.push(Part::Text(std::mem::take(&mut literal)));
            }
            parts.push(Part::Reference(pointer.to_string()));
            rest = &reference[end + 1..];
        } else {
            literal.push('$');
            rest = &after[1..];
        }
    }
    literal.push_str(rest);
    if !literal.is_empty() {
        parts.push(Part::Text(literal));
    }
    Ok(parts)
}

fn lookup<'a>(source: &'a Value, pointer: &str) -> Result<&'a Value, TemplateError> {
    source.pointer(pointer).ok_or_else(|| TemplateError::MissingPointer(pointer.to_string()))
}

fn text_form(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

fn render_string(text: &str, source: &Value) -> Result<Value, TemplateError> {
    let parts = split(text)?;
    if let [Part::Reference(pointer)] = parts.as_slice() {
        return lookup(source, pointer).cloned();
    }
    let mut out = String::new();
    for part in parts {
        match part {
            Part::Text(literal) => out.push_str(&literal),
            Part::Reference(pointer) => out.push_str(&text_form(lookup(source, &pointer)?)),
        }
    }
    Ok(Value::String(out))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn event() -> Value {
        json!({"data": {"number": 42, "title": "Fix it", "draft": false, "labels": ["a", "b"], "empty": null}})
    }

    #[test]
    fn whole_value_references_keep_their_type() {
        let rendered = render(&json!({"n": "${/data/number}", "d": "${/data/draft}", "l": "${/data/labels}", "z": "${/data/empty}"}), &event()).unwrap();
        assert_eq!(rendered, json!({"n": 42, "d": false, "l": ["a", "b"], "z": null}));
    }

    #[test]
    fn embedded_references_become_text() {
        let rendered = render(&json!({"msg": "PR #${/data/number}: ${/data/title} (${/data/labels})"}), &event()).unwrap();
        assert_eq!(rendered, json!({"msg": "PR #42: Fix it ([\"a\",\"b\"])"}));
    }

    #[test]
    fn a_missing_pointer_is_an_error() {
        assert_eq!(render(&json!("${/data/nope}"), &event()), Err(TemplateError::MissingPointer("/data/nope".into())));
        assert_eq!(render(&json!("x ${/nope} y"), &event()), Err(TemplateError::MissingPointer("/nope".into())));
    }

    #[test]
    fn escapes_and_plain_dollars_are_literal() {
        assert_eq!(render(&json!("cost $5 and $${/data/number}"), &event()).unwrap(), json!("cost $5 and ${/data/number}"));
    }

    #[test]
    fn malformed_references_are_rejected() {
        assert!(matches!(render(&json!("${/data/number"), &event()), Err(TemplateError::MalformedReference(_))));
        assert!(matches!(render(&json!("${data/number}"), &event()), Err(TemplateError::MalformedReference(_))));
    }

    #[test]
    fn nested_structures_and_non_strings_are_walked() {
        let rendered = render(&json!({"a": [{"b": "${/data/title}"}, 7, true, null]}), &event()).unwrap();
        assert_eq!(rendered, json!({"a": [{"b": "Fix it"}, 7, true, null]}));
    }

    #[test]
    fn references_lists_every_pointer() {
        assert_eq!(references(&json!({"a": "${/x}", "b": ["t ${/y} ${/z}"], "c": "$${/no}"})), vec!["/x".to_string(), "/y".to_string(), "/z".to_string()]);
    }
}

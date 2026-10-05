use serde_json::Value;
use sha2::{Digest, Sha256};

/// Deterministic JSON serialization with lexicographically sorted object keys and no insignificant whitespace.
pub fn canonical_json(value: &Value) -> String {
    let mut out = String::new();
    write_canonical(value, &mut out);
    out
}

fn write_canonical(value: &Value, out: &mut String) {
    match value {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            out.push('{');
            for (i, key) in keys.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&serde_json::to_string(key).expect("string serializes"));
                out.push(':');
                write_canonical(&map[*key], out);
            }
            out.push('}');
        }
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_canonical(item, out);
            }
            out.push(']');
        }
        Value::Number(n) => out.push_str(&canonical_number(n)),
        other => out.push_str(&serde_json::to_string(other).expect("scalar serializes")),
    }
}

/// Numbers follow ECMAScript `Number#toString` (as RFC 8785 requires), so a digest computed over a document
/// by a JavaScript client (the console) equals the digest computed by the platform: `1.0` is written `1`.
fn canonical_number(n: &serde_json::Number) -> String {
    match n.as_f64() {
        Some(f) if n.is_f64() && f.is_finite() && f.fract() == 0.0 && f.abs() < 1e21 => {
            if f == 0.0 {
                "0".into()
            } else {
                format!("{f:.0}")
            }
        }
        _ => n.to_string(),
    }
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

pub fn digest_json(value: &Value) -> String {
    sha256_hex(canonical_json(value).as_bytes())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn integral_floats_match_ecmascript_formatting() {
        let a: Value = serde_json::from_str(r#"{"c": 1.0, "d": 0.78, "e": -0.0, "f": 1e3, "g": 12}"#).unwrap();
        assert_eq!(canonical_json(&a), r#"{"c":1,"d":0.78,"e":0,"f":1000,"g":12}"#);
    }

    #[test]
    fn key_order_does_not_change_digest() {
        let a = json!({"b": 1, "a": {"y": [1, 2], "x": null}});
        let b = json!({"a": {"x": null, "y": [1, 2]}, "b": 1});
        assert_eq!(digest_json(&a), digest_json(&b));
        assert_eq!(canonical_json(&a), r#"{"a":{"x":null,"y":[1,2]},"b":1}"#);
    }
}

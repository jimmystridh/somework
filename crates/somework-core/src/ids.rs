use ulid::Ulid;

pub fn new_id(prefix: &str) -> String {
    format!("{prefix}_{}", Ulid::generate())
}

pub fn task_id() -> String {
    new_id("task")
}
pub fn message_id() -> String {
    new_id("msg")
}
pub fn conversation_id() -> String {
    new_id("conv")
}
pub fn context_pack_id() -> String {
    new_id("ctxp")
}
pub fn artifact_id() -> String {
    new_id("art")
}
pub fn event_id() -> String {
    new_id("evt")
}
pub fn lease_id() -> String {
    new_id("lease")
}
pub fn runtime_instance_id() -> String {
    new_id("rt")
}
pub fn decision_id() -> String {
    new_id("pol")
}
pub fn audit_id() -> String {
    new_id("aud")
}
pub fn approval_id() -> String {
    new_id("appr")
}
pub fn subscription_id() -> String {
    new_id("sub")
}
pub fn offer_id() -> String {
    new_id("offer")
}
pub fn upload_id() -> String {
    new_id("upl")
}
pub fn principal_id() -> String {
    new_id("prn")
}
pub fn trace_id_hex() -> String {
    hex::encode(rand::random::<[u8; 16]>())
}
pub fn jti() -> String {
    hex::encode(rand::random::<[u8; 16]>())
}

/// NATS subject tokens may not contain `.`, `*`, `>` or whitespace; arbitrary ids are encoded
/// reversibly so that user supplied strings can never inject extra subject levels or wildcards.
pub fn subject_token(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for byte in raw.bytes() {
        if byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-' {
            out.push(byte as char);
        } else {
            out.push('~');
            out.push_str(&format!("{byte:02x}"));
        }
    }
    if out.is_empty() {
        out.push('~');
    }
    out
}

pub fn decode_subject_token(token: &str) -> Option<String> {
    if token == "~" {
        return Some(String::new());
    }
    let bytes = token.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'~' {
            let hex = token.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn subject_tokens_roundtrip_and_never_contain_separators() {
        for raw in ["agent/dev-investigator", "a.b.c", "x*y>z", "with space", "ünï", ""] {
            let encoded = subject_token(raw);
            assert!(!encoded.contains(['.', '*', '>', ' ', '/']));
            assert_eq!(decode_subject_token(&encoded).unwrap(), raw);
        }
    }

    #[test]
    fn ids_are_prefixed_and_unique() {
        let a = task_id();
        let b = task_id();
        assert!(a.starts_with("task_"));
        assert_ne!(a, b);
    }
}

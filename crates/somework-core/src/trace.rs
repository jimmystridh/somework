use crate::ids::trace_id_hex;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TraceContext {
    pub trace_id: String,
    pub span_id: String,
    pub sampled: bool,
}

impl TraceContext {
    pub fn new_root() -> Self {
        Self { trace_id: trace_id_hex(), span_id: hex::encode(rand::random::<[u8; 8]>()), sampled: true }
    }

    /// Parses a W3C `traceparent` header; invalid or all-zero values yield `None`.
    pub fn parse(header: &str) -> Option<Self> {
        let parts: Vec<&str> = header.trim().split('-').collect();
        if parts.len() < 4 || parts[0].len() != 2 || parts[0] == "ff" {
            return None;
        }
        let (trace_id, span_id, flags) = (parts[1], parts[2], parts[3]);
        let is_hex = |s: &str, n: usize| s.len() == n && s.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase());
        if !is_hex(trace_id, 32) || !is_hex(span_id, 16) || !is_hex(flags, 2) {
            return None;
        }
        if trace_id.bytes().all(|b| b == b'0') || span_id.bytes().all(|b| b == b'0') {
            return None;
        }
        let flags = u8::from_str_radix(flags, 16).ok()?;
        Some(Self { trace_id: trace_id.into(), span_id: span_id.into(), sampled: flags & 1 == 1 })
    }

    /// Same trace, new span: what a service emits when it continues a trace received from a caller.
    pub fn child(&self) -> Self {
        Self { trace_id: self.trace_id.clone(), span_id: hex::encode(rand::random::<[u8; 8]>()), sampled: self.sampled }
    }

    pub fn traceparent(&self) -> String {
        format!("00-{}-{}-{}", self.trace_id, self.span_id, if self.sampled { "01" } else { "00" })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_propagates() {
        let tp = "00-bce929a608a64b68b6f61d42d3ad6bb6-3169a8aa208ed5a1-01";
        let ctx = TraceContext::parse(tp).unwrap();
        assert_eq!(ctx.trace_id, "bce929a608a64b68b6f61d42d3ad6bb6");
        let child = ctx.child();
        assert_eq!(child.trace_id, ctx.trace_id);
        assert_ne!(child.span_id, ctx.span_id);
        assert_eq!(TraceContext::parse(&child.traceparent()).unwrap(), child);
    }

    #[test]
    fn rejects_malformed() {
        for bad in ["", "00-abc", "00-00000000000000000000000000000000-3169a8aa208ed5a1-01", "ff-bce929a608a64b68b6f61d42d3ad6bb6-3169a8aa208ed5a1-01"] {
            assert!(TraceContext::parse(bad).is_none(), "{bad}");
        }
    }
}

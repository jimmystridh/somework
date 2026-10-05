//! Lossless-enough conversions between `google.protobuf.Struct`/`Value` and `serde_json`. Struct numbers are
//! doubles; integral values are turned back into JSON integers so domain types with `u64` fields deserialize.

use prost_types::{ListValue, Struct, Value as PbValue, value::Kind};
use serde_json::{Map, Number, Value};

pub fn pb_to_json(v: PbValue) -> Value {
    match v.kind {
        None | Some(Kind::NullValue(_)) => Value::Null,
        Some(Kind::BoolValue(b)) => Value::Bool(b),
        Some(Kind::StringValue(s)) => Value::String(s),
        Some(Kind::NumberValue(n)) => number(n),
        Some(Kind::StructValue(s)) => struct_to_json(s),
        Some(Kind::ListValue(l)) => Value::Array(l.values.into_iter().map(pb_to_json).collect()),
    }
}

fn number(n: f64) -> Value {
    if n.fract() == 0.0 && n.abs() < 9.0e15 { Value::Number(Number::from(n as i64)) } else { Number::from_f64(n).map(Value::Number).unwrap_or(Value::Null) }
}

pub fn struct_to_json(s: Struct) -> Value {
    Value::Object(s.fields.into_iter().map(|(k, v)| (k, pb_to_json(v))).collect::<Map<_, _>>())
}

pub fn json_to_pb(v: &Value) -> PbValue {
    let kind = match v {
        Value::Null => Kind::NullValue(0),
        Value::Bool(b) => Kind::BoolValue(*b),
        Value::Number(n) => Kind::NumberValue(n.as_f64().unwrap_or_default()),
        Value::String(s) => Kind::StringValue(s.clone()),
        Value::Array(a) => Kind::ListValue(ListValue { values: a.iter().map(json_to_pb).collect() }),
        Value::Object(o) => Kind::StructValue(Struct { fields: o.iter().map(|(k, v)| (k.clone(), json_to_pb(v))).collect() }),
    };
    PbValue { kind: Some(kind) }
}

/// Objects become Structs; anything else (null, scalars) yields `None`.
pub fn json_to_struct(v: &Value) -> Option<Struct> {
    v.as_object().map(|o| Struct { fields: o.iter().map(|(k, v)| (k.clone(), json_to_pb(v))).collect() })
}

/// Incremental builder for request documents: omitted/empty proto fields are simply left out of the JSON so the
/// domain's serde defaults apply exactly as for an omitted REST field.
#[derive(Default)]
pub struct Doc(Map<String, Value>);

impl Doc {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn str(mut self, key: &str, v: &str) -> Self {
        if !v.is_empty() {
            self.0.insert(key.into(), Value::String(v.into()));
        }
        self
    }

    pub fn strs(mut self, key: &str, v: &[String]) -> Self {
        if !v.is_empty() {
            self.0.insert(key.into(), Value::Array(v.iter().cloned().map(Value::String).collect()));
        }
        self
    }

    pub fn u64(mut self, key: &str, v: u64) -> Self {
        if v != 0 {
            self.0.insert(key.into(), Value::from(v));
        }
        self
    }

    pub fn i64(mut self, key: &str, v: i64) -> Self {
        if v != 0 {
            self.0.insert(key.into(), Value::from(v));
        }
        self
    }

    pub fn opt_u64(mut self, key: &str, v: Option<u64>) -> Self {
        if let Some(v) = v {
            self.0.insert(key.into(), Value::from(v));
        }
        self
    }

    pub fn opt_bool(mut self, key: &str, v: Option<bool>) -> Self {
        if let Some(v) = v {
            self.0.insert(key.into(), Value::Bool(v));
        }
        self
    }

    pub fn bool(mut self, key: &str, v: bool) -> Self {
        if v {
            self.0.insert(key.into(), Value::Bool(true));
        }
        self
    }

    pub fn f64(mut self, key: &str, v: f64) -> Self {
        if v != 0.0 {
            self.0.insert(key.into(), number(v));
        }
        self
    }

    pub fn structure(mut self, key: &str, v: Option<Struct>) -> Self {
        if let Some(s) = v {
            self.0.insert(key.into(), struct_to_json(s));
        }
        self
    }

    pub fn structs(mut self, key: &str, v: Vec<Struct>) -> Self {
        if !v.is_empty() {
            self.0.insert(key.into(), Value::Array(v.into_iter().map(struct_to_json).collect()));
        }
        self
    }

    pub fn raw(mut self, key: &str, v: Value) -> Self {
        if !v.is_null() {
            self.0.insert(key.into(), v);
        }
        self
    }

    pub fn map(mut self, key: &str, v: std::collections::HashMap<String, String>) -> Self {
        if !v.is_empty() {
            self.0.insert(key.into(), Value::Object(v.into_iter().map(|(k, v)| (k, Value::String(v))).collect()));
        }
        self
    }

    pub fn build(self) -> Value {
        Value::Object(self.0)
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn integers_survive_the_struct_roundtrip() {
        let original = json!({"revision": 3, "nested": {"n": 1.5, "list": [1, "a", null, true]}});
        let back = struct_to_json(json_to_struct(&original).unwrap());
        assert_eq!(back, original);
        assert!(back["revision"].is_u64());
    }

    #[test]
    fn empty_fields_are_omitted() {
        let doc = Doc::new().str("a", "").str("b", "x").u64("c", 0).opt_u64("d", Some(0)).build();
        assert_eq!(doc, json!({"b": "x", "d": 0}));
    }
}

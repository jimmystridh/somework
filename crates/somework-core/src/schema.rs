//! JSON Schema Draft 2020-12 validation against the canonical v1 contract bundle.

use std::{collections::HashMap, sync::OnceLock};

use jsonschema::Validator;
use serde_json::{Value, json};

use crate::error::{Error, ErrorCode};

pub const BUNDLE_JSON: &str = include_str!("../schemas/v1.json");

pub fn bundle() -> &'static Value {
    static BUNDLE: OnceLock<Value> = OnceLock::new();
    BUNDLE.get_or_init(|| serde_json::from_str(BUNDLE_JSON).expect("embedded schema bundle is valid JSON"))
}

pub fn definition_names() -> Vec<String> {
    bundle()["$defs"].as_object().map(|m| m.keys().cloned().collect()).unwrap_or_default()
}

fn validators() -> &'static HashMap<String, Validator> {
    static VALIDATORS: OnceLock<HashMap<String, Validator>> = OnceLock::new();
    VALIDATORS.get_or_init(|| {
        let mut out = HashMap::new();
        for name in definition_names() {
            let mut schema = bundle().clone();
            schema["$ref"] = json!(format!("#/$defs/{name}"));
            let validator =
                jsonschema::options().should_validate_formats(true).build(&schema).unwrap_or_else(|e| panic!("bundle definition {name} must compile: {e}"));
            out.insert(name, validator);
        }
        out
    })
}

/// Validate `instance` against `$defs/<definition>` of the contract bundle.
pub fn validate_contract(definition: &str, instance: &Value) -> Result<(), Error> {
    let validator = validators().get(definition).ok_or_else(|| Error::internal(format!("unknown contract definition {definition}")))?;
    let violations: Vec<Value> = validator.iter_errors(instance).map(|e| json!({"path": e.instance_path().to_string(), "message": e.to_string()})).collect();
    if violations.is_empty() {
        Ok(())
    } else {
        Err(Error::new(ErrorCode::SchemaViolation, format!("{definition} does not conform to the v1 contract"))
            .with_details(json!({"definition": definition, "violations": violations})))
    }
}

/// Validate caller supplied data against a capability's own input/output schema.
pub fn validate_against(schema: &Value, instance: &Value, what: &str) -> Result<(), Error> {
    let validator = jsonschema::options()
        .should_validate_formats(true)
        .build(schema)
        .map_err(|e| Error::new(ErrorCode::ValidationFailed, format!("invalid {what} schema: {e}")))?;
    let violations: Vec<Value> = validator.iter_errors(instance).map(|e| json!({"path": e.instance_path().to_string(), "message": e.to_string()})).collect();
    if violations.is_empty() {
        Ok(())
    } else {
        Err(Error::new(ErrorCode::SchemaViolation, format!("{what} does not match the capability schema")).with_details(json!({"violations": violations})))
    }
}

/// Check that a schema itself is a valid Draft 2020-12 schema (capabilities are registered by untrusted agents).
pub fn check_schema(schema: &Value, what: &str) -> Result<(), Error> {
    jsonschema::meta::validate(schema).map_err(|e| Error::new(ErrorCode::ValidationFailed, format!("{what} is not a valid JSON Schema: {e}")))?;
    jsonschema::options().build(schema).map(|_| ()).map_err(|e| Error::new(ErrorCode::ValidationFailed, format!("{what} cannot be compiled: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundle_defines_all_contracts() {
        let names = definition_names();
        for expected in ["ActorRef", "Capability", "AgentCard", "CatalogEntry", "ArtifactRef", "MessageEnvelope", "Task", "ContextPack", "AuthorizationToken"] {
            assert!(names.iter().any(|n| n == expected), "{expected} missing");
        }
    }

    #[test]
    fn sample_context_pack_from_the_spec_is_valid() {
        let sample: Value = serde_json::from_str(include_str!("../tests/fixtures/sample_context_pack.json")).unwrap();
        validate_contract("ContextPack", &sample).unwrap();
    }

    #[test]
    fn context_pack_requires_untrusted_instructions_flag_false() {
        let mut sample: Value = serde_json::from_str(include_str!("../tests/fixtures/sample_context_pack.json")).unwrap();
        sample["security"]["instructionsTrusted"] = json!(true);
        let err = validate_contract("ContextPack", &sample).unwrap_err();
        assert_eq!(err.code, ErrorCode::SchemaViolation);
    }

    #[test]
    fn unknown_fields_are_rejected() {
        let actor = json!({"kind": "agent", "id": "a", "domainId": "d", "extra": 1});
        assert!(validate_contract("ActorRef", &actor).is_err());
        let ok = json!({"kind": "agent", "id": "a", "domainId": "d"});
        assert!(validate_contract("ActorRef", &ok).is_ok());
    }

    #[test]
    fn capability_ids_are_pattern_checked() {
        let cap = json!({
            "id": "Bad Id", "version": "1", "name": "n", "description": "d",
            "inputSchema": {"type": "object"}, "outputSchema": {"type": "object"}, "sideEffects": "none"
        });
        assert!(validate_contract("Capability", &cap).is_err());
    }
}

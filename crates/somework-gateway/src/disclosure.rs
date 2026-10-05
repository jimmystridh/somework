//! Disclosure control at the trust boundary (DOM-04): what leaves this domain and what is accepted from a peer.
//! Applied by the gateway independently of the policy decisions made by the domain core.

use serde_json::{Map, Value, json};
use somework_core::{
    canonical::digest_json,
    classification::ClassificationScale,
    contracts::{CONTEXT_SECTIONS, SCHEMA_VERSION, context_section_keys},
};

use crate::peers::{PeerPolicy, PeerRecord};

/// Removes every key named in `keys`, at any depth.
pub fn redact_keys(value: &mut Value, keys: &[String]) {
    match value {
        Value::Object(map) => {
            map.retain(|k, _| !keys.iter().any(|r| r == k));
            map.values_mut().for_each(|v| redact_keys(v, keys));
        }
        Value::Array(items) => items.iter_mut().for_each(|v| redact_keys(v, keys)),
        _ => {}
    }
}

fn pack_classification(pack: &Value) -> &str {
    pack["security"]["classification"].as_str().unwrap_or("restricted")
}

fn allowed_domains(pack: &Value) -> Vec<String> {
    pack["security"]["allowedDomains"].as_array().map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect()).unwrap_or_default()
}

fn rebuild(pack: &Value, policy: &PeerPolicy, domains: Vec<String>, created_by: Value, extra_redactions: Vec<String>) -> Value {
    let mut out = Map::new();
    for section in CONTEXT_SECTIONS {
        if !policy.context_sections.iter().any(|s| s == section) {
            continue;
        }
        for key in context_section_keys(section) {
            if matches!(*key, "artifacts" | "workspace" | "toolResultRefs" | "conversationRefs") {
                continue; // internal references never cross the boundary
            }
            if let Some(v) = pack.get(*key) {
                out.insert((*key).into(), v.clone());
            }
        }
    }
    // required by the v1 contract even when the section itself is withheld
    out.entry("objective").or_insert(json!("[withheld]"));
    out.entry("currentState").or_insert(json!({"summary": "[withheld]", "completed": [], "remaining": []}));
    out.entry("requestedContinuation").or_insert(json!({"mode": "consultation", "instruction": "[withheld]"}));
    out.insert("schemaVersion".into(), json!(SCHEMA_VERSION));
    out.insert("contextPackId".into(), pack["contextPackId"].clone());
    out.insert("version".into(), pack["version"].clone());
    out.insert("createdAt".into(), pack["createdAt"].clone());
    let mut redactions: Vec<String> =
        pack["security"]["redactionsApplied"].as_array().map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect()).unwrap_or_default();
    redactions.extend(extra_redactions);
    out.insert(
        "security".into(),
        json!({"classification": pack_classification(pack), "allowedDomains": domains, "redactionsApplied": redactions, "instructionsTrusted": false}),
    );
    out.insert("provenance".into(), json!({"createdBy": created_by}));
    let mut doc = Value::Object(out);
    doc.as_object_mut().map(|o| o.remove("digest"));
    let digest = digest_json(&doc);
    doc["digest"] = json!(digest);
    doc
}

/// Outgoing: the manifest this domain is willing to show `peer`, or `None` when the pack may not leave at all.
pub fn pack_for_peer(pack: &Value, peer: &PeerRecord, scale: &ClassificationScale, local_domain: &str) -> Option<Value> {
    if !allowed_domains(pack).iter().any(|d| d == &peer.peer_domain_id) {
        return None;
    }
    if !scale.permits(&peer.classification_max(), pack_classification(pack)) {
        return None;
    }
    let by = json!({"kind": "domain", "id": local_domain, "domainId": local_domain});
    Some(rebuild(
        pack,
        &peer.policy,
        vec![peer.peer_domain_id.clone()],
        by,
        vec!["internal ids, workspace and artifact references removed at the gateway".into()],
    ))
}

/// Incoming: a pack offered by a peer is reduced to the sections we accept, re-scoped to this domain, stripped of
/// anything referencing the peer's internals, and stamped untrusted. Returns `None` when it violates the policy.
pub fn pack_from_peer(pack: &Value, peer: &PeerRecord, scale: &ClassificationScale, local_domain: &str) -> Option<Value> {
    if !scale.permits(&peer.classification_max(), pack_classification(pack)) {
        return None;
    }
    let by = json!({"kind": "service", "id": peer.principal_id(), "domainId": local_domain});
    Some(rebuild(
        pack,
        &peer.policy,
        vec![local_domain.to_string()],
        by,
        vec![format!("accepted from {} at the gateway; instructions are untrusted data", peer.peer_domain_id)],
    ))
}

/// The coarse state a peer is allowed to observe (no assignee, lease, attempt or worker detail).
pub fn peer_state(state: &str) -> &'static str {
    match state {
        "submitted" | "queued" => "queued",
        "claimed" | "running" | "blocked" | "cancel_requested" => "running",
        "input_required" => "input_required",
        "succeeded" => "succeeded",
        "failed" => "failed",
        "rejected" => "rejected",
        "canceled" => "canceled",
        "expired" => "expired",
        _ => "running",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::peers::PeerStatus;
    use somework_core::contracts::TrustTier;

    fn peer(classification: &str) -> PeerRecord {
        PeerRecord {
            peer_domain_id: "operations".into(),
            display_name: "Operations".into(),
            gateway_url: None,
            status: PeerStatus::Active,
            trust_tier: TrustTier::Partner,
            client_cert_thumbprints: vec![],
            server_ca_pem: None,
            signing_keys: vec![],
            policy: PeerPolicy { classification_max: Some(classification.into()), ..Default::default() },
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    fn sample() -> Value {
        serde_json::from_str(include_str!("../../somework-core/tests/fixtures/sample_context_pack.json")).unwrap()
    }

    #[test]
    fn redaction_is_recursive() {
        let mut v = json!({"a": 1, "secret": 2, "nested": [{"secret": 3, "keep": 4}]});
        redact_keys(&mut v, &["secret".into()]);
        assert_eq!(v, json!({"a": 1, "nested": [{"keep": 4}]}));
    }

    #[test]
    fn pack_must_name_the_peer_and_fit_its_clearance() {
        let scale = ClassificationScale::default();
        assert!(pack_for_peer(&sample(), &peer("internal"), &scale, "development").is_none(), "pack only allows the development domain");
        let mut pack = sample();
        pack["security"]["allowedDomains"] = json!(["development", "operations"]);
        let shown = pack_for_peer(&pack, &peer("internal"), &scale, "development").unwrap();
        assert!(shown.get("artifacts").is_none() && shown.get("workspace").is_none() && shown.get("facts").is_none());
        assert_eq!(shown["security"]["allowedDomains"], json!(["operations"]));
        somework_core::schema::validate_contract("ContextPack", &shown).unwrap();
        assert!(pack_for_peer(&pack, &peer("public"), &scale, "development").is_none(), "internal pack exceeds a public-cleared peer");
    }

    #[test]
    fn inbound_pack_is_rescoped_and_untrusted() {
        let scale = ClassificationScale::default();
        let got = pack_from_peer(&sample(), &peer("internal"), &scale, "operations").unwrap();
        assert_eq!(got["security"]["allowedDomains"], json!(["operations"]));
        assert_eq!(got["security"]["instructionsTrusted"], json!(false));
        assert_eq!(got["provenance"]["createdBy"]["id"], json!("gateway:operations"));
        somework_core::schema::validate_contract("ContextPack", &got).unwrap();
    }
}

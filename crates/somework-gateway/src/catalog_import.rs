//! Importing a peer's exported capabilities into the local catalog as `remote:<domain>/<alias>` agents.

use serde_json::{Value, json};
use somework_core::{
    Error,
    canonical::digest_json,
    contracts::{Action, ApprovalStatus, CatalogEntry, Source, SourceType, Visibility},
};
use somework_domain::{
    Ctx, Domain,
    catalog::{ApproveEntry, RegisterAgent},
};

use crate::{
    peer_client::{PeerCallError, PeerClient},
    peers::PeerRecord,
};

pub fn remote_agent_id(peer: &str, alias: &str) -> String {
    format!("remote:{peer}/{alias}")
}

/// Discovers capabilities on `peer_id` (only what the peer exports to us) and registers them locally. Entries are
/// `draft` until an administrator approves them, unless `approve` is set.
pub async fn import_peer_catalog(
    domain: &Domain,
    client: &PeerClient,
    ctx: &Ctx,
    peer_id: &str,
    query: Option<&str>,
    approve: bool,
) -> Result<Vec<CatalogEntry>, Error> {
    let peer: PeerRecord = client.peers().get(peer_id).await?.ok_or_else(|| Error::not_found("peer"))?;
    let body = json!({"query": query, "limit": 50});
    let (_, resp) = client
        .call(peer_id, reqwest::Method::POST, "/federation/v1/catalog/search", Some(&body), &[Action::CatalogRead], None, &[])
        .await
        .map_err(|e| match e {
            PeerCallError::Transient(m) => Error::unavailable(m),
            PeerCallError::Refused { status, .. } => Error::denied(format!("peer refused the catalog request ({status})")),
            PeerCallError::Local(e) => e,
        })?;
    let mut out = vec![];
    for card in resp["cards"].as_array().cloned().unwrap_or_default() {
        let alias = card["agentCard"]["agentId"].as_str().unwrap_or_default().to_string();
        let mut agent_card = card["agentCard"].clone();
        let capabilities: Vec<Value> = agent_card["capabilities"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter(|c| somework_core::classification::any_glob(&peer.policy.imports, c["id"].as_str().unwrap_or_default()))
            .collect();
        if capabilities.is_empty() {
            continue;
        }
        agent_card["capabilities"] = Value::Array(capabilities);
        agent_card["agentId"] = json!(remote_agent_id(peer_id, &alias));
        agent_card["domainId"] = json!(domain.domain_id());
        agent_card["displayName"] = json!(format!("{} ({})", alias, peer.display_name));
        agent_card["owner"] = json!({"team": peer.display_name});
        agent_card["interfaces"] = json!([{"protocol": "somework", "url": peer.gateway_url}]);
        agent_card["labels"] = json!({"somework.peer": peer_id, "somework.alias": alias});
        let digest = digest_json(&agent_card);
        let mut entry = domain
            .register_agent(
                ctx,
                RegisterAgent {
                    card: agent_card,
                    visibility: Some(Visibility::Domain),
                    source: Some(Source { kind: SourceType::Manual, uri: Some(format!("federation://{peer_id}")), digest: Some(digest) }),
                },
            )
            .await?;
        if approve {
            entry = domain
                .approve_entry(
                    ctx,
                    &entry.entry_id,
                    ApproveEntry {
                        status: Some(ApprovalStatus::Approved),
                        visibility: Some(Visibility::Domain),
                        trust_tier: Some(peer.trust_tier),
                        ..Default::default()
                    },
                )
                .await?;
        }
        out.push(entry);
    }
    Ok(out)
}

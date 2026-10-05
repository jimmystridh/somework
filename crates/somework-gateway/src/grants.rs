//! Cross-domain grants: signed with the issuing domain's key, audience-bound to one gateway, bound to the presenter's
//! mTLS certificate, short-lived and single-use (replay-controlled through the domain's jti table).

use chrono::Duration;
use somework_core::{
    Error,
    clock::{parse_ts, ts},
    contracts::{Action, ActorKind, ActorRef, AuthorizationToken, Confirmation, DelegationClaim},
    ids,
    jws::{self, TYP_GRANT},
    schema,
};
use somework_domain::Domain;

use crate::peers::PeerRecord;

pub const MAX_GRANT_SECONDS: i64 = 300;

/// Audience of grants addressed to the gateway of `domain_id`.
pub fn gateway_audience(domain_id: &str) -> String {
    format!("somework-gateway:{domain_id}")
}

pub struct GrantRequest<'a> {
    pub peer_domain_id: &'a str,
    pub task_id: Option<&'a str>,
    pub actions: &'a [Action],
    pub capabilities: &'a [String],
    pub presenter_thumbprint: Option<&'a str>,
    pub ttl: Duration,
}

/// Mints a grant that the *peer's* gateway will accept from us.
pub fn mint_grant(domain: &Domain, req: GrantRequest<'_>) -> Result<String, Error> {
    let now = domain.now();
    let ttl = req.ttl.min(Duration::seconds(MAX_GRANT_SECONDS));
    let local = domain.domain_id().to_string();
    let claims = AuthorizationToken {
        jti: ids::jti(),
        issuer: format!("domain:{local}"),
        subject: ActorRef { kind: ActorKind::Domain, id: local.clone(), domain_id: local.clone(), display_name: None },
        audience: vec![gateway_audience(req.peer_domain_id)],
        domain_id: local,
        task_id: req.task_id.map(String::from),
        actions: req.actions.to_vec(),
        capabilities: req.capabilities.to_vec(),
        resources: vec![],
        constraints: None,
        classification_max: None,
        delegation: Some(DelegationClaim { allowed: false, remaining_depth: 0 }),
        confirmation: req.presenter_thumbprint.map(|t| Confirmation { certificate_sha256: Some(t.to_string()), key_thumbprint: None }),
        policy_version: "federation".into(),
        parent_jti: None,
        issued_at: ts(now),
        not_before: ts(now),
        expires_at: ts(now + ttl),
    };
    let value = serde_json::to_value(&claims)?;
    schema::validate_contract("AuthorizationToken", &value)?;
    let (kid, key) = domain.active_signing_key()?;
    Ok(jws::sign(TYP_GRANT, &kid, &key, &value))
}

/// Verifies a grant presented by `peer` over a connection whose client certificate had `presented_thumbprint`.
/// Every failure is reported identically (`unauthenticated`) so a prober learns nothing about which check failed.
pub async fn verify_grant(domain: &Domain, peer: &PeerRecord, token: &str, presented_thumbprint: &str, required: Action) -> Result<AuthorizationToken, Error> {
    let fail = |why: &str| {
        tracing::warn!(peer = %peer.peer_domain_id, reason = why, "federation grant rejected");
        Error::unauthenticated("grant rejected")
    };
    let parsed = jws::parse(token).map_err(|_| fail("malformed"))?;
    if parsed.typ() != Some(TYP_GRANT) {
        return Err(fail("wrong token type"));
    }
    let kid = parsed.kid().ok_or_else(|| fail("no kid"))?;
    let key = peer.signing_key(kid).ok_or_else(|| fail("unknown or retired key"))?;
    parsed.verify(&jws::verifying_key_from_b64(&key.public_key).map_err(|_| fail("bad key"))?).map_err(|_| fail("bad signature"))?;
    schema::validate_contract("AuthorizationToken", &parsed.claims).map_err(|_| fail("contract"))?;
    let claims: AuthorizationToken = serde_json::from_value(parsed.claims.clone()).map_err(|_| fail("claims"))?;
    if claims.issuer != format!("domain:{}", peer.peer_domain_id) || claims.domain_id != peer.peer_domain_id {
        return Err(fail("issuer"));
    }
    if !claims.audience.contains(&gateway_audience(domain.domain_id())) {
        return Err(fail("audience"));
    }
    let (nbf, exp) = (parse_ts(&claims.not_before).ok_or_else(|| fail("nbf"))?, parse_ts(&claims.expires_at).ok_or_else(|| fail("exp"))?);
    jws::check_time_window(nbf, exp, domain.now()).map_err(|_| fail("time window"))?;
    if (exp - nbf).num_seconds() > MAX_GRANT_SECONDS + jws::LEEWAY_SECONDS {
        return Err(fail("lifetime"));
    }
    let bound = claims.confirmation.as_ref().and_then(|c| c.certificate_sha256.as_deref()).ok_or_else(|| fail("no confirmation"))?;
    if !bound.eq_ignore_ascii_case(presented_thumbprint) {
        return Err(fail("certificate binding"));
    }
    if !claims.actions.contains(&required) {
        return Err(fail("action"));
    }
    domain.consume_jti(&format!("federation:{}", peer.peer_domain_id), &claims.jti, exp).await.map_err(|_| fail("replay"))?;
    Ok(claims)
}

pub fn claims_task_id(claims: &AuthorizationToken) -> Option<&str> {
    claims.task_id.as_deref()
}

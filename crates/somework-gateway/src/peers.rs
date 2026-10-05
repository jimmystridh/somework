//! Federation peers: administrative trust relationships between domains (DOM-02/03). A peer is a domain whose
//! gateway certificate is pinned, whose signing keys verify its grants, and whose access is limited by a policy.

use std::{collections::HashSet, sync::Arc};

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use serde_json::json;
use somework_core::{
    Error, ErrorCode,
    contracts::{SideEffects, TrustTier},
    ids, jws,
};
use somework_domain::{
    Ctx, Domain,
    audit::AuditRecord,
    db::{DbResultExt, jcol, scol, scol_opt},
    policy::{AuthzRequest, Permissions},
};
use sqlx::{SqliteConnection, sqlite::SqliteRow};

pub const GATEWAY_PRINCIPAL_PREFIX: &str = "gateway:";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PeerStatus {
    Active,
    Suspended,
    Revoked,
}

impl PeerStatus {
    fn as_str(self) -> &'static str {
        match self {
            PeerStatus::Active => "active",
            PeerStatus::Suspended => "suspended",
            PeerStatus::Revoked => "revoked",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PeerKey {
    pub kid: String,
    pub public_key: String,
    #[serde(default = "active")]
    pub status: String,
}

fn active() -> String {
    "active".into()
}

/// What a peer may discover, invoke and receive. Everything defaults to the minimum.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct PeerPolicy {
    /// Capability id patterns the peer may discover and invoke here (intersected with catalog exports).
    pub exports: Vec<String>,
    /// Capability id patterns this domain may invoke on the peer.
    pub imports: Vec<String>,
    pub classification_max: Option<String>,
    pub side_effects_at_most: SideEffects,
    /// Whether result artifacts of the peer's tasks may be disclosed to it.
    pub allow_artifacts: bool,
    /// ContextPack sections accepted from, and disclosed to, this peer.
    pub context_sections: Vec<String>,
    /// Keys removed (at any depth) from task results before they leave this domain.
    pub redact_output_keys: Vec<String>,
}

impl Default for PeerPolicy {
    fn default() -> Self {
        Self {
            exports: vec![],
            imports: vec![],
            classification_max: None,
            side_effects_at_most: SideEffects::Read,
            allow_artifacts: false,
            context_sections: ["objective", "requestedContinuation", "security", "provenance", "currentState", "acceptanceCriteria"].map(String::from).to_vec(),
            redact_output_keys: vec![],
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerRecord {
    pub peer_domain_id: String,
    pub display_name: String,
    pub gateway_url: Option<String>,
    pub status: PeerStatus,
    pub trust_tier: TrustTier,
    pub client_cert_thumbprints: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server_ca_pem: Option<String>,
    pub signing_keys: Vec<PeerKey>,
    pub policy: PeerPolicy,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct AddPeer {
    pub peer_domain_id: String,
    pub display_name: Option<String>,
    pub gateway_url: Option<String>,
    pub trust_tier: Option<TrustTier>,
    pub client_cert_thumbprints: Vec<String>,
    pub server_ca_pem: Option<String>,
    pub signing_keys: Vec<PeerKey>,
    pub policy: Option<PeerPolicy>,
}

impl PeerRecord {
    fn from_row(row: &SqliteRow) -> Result<Self, Error> {
        let tier = match scol(row, "trust_tier").as_str() {
            "local" => TrustTier::Local,
            "external" => TrustTier::External,
            "untrusted" => TrustTier::Untrusted,
            _ => TrustTier::Partner,
        };
        let status = match scol(row, "status").as_str() {
            "suspended" => PeerStatus::Suspended,
            "revoked" => PeerStatus::Revoked,
            _ => PeerStatus::Active,
        };
        Ok(Self {
            peer_domain_id: scol(row, "peer_domain_id"),
            display_name: scol(row, "display_name"),
            gateway_url: scol_opt(row, "gateway_url"),
            status,
            trust_tier: tier,
            client_cert_thumbprints: serde_json::from_value(jcol(row, "client_cert_thumbprints")).unwrap_or_default(),
            server_ca_pem: scol_opt(row, "server_ca_pem"),
            signing_keys: serde_json::from_value(jcol(row, "signing_keys")).unwrap_or_default(),
            policy: serde_json::from_value(jcol(row, "policy")).unwrap_or_default(),
            created_at: scol(row, "created_at"),
            updated_at: scol(row, "updated_at"),
        })
    }

    pub fn principal_id(&self) -> String {
        format!("{GATEWAY_PRINCIPAL_PREFIX}{}", self.peer_domain_id)
    }

    pub fn is_active(&self) -> bool {
        self.status == PeerStatus::Active
    }

    pub fn classification_max(&self) -> String {
        self.policy.classification_max.clone().unwrap_or_else(|| default_classification(self.trust_tier).to_string())
    }

    pub fn signing_key(&self, kid: &str) -> Option<&PeerKey> {
        self.signing_keys.iter().find(|k| k.kid == kid && k.status == "active")
    }

    /// The gateway principal's grants: exactly the export set, bounded by tier and policy; never delegation.
    pub fn permissions(&self) -> Permissions {
        let exports = if self.trust_tier == TrustTier::Untrusted { vec![] } else { self.policy.exports.clone() };
        Permissions {
            actions: ["catalog.read", "task.submit", "task.read", "task.cancel", "artifact.read", "context.read", "context.write", "capability.invoke"]
                .map(String::from)
                .to_vec(),
            capabilities: exports,
            classification_max: Some(self.classification_max()),
            side_effects_at_most: Some(self.policy.side_effects_at_most),
            ..Default::default()
        }
    }
}

fn default_classification(tier: TrustTier) -> &'static str {
    match tier {
        TrustTier::Local | TrustTier::Partner => "internal",
        TrustTier::External | TrustTier::Untrusted => "public",
    }
}

#[derive(Clone)]
pub struct Peers {
    domain: Domain,
    pinned: Arc<RwLock<HashSet<String>>>,
}

impl Peers {
    pub fn new(domain: Domain) -> Self {
        Self { domain, pinned: Default::default() }
    }

    /// Thumbprints the TLS layer admits. Updated synchronously by every peer mutation in this process (so a revocation
    /// or a new peer is effective for the next handshake) and periodically for changes made by other processes.
    pub fn pinned(&self) -> Arc<RwLock<HashSet<String>>> {
        self.pinned.clone()
    }

    pub async fn refresh_pinned(&self) -> Result<(), Error> {
        *self.pinned.write() = self.active_thumbprints().await?.into_iter().collect();
        Ok(())
    }

    pub async fn get(&self, peer: &str) -> Result<Option<PeerRecord>, Error> {
        let row = sqlx::query("SELECT * FROM federation_peers WHERE peer_domain_id = ?").bind(peer).fetch_optional(self.domain.db.pool()).await.db()?;
        row.as_ref().map(PeerRecord::from_row).transpose()
    }

    pub async fn list(&self) -> Result<Vec<PeerRecord>, Error> {
        let rows = sqlx::query("SELECT * FROM federation_peers ORDER BY peer_domain_id").fetch_all(self.domain.db.pool()).await.db()?;
        rows.iter().map(PeerRecord::from_row).collect()
    }

    pub async fn by_thumbprint(&self, thumbprint: &str) -> Result<Option<PeerRecord>, Error> {
        Ok(self.list().await?.into_iter().find(|p| p.client_cert_thumbprints.iter().any(|t| t.eq_ignore_ascii_case(thumbprint))))
    }

    /// Thumbprints of every active peer's client certificates: the set the TLS layer admits.
    pub async fn active_thumbprints(&self) -> Result<Vec<String>, Error> {
        Ok(self.list().await?.into_iter().filter(PeerRecord::is_active).flat_map(|p| p.client_cert_thumbprints).map(|t| t.to_lowercase()).collect())
    }

    async fn ensure_principal(&self, conn: &mut SqliteConnection, peer: &PeerRecord) -> Result<(), Error> {
        let label = peer.principal_id();
        let perms = serde_json::to_string(&peer.permissions())?;
        let existing: Option<String> = sqlx::query_scalar("SELECT principal_id FROM principals WHERE domain_id = ? AND kind = 'service' AND external_id = ?")
            .bind(self.domain.domain_id())
            .bind(&label)
            .fetch_optional(&mut *conn)
            .await
            .db()?;
        match existing {
            Some(id) => {
                sqlx::query("UPDATE principals SET permissions = ?, status = ? WHERE principal_id = ?")
                    .bind(&perms)
                    .bind(if peer.is_active() { "active" } else { "disabled" })
                    .bind(id)
                    .execute(conn)
                    .await
                    .db()?;
            }
            None => {
                sqlx::query("INSERT INTO principals(principal_id, domain_id, kind, external_id, display_name, status, permissions, public_key, created_at) VALUES (?, ?, 'service', ?, ?, ?, ?, NULL, ?)")
                    .bind(ids::principal_id())
                    .bind(self.domain.domain_id())
                    .bind(&label)
                    .bind(format!("Gateway for {}", peer.display_name))
                    .bind(if peer.is_active() { "active" } else { "disabled" })
                    .bind(&perms)
                    .bind(self.domain.now_ts())
                    .execute(conn)
                    .await
                    .db()?;
            }
        }
        Ok(())
    }

    fn validate(peer: &AddPeer) -> Result<(), Error> {
        if peer.peer_domain_id.trim().is_empty() || peer.peer_domain_id.len() > 128 || peer.peer_domain_id.contains(['/', ':', ' ']) {
            return Err(Error::invalid("peerDomainId must be 1-128 characters without '/', ':' or spaces"));
        }
        for t in &peer.client_cert_thumbprints {
            if t.len() != 64 || !t.bytes().all(|b| b.is_ascii_hexdigit()) {
                return Err(Error::invalid("client certificate thumbprints must be SHA-256 hex"));
            }
        }
        for k in &peer.signing_keys {
            jws::verifying_key_from_b64(&k.public_key).map_err(|_| Error::invalid("signing key is not a base64url Ed25519 public key"))?;
        }
        Ok(())
    }

    pub async fn add(&self, ctx: &Ctx, req: AddPeer) -> Result<PeerRecord, Error> {
        let peer = self.add_inner(ctx, req).await?;
        self.refresh_pinned().await?;
        Ok(peer)
    }

    async fn add_inner(&self, ctx: &Ctx, req: AddPeer) -> Result<PeerRecord, Error> {
        self.domain
            .run(ctx, "federation.peer.add", async {
                Self::validate(&req)?;
                if req.peer_domain_id == self.domain.domain_id() {
                    return Err(Error::invalid("a domain cannot federate with itself"));
                }
                let this = self.clone();
                let ctx = ctx.clone();
                self.domain
                    .write(move |tx| {
                        Box::pin(async move {
                            let conn: &mut SqliteConnection = tx;
                            let decision = this.domain.enforce(conn, &ctx, AuthzRequest::new("federation.manage").resource(format!("peer://{}", req.peer_domain_id))).await?;
                            let now = this.domain.now_ts();
                            let tier = req.trust_tier.unwrap_or(TrustTier::Partner);
                            let tier_str = match tier {
                                TrustTier::Local => "local",
                                TrustTier::Partner => "partner",
                                TrustTier::External => "external",
                                TrustTier::Untrusted => "untrusted",
                            };
                            sqlx::query("INSERT OR IGNORE INTO domains(domain_id, kind, display_name, status, config, created_at) VALUES (?, 'peer', ?, 'active', '{}', ?)")
                                .bind(&req.peer_domain_id)
                                .bind(req.display_name.clone().unwrap_or_else(|| req.peer_domain_id.clone()))
                                .bind(&now)
                                .execute(&mut *conn)
                                .await
                                .db()?;
                            sqlx::query("INSERT INTO federation_peers(peer_domain_id, display_name, gateway_url, status, trust_tier, client_cert_thumbprints, server_ca_pem, signing_keys, policy, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)")
                                .bind(&req.peer_domain_id)
                                .bind(req.display_name.clone().unwrap_or_else(|| req.peer_domain_id.clone()))
                                .bind(&req.gateway_url)
                                .bind(tier_str)
                                .bind(serde_json::to_string(&req.client_cert_thumbprints.iter().map(|t| t.to_lowercase()).collect::<Vec<_>>())?)
                                .bind(&req.server_ca_pem)
                                .bind(serde_json::to_string(&req.signing_keys)?)
                                .bind(serde_json::to_string(&req.policy.clone().unwrap_or_default())?)
                                .bind(&now)
                                .bind(&now)
                                .execute(&mut *conn)
                                .await
                                .map_err(|e| match somework_domain::db::db_error(e) {
                                    err if err.code == ErrorCode::Conflict => Error::conflict(format!("peer {} already exists", req.peer_domain_id)),
                                    err => err,
                                })?;
                            let row = sqlx::query("SELECT * FROM federation_peers WHERE peer_domain_id = ?").bind(&req.peer_domain_id).fetch_one(&mut *conn).await.db()?;
                            let peer = PeerRecord::from_row(&row)?;
                            this.ensure_principal(conn, &peer).await?;
                            this.domain.audit(conn, &ctx, AuditRecord::new("federation.peer.add", Some(format!("peer://{}", peer.peer_domain_id)), "success").decision(&decision).detail(json!({"trustTier": tier_str, "exports": peer.policy.exports}))).await?;
                            Ok(peer)
                        })
                    })
                    .await
            })
            .await
    }

    async fn mutate<F>(&self, ctx: &Ctx, action: &'static str, peer_id: &str, detail: serde_json::Value, f: F) -> Result<PeerRecord, Error>
    where
        F: FnOnce(&mut PeerRecord) -> Result<(), Error> + Send + 'static,
    {
        let peer = self.mutate_inner(ctx, action, peer_id, detail, f).await?;
        self.refresh_pinned().await?;
        Ok(peer)
    }

    async fn mutate_inner<F>(&self, ctx: &Ctx, action: &'static str, peer_id: &str, detail: serde_json::Value, f: F) -> Result<PeerRecord, Error>
    where
        F: FnOnce(&mut PeerRecord) -> Result<(), Error> + Send + 'static,
    {
        self.domain
            .run(ctx, action, async {
                let this = self.clone();
                let ctx = ctx.clone();
                let peer_id = peer_id.to_string();
                self.domain
                    .write(move |tx| {
                        Box::pin(async move {
                            let conn: &mut SqliteConnection = tx;
                            let decision = this.domain.enforce(conn, &ctx, AuthzRequest::new("federation.manage").resource(format!("peer://{peer_id}"))).await?;
                            let row = sqlx::query("SELECT * FROM federation_peers WHERE peer_domain_id = ?").bind(&peer_id).fetch_optional(&mut *conn).await.db()?.ok_or_else(|| Error::not_found("peer"))?;
                            let mut peer = PeerRecord::from_row(&row)?;
                            if peer.status == PeerStatus::Revoked {
                                return Err(Error::new(ErrorCode::InvalidTransition, "revoked peers cannot be changed; add the peer again with new credentials"));
                            }
                            f(&mut peer)?;
                            Self::validate(&AddPeer { peer_domain_id: peer.peer_domain_id.clone(), client_cert_thumbprints: peer.client_cert_thumbprints.clone(), signing_keys: peer.signing_keys.clone(), ..Default::default() })?;
                            sqlx::query("UPDATE federation_peers SET gateway_url = ?, status = ?, trust_tier = ?, client_cert_thumbprints = ?, server_ca_pem = ?, signing_keys = ?, policy = ?, updated_at = ? WHERE peer_domain_id = ?")
                                .bind(&peer.gateway_url)
                                .bind(peer.status.as_str())
                                .bind(match peer.trust_tier { TrustTier::Local => "local", TrustTier::Partner => "partner", TrustTier::External => "external", TrustTier::Untrusted => "untrusted" })
                                .bind(serde_json::to_string(&peer.client_cert_thumbprints)?)
                                .bind(&peer.server_ca_pem)
                                .bind(serde_json::to_string(&peer.signing_keys)?)
                                .bind(serde_json::to_string(&peer.policy)?)
                                .bind(this.domain.now_ts())
                                .bind(&peer.peer_domain_id)
                                .execute(&mut *conn)
                                .await
                                .db()?;
                            this.ensure_principal(conn, &peer).await?;
                            this.domain.audit(conn, &ctx, AuditRecord::new(action, Some(format!("peer://{}", peer.peer_domain_id)), "success").decision(&decision).detail(detail)).await?;
                            let row = sqlx::query("SELECT * FROM federation_peers WHERE peer_domain_id = ?").bind(&peer.peer_domain_id).fetch_one(&mut *conn).await.db()?;
                            PeerRecord::from_row(&row)
                        })
                    })
                    .await
            })
            .await
    }

    pub async fn set_policy(&self, ctx: &Ctx, peer: &str, policy: PeerPolicy) -> Result<PeerRecord, Error> {
        self.mutate(ctx, "federation.peer.policy", peer, json!({"exports": policy.exports}), move |p| {
            p.policy = policy;
            Ok(())
        })
        .await
    }

    pub async fn set_status(&self, ctx: &Ctx, peer: &str, status: PeerStatus) -> Result<PeerRecord, Error> {
        self.mutate(ctx, "federation.peer.status", peer, json!({"status": status.as_str()}), move |p| {
            p.status = status;
            Ok(())
        })
        .await
    }

    /// Revocation is immediate: the principal is disabled and the thumbprints stop being admitted.
    pub async fn revoke(&self, ctx: &Ctx, peer: &str) -> Result<PeerRecord, Error> {
        self.set_status(ctx, peer, PeerStatus::Revoked).await
    }

    /// Adds a verification key and retires the others (rotation); old grants stop verifying at once.
    pub async fn rotate_keys(&self, ctx: &Ctx, peer: &str, new_key: PeerKey, retire_others: bool) -> Result<PeerRecord, Error> {
        self.mutate(ctx, "federation.peer.rotate_keys", peer, json!({"kid": new_key.kid, "retireOthers": retire_others}), move |p| {
            if retire_others {
                for k in &mut p.signing_keys {
                    k.status = "retired".into();
                }
            }
            p.signing_keys.retain(|k| k.kid != new_key.kid);
            p.signing_keys.push(new_key);
            Ok(())
        })
        .await
    }

    pub async fn set_client_certificates(&self, ctx: &Ctx, peer: &str, thumbprints: Vec<String>) -> Result<PeerRecord, Error> {
        self.mutate(ctx, "federation.peer.certificates", peer, json!({"count": thumbprints.len()}), move |p| {
            p.client_cert_thumbprints = thumbprints.into_iter().map(|t| t.to_lowercase()).collect();
            Ok(())
        })
        .await
    }

    pub async fn set_gateway(&self, ctx: &Ctx, peer: &str, url: Option<String>, server_ca_pem: Option<String>) -> Result<PeerRecord, Error> {
        self.mutate(ctx, "federation.peer.gateway", peer, json!({"url": url}), move |p| {
            p.gateway_url = url;
            p.server_ca_pem = server_ca_pem;
            Ok(())
        })
        .await
    }
}

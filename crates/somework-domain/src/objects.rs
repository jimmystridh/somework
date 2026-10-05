//! Artifact byte storage abstraction. Agents never receive permanent object-store credentials (ART-02): the domain
//! service hands out short-lived upload/download URLs produced by an [`ObjectStore`].
//!
//! Implementations: [`FsObjectStore`] (local disk, URLs served and verified by the API) and `S3ObjectStore`
//! (S3/MinIO presigned URLs, in the `somework-s3` module of the API crate).

use std::{collections::BTreeMap, path::PathBuf, sync::Arc, time::Duration};

use async_trait::async_trait;
use hmac::{Hmac, KeyInit, Mac};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use somework_core::{Error, ErrorCode, jws};
use tokio::io::AsyncReadExt;

type HmacSha256 = Hmac<Sha256>;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PartUrl {
    pub part_number: u32,
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MultipartPlan {
    pub part_size: u64,
    pub parts: Vec<PartUrl>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PutPlan {
    pub method: String,
    pub url: String,
    pub headers: BTreeMap<String, String>,
    pub multipart: Option<MultipartPlan>,
    /// Opaque, store specific state persisted with the artifact (e.g. a multipart upload id).
    #[serde(skip_serializing, default)]
    pub state: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletedPart {
    pub part_number: u32,
    pub etag: String,
}

#[derive(Debug, Clone)]
pub struct ObjectDigest {
    pub size: u64,
    pub sha256_hex: String,
}

#[async_trait]
pub trait ObjectStore: Send + Sync + 'static {
    fn kind(&self) -> &'static str;
    async fn plan_upload(&self, key: &str, size: u64, media_type: &str, expires_in: Duration) -> Result<PutPlan, Error>;
    /// Called by CompleteUpload before verification; finalizes multipart uploads.
    async fn finish_upload(&self, key: &str, state: &Value, parts: &[CompletedPart]) -> Result<(), Error>;
    /// Reads the stored object and computes its SHA-256. `Ok(None)` when no object exists.
    async fn digest(&self, key: &str) -> Result<Option<ObjectDigest>, Error>;
    async fn presign_get(&self, key: &str, expires_in: Duration, filename: Option<&str>) -> Result<String, Error>;
    async fn delete(&self, key: &str) -> Result<(), Error>;
    async fn healthy(&self) -> bool {
        true
    }
}

pub fn storage_key(domain_id: &str, artifact_id: &str, version: u64) -> String {
    format!("{domain_id}/{artifact_id}/v{version}")
}

// ---- local filesystem store ---------------------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
struct FsGrant {
    key: String,
    method: String,
    exp: i64,
    filename: Option<String>,
}

#[derive(Clone)]
pub struct FsObjectStore {
    root: PathBuf,
    public_url: String,
    secret: Arc<[u8; 32]>,
    clock: somework_core::clock::SharedClock,
}

impl FsObjectStore {
    pub fn new(root: impl Into<PathBuf>, public_url: impl Into<String>, secret: [u8; 32], clock: somework_core::clock::SharedClock) -> std::io::Result<Self> {
        let root = root.into();
        std::fs::create_dir_all(&root)?;
        Ok(Self { root, public_url: public_url.into().trim_end_matches('/').to_string(), secret: Arc::new(secret), clock })
    }

    fn path_for(&self, key: &str) -> Result<PathBuf, Error> {
        if key.split('/').any(|p| p.is_empty() || p == "." || p == "..") {
            return Err(Error::invalid("invalid storage key"));
        }
        Ok(self.root.join(key))
    }

    fn sign(&self, grant: &FsGrant) -> String {
        let payload = jws::b64(serde_json::to_string(grant).expect("grant serializes").as_bytes());
        let mut mac = HmacSha256::new_from_slice(self.secret.as_slice()).expect("HMAC accepts any key length");
        mac.update(payload.as_bytes());
        format!("{payload}.{}", jws::b64(&mac.finalize().into_bytes()))
    }

    fn verify(&self, token: &str, method: &str) -> Result<FsGrant, Error> {
        let (payload, sig) = token.split_once('.').ok_or_else(|| Error::unauthenticated("malformed object grant"))?;
        let mut mac = HmacSha256::new_from_slice(self.secret.as_slice()).expect("HMAC accepts any key length");
        mac.update(payload.as_bytes());
        mac.verify_slice(&jws::unb64(sig)?).map_err(|_| Error::unauthenticated("object grant signature is invalid"))?;
        let grant: FsGrant = serde_json::from_slice(&jws::unb64(payload)?)?;
        if grant.method != method {
            return Err(Error::unauthenticated("object grant is for a different method"));
        }
        if self.clock.now().timestamp() > grant.exp {
            return Err(Error::new(ErrorCode::Expired, "object grant has expired"));
        }
        Ok(grant)
    }

    /// Handles a presigned PUT. Overwriting an existing object is refused: artifact versions are immutable.
    pub async fn put_with_grant(&self, token: &str, body: Vec<u8>) -> Result<(), Error> {
        let grant = self.verify(token, "PUT")?;
        let path = self.path_for(&grant.key)?;
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent).await.map_err(|e| Error::internal(format!("create dir: {e}")))?;
        }
        let tmp = path.with_extension(format!("part-{}", jws::b64(&rand::random::<[u8; 6]>())));
        tokio::fs::write(&tmp, &body).await.map_err(|e| Error::internal(format!("write object: {e}")))?;
        if tokio::fs::try_exists(&path).await.unwrap_or(false) {
            let _ = tokio::fs::remove_file(&tmp).await;
            return Err(Error::conflict("object already exists; artifact versions are immutable"));
        }
        tokio::fs::rename(&tmp, &path).await.map_err(|e| Error::internal(format!("commit object: {e}")))?;
        Ok(())
    }

    pub async fn get_with_grant(&self, token: &str) -> Result<(Vec<u8>, Option<String>), Error> {
        let grant = self.verify(token, "GET")?;
        let bytes = tokio::fs::read(self.path_for(&grant.key)?).await.map_err(|_| Error::not_found("object"))?;
        Ok((bytes, grant.filename))
    }
}

#[async_trait]
impl ObjectStore for FsObjectStore {
    fn kind(&self) -> &'static str {
        "fs"
    }

    async fn plan_upload(&self, key: &str, _size: u64, _media_type: &str, expires_in: Duration) -> Result<PutPlan, Error> {
        self.path_for(key)?;
        let grant = FsGrant { key: key.into(), method: "PUT".into(), exp: self.clock.now().timestamp() + expires_in.as_secs() as i64, filename: None };
        Ok(PutPlan {
            method: "PUT".into(),
            url: format!("{}/v1/objects/{}", self.public_url, self.sign(&grant)),
            headers: BTreeMap::new(),
            multipart: None,
            state: json!({}),
        })
    }

    async fn finish_upload(&self, _key: &str, _state: &Value, _parts: &[CompletedPart]) -> Result<(), Error> {
        Ok(())
    }

    async fn digest(&self, key: &str) -> Result<Option<ObjectDigest>, Error> {
        let path = self.path_for(key)?;
        let mut file = match tokio::fs::File::open(&path).await {
            Ok(f) => f,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(Error::unavailable(format!("object store unavailable: {e}"))),
        };
        let mut hasher = Sha256::new();
        let mut buf = vec![0u8; 256 * 1024];
        let mut size = 0u64;
        loop {
            let n = file.read(&mut buf).await.map_err(|e| Error::unavailable(format!("read object: {e}")))?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
            size += n as u64;
        }
        Ok(Some(ObjectDigest { size, sha256_hex: hex::encode(hasher.finalize()) }))
    }

    async fn presign_get(&self, key: &str, expires_in: Duration, filename: Option<&str>) -> Result<String, Error> {
        self.path_for(key)?;
        let grant = FsGrant {
            key: key.into(),
            method: "GET".into(),
            exp: self.clock.now().timestamp() + expires_in.as_secs() as i64,
            filename: filename.map(String::from),
        };
        Ok(format!("{}/v1/objects/{}", self.public_url, self.sign(&grant)))
    }

    async fn delete(&self, key: &str) -> Result<(), Error> {
        let _ = tokio::fs::remove_file(self.path_for(key)?).await;
        Ok(())
    }

    async fn healthy(&self) -> bool {
        tokio::fs::metadata(&self.root).await.is_ok()
    }
}

impl crate::Domain {
    pub fn set_object_store(&self, store: Arc<dyn ObjectStore>) {
        *self.objects.write() = Some(store);
    }

    pub fn object_store(&self) -> Result<Arc<dyn ObjectStore>, Error> {
        self.objects.read().clone().ok_or_else(|| Error::unavailable("object store is not configured"))
    }
}

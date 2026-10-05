//! S3/MinIO object store (presigned SigV4 URLs, multipart uploads). Implemented in the S3 work package.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct S3Config {
    pub endpoint: String,
    pub region: String,
    pub bucket: String,
    pub access_key: String,
    pub secret_key: String,
    #[serde(default = "default_true")]
    pub path_style: bool,
    /// Objects larger than this use multipart uploads with presigned part URLs.
    #[serde(default = "default_part_size")]
    pub multipart_threshold_bytes: u64,
    #[serde(default = "default_part_size")]
    pub part_size_bytes: u64,
}

fn default_true() -> bool {
    true
}

fn default_part_size() -> u64 {
    64 * 1024 * 1024
}

use std::{collections::BTreeMap, time::Duration};

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use hmac::{Hmac, KeyInit, Mac};
use reqwest::{Method, StatusCode};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use somework_core::{Error, ErrorCode, clock::SharedClock};
use url::Url;

use crate::objects::{CompletedPart, MultipartPlan, ObjectDigest, ObjectStore, PartUrl, PutPlan};

type HmacSha256 = Hmac<Sha256>;

const UNSIGNED_PAYLOAD: &str = "UNSIGNED-PAYLOAD";
const MAX_PRESIGN_SECONDS: u64 = 7 * 24 * 3600;
const MAX_PARTS: u64 = 10_000;

/// S3/MinIO store. Agents only ever receive presigned URLs; the access key and secret never leave this struct.
pub struct S3ObjectStore {
    cfg: S3Config,
    clock: SharedClock,
    http: reqwest::Client,
    endpoint: Url,
}

fn hmac(key: &[u8], data: &str) -> Vec<u8> {
    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC accepts any key length");
    mac.update(data.as_bytes());
    mac.finalize().into_bytes().to_vec()
}

fn uri_encode(raw: &str, encode_slash: bool) -> String {
    let mut out = String::with_capacity(raw.len());
    for b in raw.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            b'/' if !encode_slash => out.push('/'),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn canonical_query(params: &[(String, String)]) -> String {
    let mut encoded: Vec<(String, String)> = params.iter().map(|(k, v)| (uri_encode(k, true), uri_encode(v, true))).collect();
    encoded.sort();
    encoded.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join("&")
}

fn xml_text<'a>(xml: &'a str, tag: &str) -> Option<&'a str> {
    let open = format!("<{tag}>");
    let start = xml.find(&open)? + open.len();
    let end = xml[start..].find(&format!("</{tag}>"))? + start;
    Some(&xml[start..end])
}

fn unavailable(what: impl std::fmt::Display) -> Error {
    Error::unavailable(format!("object store unavailable: {what}"))
}

struct Signed {
    url: String,
    headers: BTreeMap<String, String>,
}

impl S3ObjectStore {
    pub fn new(cfg: S3Config, clock: SharedClock) -> Result<Self, Error> {
        let endpoint = Url::parse(&cfg.endpoint).map_err(|e| Error::invalid(format!("invalid S3 endpoint: {e}")))?;
        if endpoint.host_str().is_none() {
            return Err(Error::invalid("S3 endpoint has no host"));
        }
        if cfg.part_size_bytes < 5 * 1024 * 1024 && cfg.multipart_threshold_bytes < u64::MAX {
            tracing::warn!("S3 multipart parts below 5 MiB are rejected by most S3 implementations");
        }
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(300))
            .connect_timeout(Duration::from_secs(5))
            .build()
            .map_err(|e| Error::internal(format!("http client: {e}")))?;
        Ok(Self { cfg, clock, http, endpoint })
    }

    fn host(&self) -> String {
        let host = self.endpoint.host_str().unwrap_or_default();
        let host = if self.cfg.path_style { host.to_string() } else { format!("{}.{host}", self.cfg.bucket) };
        match self.endpoint.port() {
            Some(port) => format!("{host}:{port}"),
            None => host,
        }
    }

    fn path(&self, key: Option<&str>) -> String {
        let key = key.map(|k| uri_encode(k, false));
        match (self.cfg.path_style, key) {
            (true, Some(k)) => format!("/{}/{k}", self.cfg.bucket),
            (true, None) => format!("/{}", self.cfg.bucket),
            (false, Some(k)) => format!("/{k}"),
            (false, None) => "/".into(),
        }
    }

    fn scope(&self, now: DateTime<Utc>) -> String {
        format!("{}/{}/s3/aws4_request", now.format("%Y%m%d"), self.cfg.region)
    }

    fn signing_key(&self, now: DateTime<Utc>) -> Vec<u8> {
        let k = hmac(format!("AWS4{}", self.cfg.secret_key).as_bytes(), &now.format("%Y%m%d").to_string());
        let k = hmac(&k, &self.cfg.region);
        let k = hmac(&k, "s3");
        hmac(&k, "aws4_request")
    }

    fn canonical_headers(headers: &BTreeMap<String, String>) -> (String, String) {
        let canonical: String = headers.iter().map(|(k, v)| format!("{k}:{}\n", v.trim())).collect();
        let names = headers.keys().cloned().collect::<Vec<_>>().join(";");
        (canonical, names)
    }

    /// Query-string presigned URL: the credential in it is the (derived) signature, never the secret key.
    fn presign(&self, method: &str, key: &str, query: &[(&str, &str)], signed: &[(&str, &str)], expires: Duration) -> Signed {
        let now = self.clock.now();
        let amz_date = now.format("%Y%m%dT%H%M%SZ").to_string();
        let expires = expires.as_secs().clamp(1, MAX_PRESIGN_SECONDS);
        let mut headers: BTreeMap<String, String> = BTreeMap::new();
        headers.insert("host".into(), self.host());
        for (k, v) in signed {
            headers.insert(k.to_lowercase(), v.to_string());
        }
        let (canonical_headers, signed_names) = Self::canonical_headers(&headers);
        let mut params: Vec<(String, String)> = query.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        params.push(("X-Amz-Algorithm".into(), "AWS4-HMAC-SHA256".into()));
        params.push(("X-Amz-Credential".into(), format!("{}/{}", self.cfg.access_key, self.scope(now))));
        params.push(("X-Amz-Date".into(), amz_date.clone()));
        params.push(("X-Amz-Expires".into(), expires.to_string()));
        params.push(("X-Amz-SignedHeaders".into(), signed_names.clone()));
        let query_string = canonical_query(&params);
        let path = self.path(Some(key));
        let canonical_request = format!("{method}\n{path}\n{query_string}\n{canonical_headers}\n{signed_names}\n{UNSIGNED_PAYLOAD}");
        let string_to_sign = format!("AWS4-HMAC-SHA256\n{amz_date}\n{}\n{}", self.scope(now), hex::encode(Sha256::digest(canonical_request.as_bytes())));
        let signature = hex::encode(hmac(&self.signing_key(now), &string_to_sign));
        let host = self.host();
        Signed {
            url: format!("{}://{host}{path}?{query_string}&X-Amz-Signature={signature}", self.endpoint.scheme()),
            headers: signed.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
        }
    }

    /// Header-signed request for server-side calls (HEAD/GET/DELETE/multipart control/bucket ops).
    async fn call(&self, method: Method, key: Option<&str>, query: &[(&str, &str)], body: Vec<u8>, extra: &[(&str, &str)]) -> Result<reqwest::Response, Error> {
        let now = self.clock.now();
        let amz_date = now.format("%Y%m%dT%H%M%SZ").to_string();
        let payload_hash = hex::encode(Sha256::digest(&body));
        let mut headers: BTreeMap<String, String> = BTreeMap::new();
        headers.insert("host".into(), self.host());
        headers.insert("x-amz-content-sha256".into(), payload_hash.clone());
        headers.insert("x-amz-date".into(), amz_date.clone());
        for (k, v) in extra {
            headers.insert(k.to_lowercase(), v.to_string());
        }
        let (canonical_headers, signed_names) = Self::canonical_headers(&headers);
        let params: Vec<(String, String)> = query.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        let query_string = canonical_query(&params);
        let path = self.path(key);
        let canonical_request = format!("{}\n{path}\n{query_string}\n{canonical_headers}\n{signed_names}\n{payload_hash}", method.as_str());
        let string_to_sign = format!("AWS4-HMAC-SHA256\n{amz_date}\n{}\n{}", self.scope(now), hex::encode(Sha256::digest(canonical_request.as_bytes())));
        let signature = hex::encode(hmac(&self.signing_key(now), &string_to_sign));
        let authorization =
            format!("AWS4-HMAC-SHA256 Credential={}/{}, SignedHeaders={signed_names}, Signature={signature}", self.cfg.access_key, self.scope(now));
        let url = if query_string.is_empty() {
            format!("{}://{}{path}", self.endpoint.scheme(), self.host())
        } else {
            format!("{}://{}{path}?{query_string}", self.endpoint.scheme(), self.host())
        };
        let mut req =
            self.http.request(method, url).header("x-amz-date", amz_date).header("x-amz-content-sha256", payload_hash).header("authorization", authorization);
        for (k, v) in extra {
            req = req.header(*k, *v);
        }
        if !body.is_empty() {
            req = req.body(body);
        }
        req.send().await.map_err(unavailable)
    }

    async fn classify(&self, resp: reqwest::Response, what: &str) -> Error {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        let code = xml_text(&body, "Code").unwrap_or("");
        if status.is_server_error() || status == StatusCode::TOO_MANY_REQUESTS {
            return unavailable(format!("{what}: {status} {code}"));
        }
        if status == StatusCode::FORBIDDEN || status == StatusCode::UNAUTHORIZED {
            return Error::internal(format!("{what}: the object store rejected the service credentials ({code})"));
        }
        if status == StatusCode::PRECONDITION_FAILED {
            return Error::conflict(format!("{what}: object already exists; artifact versions are immutable"));
        }
        Error::internal(format!("{what}: unexpected response {status} {code}"))
    }

    /// Creates the bucket (used by provisioning and tests). Succeeds when it already exists.
    pub async fn create_bucket(&self) -> Result<(), Error> {
        let resp = self.call(Method::PUT, None, &[], vec![], &[]).await?;
        if resp.status().is_success() {
            return Ok(());
        }
        let body = resp.text().await.unwrap_or_default();
        if body.contains("BucketAlreadyOwnedByYou") || body.contains("BucketAlreadyExists") {
            return Ok(());
        }
        Err(Error::internal(format!("create bucket failed: {body}")))
    }

    async fn head(&self, key: &str) -> Result<Option<u64>, Error> {
        let resp = self.call(Method::HEAD, Some(key), &[], vec![], &[]).await?;
        match resp.status() {
            s if s.is_success() => Ok(Some(resp.headers().get("content-length").and_then(|v| v.to_str().ok()).and_then(|v| v.parse().ok()).unwrap_or(0))),
            StatusCode::NOT_FOUND => Ok(None),
            _ => Err(self.classify(resp, "HEAD object").await),
        }
    }

    fn effective_part_size(&self, size: u64) -> u64 {
        self.cfg.part_size_bytes.max(size.div_ceil(MAX_PARTS)).max(1)
    }
}

#[async_trait]
impl ObjectStore for S3ObjectStore {
    fn kind(&self) -> &'static str {
        "s3"
    }

    async fn plan_upload(&self, key: &str, size: u64, _media_type: &str, expires_in: Duration) -> Result<PutPlan, Error> {
        if size <= self.cfg.multipart_threshold_bytes {
            let signed = self.presign("PUT", key, &[], &[("if-none-match", "*")], expires_in);
            let mut headers = BTreeMap::new();
            headers.extend(signed.headers);
            return Ok(PutPlan {
                method: "PUT".into(),
                url: signed.url,
                headers: headers.into_iter().map(|(k, v)| (if k == "if-none-match" { "If-None-Match".to_string() } else { k }, v)).collect(),
                multipart: None,
                state: json!({}),
            });
        }
        let resp = self.call(Method::POST, Some(key), &[("uploads", "")], vec![], &[]).await?;
        if !resp.status().is_success() {
            return Err(self.classify(resp, "create multipart upload").await);
        }
        let body = resp.text().await.map_err(unavailable)?;
        let upload_id = xml_text(&body, "UploadId").ok_or_else(|| Error::internal("multipart response carried no UploadId"))?.to_string();
        let part_size = self.effective_part_size(size);
        let count = size.div_ceil(part_size);
        let parts = (1..=count)
            .map(|n| {
                let number = n.to_string();
                PartUrl {
                    part_number: n as u32,
                    url: self.presign("PUT", key, &[("partNumber", number.as_str()), ("uploadId", upload_id.as_str())], &[], expires_in).url,
                }
            })
            .collect();
        Ok(PutPlan {
            method: "PUT".into(),
            url: String::new(),
            headers: BTreeMap::new(),
            multipart: Some(MultipartPlan { part_size, parts }),
            state: json!({"uploadId": upload_id, "parts": count}),
        })
    }

    async fn finish_upload(&self, key: &str, state: &Value, parts: &[CompletedPart]) -> Result<(), Error> {
        let Some(upload_id) = state.get("uploadId").and_then(Value::as_str) else { return Ok(()) };
        let expected = state.get("parts").and_then(Value::as_u64).unwrap_or(0);
        if parts.len() as u64 != expected {
            return Err(Error::new(ErrorCode::ValidationFailed, format!("expected {expected} completed parts, got {}", parts.len())));
        }
        let mut sorted: Vec<&CompletedPart> = parts.iter().collect();
        sorted.sort_by_key(|p| p.part_number);
        let mut body = String::from("<CompleteMultipartUpload>");
        for p in sorted {
            body.push_str(&format!("<Part><PartNumber>{}</PartNumber><ETag>\"{}\"</ETag></Part>", p.part_number, p.etag.trim_matches('"')));
        }
        body.push_str("</CompleteMultipartUpload>");
        let resp = self.call(Method::POST, Some(key), &[("uploadId", upload_id)], body.into_bytes(), &[("if-none-match", "*")]).await?;
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        if status.is_success() && !text.contains("<Error>") {
            return Ok(());
        }
        if text.contains("NoSuchUpload") && self.head(key).await?.is_some() {
            return Ok(()); // an earlier attempt already finalized the upload
        }
        if status == StatusCode::PRECONDITION_FAILED {
            return Err(Error::conflict("object already exists; artifact versions are immutable"));
        }
        if status.is_server_error() {
            return Err(unavailable(format!("complete multipart upload: {status}")));
        }
        Err(Error::new(ErrorCode::IntegrityFailure, format!("multipart completion was rejected: {}", xml_text(&text, "Code").unwrap_or("unknown error"))))
    }

    async fn digest(&self, key: &str) -> Result<Option<ObjectDigest>, Error> {
        if self.head(key).await?.is_none() {
            return Ok(None);
        }
        let mut resp = self.call(Method::GET, Some(key), &[], vec![], &[]).await?;
        match resp.status() {
            s if s.is_success() => {}
            StatusCode::NOT_FOUND => return Ok(None),
            _ => return Err(self.classify(resp, "GET object").await),
        }
        let mut hasher = Sha256::new();
        let mut size = 0u64;
        while let Some(chunk) = resp.chunk().await.map_err(unavailable)? {
            hasher.update(&chunk);
            size += chunk.len() as u64;
        }
        Ok(Some(ObjectDigest { size, sha256_hex: hex::encode(hasher.finalize()) }))
    }

    async fn presign_get(&self, key: &str, expires_in: Duration, filename: Option<&str>) -> Result<String, Error> {
        let disposition = filename.map(|n| {
            let safe: String = n.chars().filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_')).collect();
            format!("attachment; filename=\"{safe}\"")
        });
        let query: Vec<(&str, &str)> = disposition.as_deref().map(|d| vec![("response-content-disposition", d)]).unwrap_or_default();
        Ok(self.presign("GET", key, &query, &[], expires_in).url)
    }

    async fn delete(&self, key: &str) -> Result<(), Error> {
        let resp = self.call(Method::DELETE, Some(key), &[], vec![], &[]).await?;
        if !resp.status().is_success() && resp.status() != StatusCode::NOT_FOUND {
            return Err(self.classify(resp, "DELETE object").await);
        }
        // abort multipart uploads that never completed so they do not accrue storage
        let prefix = key.to_string();
        let resp = self.call(Method::GET, None, &[("uploads", ""), ("prefix", prefix.as_str())], vec![], &[]).await?;
        if resp.status().is_success() {
            let xml = resp.text().await.unwrap_or_default();
            for upload in xml.split("<Upload>").skip(1) {
                if let (Some(k), Some(id)) = (xml_text(upload, "Key"), xml_text(upload, "UploadId"))
                    && k == key
                {
                    let _ = self.call(Method::DELETE, Some(key), &[("uploadId", id)], vec![], &[]).await;
                }
            }
        }
        Ok(())
    }

    async fn healthy(&self) -> bool {
        match self.call(Method::HEAD, None, &[], vec![], &[]).await {
            Ok(resp) => resp.status().is_success(),
            Err(_) => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use chrono::TimeZone;
    use somework_core::clock::ManualClock;

    use super::*;

    fn aws_example_store() -> S3ObjectStore {
        let clock = ManualClock::new(Utc.with_ymd_and_hms(2013, 5, 24, 0, 0, 0).unwrap());
        S3ObjectStore::new(
            S3Config {
                endpoint: "https://s3.amazonaws.com".into(),
                region: "us-east-1".into(),
                bucket: "examplebucket".into(),
                access_key: "AKIAIOSFODNN7EXAMPLE".into(),
                secret_key: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY".into(),
                path_style: false,
                multipart_threshold_bytes: u64::MAX,
                part_size_bytes: 5 * 1024 * 1024,
            },
            Arc::new(clock),
        )
        .unwrap()
    }

    /// The presigned GET example from the AWS Signature Version 4 documentation.
    #[tokio::test]
    async fn presigned_get_matches_the_aws_documentation_vector() {
        let url = aws_example_store().presign("GET", "test.txt", &[], &[], Duration::from_secs(86400)).url;
        assert!(url.starts_with("https://examplebucket.s3.amazonaws.com/test.txt?"));
        assert!(url.ends_with("X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404"), "{url}");
    }

    #[test]
    fn presigned_urls_never_contain_the_secret_key() {
        let store = aws_example_store();
        let put = store.presign("PUT", "k", &[("partNumber", "2"), ("uploadId", "abc/def")], &[("if-none-match", "*")], Duration::from_secs(60)).url;
        assert!(!put.contains("wJalrXUtnFEMI"));
        assert!(put.contains("uploadId=abc%2Fdef") && put.contains("partNumber=2"));
        assert!(put.contains("X-Amz-SignedHeaders=host%3Bif-none-match"));
    }

    #[test]
    fn xml_helpers_extract_ids() {
        let xml = "<InitiateMultipartUploadResult><Bucket>b</Bucket><UploadId>up-1</UploadId></InitiateMultipartUploadResult>";
        assert_eq!(xml_text(xml, "UploadId"), Some("up-1"));
        assert_eq!(xml_text(xml, "Missing"), None);
    }
}

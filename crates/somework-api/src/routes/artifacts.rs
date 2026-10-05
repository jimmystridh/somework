use axum::{
    Router,
    body::Bytes,
    extract::{Path, Query, State},
    http::{StatusCode, header},
    response::IntoResponse,
    routing::{get, post, put},
};
use serde::Deserialize;
use somework_domain::artifacts::{BeginUpload, CompleteUpload, DownloadRequest};

use crate::{http::*, state::AppState};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/v1/artifacts/uploads", post(begin))
        .route("/v1/artifacts/{id}/complete", post(complete))
        .route("/v1/artifacts/{id}/{version}", get(metadata))
        .route("/v1/artifacts/{id}/{version}/download-grants", post(download_grant))
        .route("/v1/objects/{grant}", put(object_put).get(object_get))
}

async fn begin(State(s): State<AppState>, Auth(ctx): Auth, Body(req): Body<BeginUpload>) -> ApiResult {
    created(s.domain.begin_artifact_upload(&ctx, req).await?)
}

async fn complete(State(s): State<AppState>, Auth(ctx): Auth, Path(id): Path<String>, Body(req): Body<CompleteUpload>) -> ApiResult {
    ok(s.domain.complete_artifact_upload(&ctx, &id, req).await?)
}

#[derive(Deserialize)]
struct MetaQuery {
    #[serde(rename = "taskId")]
    task_id: Option<String>,
}

async fn metadata(State(s): State<AppState>, Auth(ctx): Auth, Path((id, version)): Path<(String, u64)>, Query(q): Query<MetaQuery>) -> ApiResult {
    ok(s.domain.get_artifact(&ctx, &id, version, q.task_id.as_deref()).await?)
}

async fn download_grant(State(s): State<AppState>, Auth(ctx): Auth, Path((id, version)): Path<(String, u64)>, Body(req): Body<DownloadRequest>) -> ApiResult {
    created(s.domain.artifact_download_grant(&ctx, &id, version, req).await?)
}

/// Presigned PUT for the local filesystem object store. The grant itself is the credential (short-lived, signed).
async fn object_put(State(s): State<AppState>, Path(grant): Path<String>, body: Bytes) -> ApiResult {
    let fs = s.fs_store.as_ref().ok_or_else(|| somework_core::Error::not_found("object endpoint"))?;
    fs.put_with_grant(&grant, body.to_vec()).await?;
    Ok(StatusCode::CREATED.into_response())
}

async fn object_get(State(s): State<AppState>, Path(grant): Path<String>) -> ApiResult {
    let fs = s.fs_store.as_ref().ok_or_else(|| somework_core::Error::not_found("object endpoint"))?;
    let (bytes, filename) = fs.get_with_grant(&grant).await?;
    let mut response = ([(header::CONTENT_TYPE, "application/octet-stream")], bytes).into_response();
    if let Some(name) = filename {
        let safe: String = name.chars().filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_')).collect();
        if let Ok(v) = header::HeaderValue::from_str(&format!("attachment; filename=\"{safe}\"")) {
            response.headers_mut().insert(header::CONTENT_DISPOSITION, v);
        }
    }
    Ok(response)
}

use std::{net::SocketAddr, sync::Arc};

use axum::{
    Router,
    body::Bytes,
    extract::State,
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::post,
};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio_util::sync::CancellationToken;

use super::McpServer;

/// Newline-delimited JSON-RPC over stdin/stdout. Diagnostics go to stderr only.
pub async fn serve_stdio(server: Arc<McpServer>) -> anyhow::Result<()> {
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let writer = tokio::spawn(async move {
        let mut out = tokio::io::stdout();
        while let Some(line) = rx.recv().await {
            if out.write_all(line.as_bytes()).await.is_err() || out.write_all(b"\n").await.is_err() || out.flush().await.is_err() {
                break;
            }
        }
    });
    while let Some(line) = lines.next_line().await? {
        if line.trim().is_empty() {
            continue;
        }
        let server = server.clone();
        let tx = tx.clone();
        tokio::spawn(async move {
            let reply = match serde_json::from_str::<Value>(&line) {
                Ok(Value::Array(batch)) => {
                    let mut out = vec![];
                    for m in batch {
                        if let Some(r) = server.handle(m).await {
                            out.push(r);
                        }
                    }
                    if out.is_empty() { None } else { Some(Value::Array(out)) }
                }
                Ok(message) => server.handle(message).await,
                Err(e) => Some(json!({"jsonrpc": "2.0", "id": null, "error": {"code": -32700, "message": format!("parse error: {e}")}})),
            };
            if let Some(reply) = reply {
                let _ = tx.send(reply.to_string());
            }
        });
    }
    drop(tx);
    let _ = writer.await;
    Ok(())
}

async fn post_mcp(State(server): State<Arc<McpServer>>, headers: HeaderMap, body: Bytes) -> Response {
    // DNS-rebinding protection: only local origins may talk to a localhost MCP endpoint.
    if let Some(origin) = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()) {
        let host = origin.split("://").nth(1).unwrap_or(origin);
        if !(host.starts_with("localhost") || host.starts_with("127.0.0.1") || host.starts_with("[::1]")) {
            return StatusCode::FORBIDDEN.into_response();
        }
    }
    let message: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                axum::Json(json!({"jsonrpc": "2.0", "id": null, "error": {"code": -32700, "message": format!("parse error: {e}")}})),
            )
                .into_response();
        }
    };
    match server.handle(message).await {
        Some(reply) => axum::Json(reply).into_response(),
        None => StatusCode::ACCEPTED.into_response(),
    }
}

async fn method_not_allowed() -> Response {
    StatusCode::METHOD_NOT_ALLOWED.into_response()
}

pub fn http_router(server: Arc<McpServer>) -> Router {
    Router::new().route("/mcp", post(post_mcp).get(method_not_allowed).delete(|| async { StatusCode::OK })).with_state(server)
}

/// Serves MCP on a loopback address; returns the bound address.
pub async fn serve_http(server: Arc<McpServer>, listen: &str, shutdown: CancellationToken) -> anyhow::Result<SocketAddr> {
    let addr: SocketAddr = listen.parse()?;
    anyhow::ensure!(addr.ip().is_loopback(), "the MCP HTTP endpoint must bind a loopback address");
    let listener = tokio::net::TcpListener::bind(addr).await?;
    let local = listener.local_addr()?;
    tokio::spawn(async move {
        let _ = axum::serve(listener, http_router(server)).with_graceful_shutdown(async move { shutdown.cancelled().await }).await;
    });
    Ok(local)
}

# SomeWork

SomeWork ("Samverka", badly translated) is an agent collaboration platform: agents discover each other by capability,
exchange typed messages, run durable tasks with leases and fencing, hand over context as typed ContextPacks, share
immutable artifacts, and cooperate across trust domains — with humans watching and joining through Matrix and an
operations console. It implements `spec.md` on **SQLite** (the spec's PostgreSQL role is played by a single-writer
WAL database; see `docs/ARCHITECTURE.md`).

```
Matrix (humans)  ◄─ projection ─┐                     ┌─► NATS / JetStream (outbound-only agent delivery)
Ops UI (/ui)     ◄── REST/SSE ──┼── Domain Service ───┤
Sidecar + MCP    ──► REST/gRPC ─┘   (SQLite canonical) └─► S3 / MinIO (artifacts) · A2A / mTLS gateway (other domains)
```

## Quick start

```bash
scripts/fetch-tools.sh                      # real nats-server + minio binaries for the integration tests
cargo build --workspace
cargo run -p somework-api -- admin --config somework.toml bootstrap --key-out root.key.json
cargo run -p somework-api -- serve --config somework.toml
open http://127.0.0.1:8080/ui/
```

Minimal `somework.toml`:

```toml
[domain]
id = "development"
db = "data/somework.db"
listen = "127.0.0.1:8080"
public_url = "http://127.0.0.1:8080"

[objects]
dir = "data/objects"

[ui]
dir = "ui"
```

Optional sections: `[nats]`, `[matrix]`, `[gateway]`, `[grpc]`, `[objects.s3]`, `[[oidc]]` — see the per-plane docs.

See `docs/QUICKSTART.md` for running it and connecting an agent (worker or MCP client).

## Layout and docs

| Document | Topic |
|---|---|
| `docs/ARCHITECTURE.md` | canonical-state rule, SQLite adaptations, trust model |
| `docs/CONVENTIONS.md` | crate map, rules, migrations, how to run things |
| `docs/api.md` | REST + gRPC reference |
| `docs/nats.md` · `matrix.md` · `sidecar.md` · `gateway.md` · `ui.md` | the planes |
| `docs/operations.md` | backup/restore/DR, SQLite operations, S3 |
| `docs/PI_AGENT_PLAN.md` | review of the Pi agent research report and the plan to run Pi as an independent SomeWork worker |
| `adapters/pi/README.md` · `adapters/pi/deploy/README.md` | the Pi coding agent service: architecture, failure behaviour, VM102 runbook and drills |
| `adapters/manager/README.md` · `adapters/manager/deploy/README.md` | the Manager: Telegram front for the other agents, policy gateway, rollout and rollback |
| `sdk/typescript/README.md` | TypeScript worker SDK: an agent runs its own claim loop |
| `deploy/README.md` | pilot deployment (Docker, private NATS with TLS, one worker), runbook, verified vs. unverified |
| `docs/ACCEPTANCE.md` | every spec requirement and acceptance criterion mapped to tests |

## Testing

```bash
cargo test --workspace                       # unit, domain, integration (real HTTP, SQLite, nats-server, MinIO)
cargo test --release -p somework-it --test load_control_plane -- --nocapture     # spec load profile
SOMEWORK_E2E=1 cargo test -p somework-it --test ui_e2e                            # Playwright browser suite
```

Chaos tests (`crates/somework-api/tests/chaos.rs`) run real server processes sharing one database and `SIGKILL`
them at chosen points (after commit and before the response; under load; during a lease).

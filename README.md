# SomeWork

SomeWork ("Samverka", badly translated) is an agent collaboration platform: agents discover each other by capability,
exchange typed messages in conversations, react to events through wake-only rules, share immutable artifacts, and
work inside one trust domain — with humans watching and joining through Matrix and an operations console.
Tasks, reactions, context handovers and federation were removed (`docs/adr/0003-messages-and-events-replace-tasks.md`). It implements `spec.md` on **SQLite** (the spec's PostgreSQL role is played by a single-writer
WAL database; see `docs/ARCHITECTURE.md`).

```
Matrix (humans)  ◄─ projection ─┐                     ┌─► NATS / JetStream (outbound-only agent delivery)
Ops UI (/ui)     ◄── REST/SSE ──┼── Domain Service ───┤
Sidecar + MCP    ──► REST/gRPC ─┘   (SQLite canonical) └─► S3 / MinIO (artifacts)
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

Optional sections: `[nats]`, `[matrix]`, `[grpc]`, `[objects.s3]`, `[[oidc]]` — see the per-plane docs.

See `docs/QUICKSTART.md` for running it and connecting an agent (MCP client or the TypeScript kit).

## Layout and docs

| Document | Topic |
|---|---|
| `docs/SYSTEM.md` | **start here**: what is built and how the pieces fit (platform, fleet, events, CI, observability, infrastructure) |
| `docs/AGENT_FLEET.md` | the fleet design: roles, what is shared and how |
| `docs/EVENTS.md` · `docs/RULES.md` · `docs/EVENTS_ACCEPTANCE.md` | events and rules: contract, writing rules, acceptance evidence |
| `docs/CI.md` · `docs/FLEET_DASHBOARD.md` | Woodpecker and rule deployment; the fleet dashboard integration |
| `docs/adr/` · `CONTEXT.md` | decision records and the glossary |
| `TODO.txt` | everything known and still open |
| `docs/ARCHITECTURE.md` | canonical-state rule, SQLite adaptations, trust model |
| `docs/CONVENTIONS.md` | crate map, rules, migrations, how to run things |
| `docs/api.md` | REST + gRPC reference |
| `docs/nats.md` · `matrix.md` · `sidecar.md` · `ui.md` | the planes |
| `docs/operations.md` | backup/restore/DR, SQLite operations, S3 |
| `docs/PI_AGENT_PLAN.md` | review of the Pi agent research report and the plan to run Pi as an independent SomeWork worker |
| `adapters/pi/README.md` · `adapters/pi/deploy/README.md` | the Pi coding agent service: architecture, failure behaviour, VM102 runbook and drills |
| `adapters/manager/README.md` · `adapters/manager/deploy/README.md` | the Manager: Telegram front for the other agents, policy gateway, rollout and rollback |
| `adapters/reviewer/README.md` · `adapters/reviewer/deploy/README.md` | the reviewer role (`code.review` v3): read-only review of a branch or pull request, structured findings, rollout and rollback |
| `adapters/windows-developer/README.md` · `adapters/windows-developer/deploy/README.md` | the Windows developer role (`code.windows`): changes that build and run on Windows, confined local environment, build/test profiles, encoding guard, service packaging and rollout |
| `adapters/aikido-fixer/README.md` · `adapters/aikido-fixer/deploy/README.md` | the Aikido fixer role (`code.fix`): turns Aikido events into pull requests that fix the reported issue, from a persistent mirror, with a read-only Aikido tool and a shipped event handler; contract, guards, runbook and rollback |
| `adapters/datadog-triage/README.md` · `adapters/datadog-triage/deploy/README.md` | the Datadog triage role (`ops.triage`): turns Datadog monitor alerts into a structured diagnosis for the owner, with read-only Datadog tools, python3 over saved results in a sandbox with no network, and a shipped event handler; contract, command policy, runbook (Datadog key scopes) and rollback |
| `adapters/qa/README.md` · `adapters/qa/deploy/README.md` | the QA role (`qa.verify`): verifies a ticket in a real browser against a revision, runs the application from a named profile, records a video, writes to the ticket system only after approval; service packaging and rollout |
| `packages/agent-kit/README.md` | the shared agent runtime and the role contract (card + profile + main.ts), repository skills, npm workspace layout |
| `sdk/typescript/README.md` | TypeScript worker SDK: an agent runs its own claim loop |
| `deploy/README.md` | pilot deployment (Docker, private NATS with TLS), runbook |
| `docs/ACCEPTANCE.md` | every spec requirement and acceptance criterion mapped to tests |

## Testing

```bash
cargo test --workspace                       # unit, domain, integration (real HTTP, SQLite, nats-server, MinIO)
cargo test --release -p somework-it --test load_control_plane -- --nocapture     # spec load profile
SOMEWORK_E2E=1 cargo test -p somework-it --test ui_e2e                            # Playwright browser suite
```

Chaos tests (`crates/somework-api/tests/chaos.rs`) run real server processes sharing one database and `SIGKILL`
them at chosen points (after commit and before the response; under load; during a lease).

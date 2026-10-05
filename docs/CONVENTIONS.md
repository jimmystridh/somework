# SomeWork engineering conventions

SomeWork ("Samverka", badly translated) implements `spec.md` on **SQLite** (not PostgreSQL). Every place the spec says
PostgreSQL, read SQLite: canonical state, outbox, idempotency keys, FTS5 catalog search, `BEGIN IMMEDIATE` write
locking, WAL. Namespaces that the spec calls `acollab` are `somework` (`somework.work.pool.*`, `somework://`,
`urn:somework:schema:v1`, `dev.somework.*` Matrix event types). MCP tool names stay `collab_*` as in the spec.

## Layout

| Crate | Role |
|---|---|
| `somework-core` | Pure contracts, FSM, JSON Schema validation, JWS, subjects, taxonomy. No I/O. |
| `somework-domain` | Canonical state: SQLite migrations, policy, auth, catalog, messages, tasks, context, artifacts, outbox runner. |
| `somework-api` | axum REST, SSE, OIDC, server runner + `somework` CLI binary, `wiring/` for optional planes. |
| `somework-client` | HTTP SDK (workload assertions, retries, artifact upload/verify). |
| `somework-nats` | JetStream machine plane (outbox sink, provisioning, streaming, presence). |
| `somework-matrix` | Matrix Application Service bridge (projection + ingestion). |
| `somework-gateway` | Trust-domain federation (mTLS + signed grants) and A2A interoperability. |
| `somework-sidecar` | Worker runtime, MCP server (spec tools + optional extended tools). |
| `somework-testkit` | In-process stacks, real infra processes (`tools/bin/nats-server`, `tools/bin/minio`), mocks. |
| `somework-it` | Integration + e2e tests (`crates/somework-it/tests/*.rs`). |
| `e2e/` | Playwright browser tests for the operations UI. |

## Rules

* Canonical-state rule: a mutation is durable when its SQLite transaction commits. NATS and Matrix are projections
  fed by `outbox_events` rows written in the same transaction (`Domain::emit`). Never publish to a transport from
  inside a request path.
* Identity comes from credentials only (`Domain::authenticate`). Never trust sender fields from request bodies.
* Every privileged mutation: `enforce()` (policy decision) + `audit()` in the same transaction; wrap public methods in
  `Domain::run` so denials are recorded.
* Errors are `somework_core::Error` with an `ErrorCode`; the API renders RFC 9457 problem documents with `traceId`.
* Timestamps are RFC 3339 UTC strings with millisecond precision (`somework_core::clock::ts`). Use the injected
  `Clock`, never `Utc::now()` in domain code, so tests can use `ManualClock`.
* Style: self-documenting code, few comments. Comments explain *why* (spec requirement ids are welcome).
* Tests: real SQLite, real HTTP, real `nats-server`/`minio` binaries; mocks only where the real thing cannot run
  here (Matrix homeserver, OIDC IdP). No sleeps for ordering; use `somework_testkit::process::eventually`.
* Tools: use `ag` not `grep`, `fd` not `find`. Do not commit to git; do not push.

## Migrations

`crates/somework-domain/migrations/NNNN_name.sql`, applied in order by `sqlx::migrate!`. Number ranges per work
package so parallel work never collides: core 0001-0099, nats 0100s, matrix 0200s, sidecar 0300s,
gateway 0400s, ui 0500s, s3/backup 0600s, grpc 0700s. Migrations are append-only; never edit a shipped one
(0001 is still editable until the first release).

## Running things

```
scripts/fetch-tools.sh            # nats-server + minio into tools/bin
cargo test --workspace            # unit + integration tests
cargo run -p somework-api -- serve --config somework.toml
```

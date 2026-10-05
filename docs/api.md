# SomeWork API: REST and gRPC

REST and gRPC expose **identical domain semantics**: both authenticate through the same credential path
(`Domain::authenticate` / OIDC mapping), build the same request documents and call the same `Domain` method. There is
no business logic in either transport. MCP and the SDK are thin adapters over REST.

## Conventions (REST)

| Item | Behaviour |
|---|---|
| Auth | `Authorization: Bearer <token>`: a workload assertion (Ed25519, minted per request by the SDK), a domain-issued grant (task-bound or delegated) or an OIDC token of a human whose `(iss, sub)` is mapped to a principal. The sender is always derived from the credential, never from the body. |
| Idempotency | Mutating calls accept `Idempotency-Key` (1-256 chars). A retry with the same key and request returns the stored response; the same key with a different request is `409 idempotency_conflict`. |
| Revision guard | State-changing task calls accept `If-Match: "<revision>"` or `expectedRevision` in the body. A mismatch is `409 stale_revision`. |
| Tracing | Incoming W3C `traceparent` is continued; every response carries `traceparent`, `x-trace-id` and a `traceId` field. |
| Errors | RFC 9457 `application/problem+json`: `{type, title, status, code, detail, traceId, details?}`. `code` is the stable machine code below. |
| Limits | Inline JSON payloads are limited to 32 KiB (`413 payload_too_large`): store large content as an artifact and reference it. |

### Error codes

| `code` | HTTP | gRPC status |
|---|---|---|
| `unauthenticated` | 401 | `UNAUTHENTICATED` |
| `policy_denied`, `sender_mismatch` | 403 | `PERMISSION_DENIED` |
| `not_found` (also for hidden resources) | 404 | `NOT_FOUND` |
| `validation_failed`, `schema_violation`, `trigger_not_allowed`, `integrity_failure` | 422 | `INVALID_ARGUMENT` |
| `stale_revision`, `invalid_transition`, `task_terminal`, `approval_required`, `artifact_not_ready`, `expired` | 409/422/410 | `FAILED_PRECONDITION` |
| `already_claimed`, `stale_fencing_token`, `lease_expired` | 409 | `ABORTED` |
| `idempotency_conflict`, `conflict` | 409 | `ALREADY_EXISTS` |
| `payload_too_large`, `quota_exceeded`, `rate_limited` | 413/429 | `RESOURCE_EXHAUSTED` |
| `policy_unavailable`, `unavailable` | 503 | `UNAVAILABLE` |
| `internal` | 500 | `INTERNAL` |

Policy denials are recorded (decision, audit entry, non-waking `policy.denied` event) identically on both transports;
the audit row's `sourceTransport` tells them apart. The internal decision payload is not returned to the caller.

## REST routes

Routes are defined in `crates/somework-api/src/routes/*.rs`. Path parameters are percent-encoded (`agent%2Freviewer`).

### Platform contract (spec table)

| Route | Semantics |
|---|---|
| `POST /v1/catalog/search` | Policy-filtered capability/agent discovery |
| `GET /v1/agents/{agentId}` | AgentCard restricted to what the caller may see |
| `GET /v1/capabilities/{id}/{version}` | Capability contract |
| `POST /v1/messages` | Canonical typed message (`chat.message`, `chat.notice`, `event.notification`, `task.status`) |
| `GET /v1/conversations/{id}/messages?cursor=&limit=` | Cursor-based history |
| `GET /v1/events?after=&limit=&wait=` | Cursor long-poll; `Accept: text/event-stream` for SSE |
| `POST /v1/tasks` | Create task (`Idempotency-Key`) |
| `GET /v1/tasks/{id}` | Current snapshot |
| `GET /v1/tasks/{id}/events` | Ordered task history |
| `POST /v1/tasks/{id}/claim` / `heartbeat` / `progress` / `input` / `complete` / `fail` / `cancel` | Worker/requester lifecycle (fencing token + revision guarded) |
| `POST /v1/context-packs`, `GET /v1/context-packs/{id}/{version}` | Immutable version / policy-filtered pack (`?sections=a,b&taskId=`) |
| `POST /v1/context-packs/{id}/{version}/offer` / `accept` | Handoff offer / acceptance (ownership transfer is atomic) |
| `POST /v1/artifacts/uploads`, `POST /v1/artifacts/{id}/complete` | Upload grant / digest verification |
| `GET /v1/artifacts/{id}/{version}`, `POST .../download-grants` | Metadata / short-lived download URL |
| `POST /v1/subscriptions`, `DELETE /v1/subscriptions/{id}` | Durable subscriptions (`wakeOnMatch` is mandatory) |
| `POST /v1/authorizations/delegate` | Mint a narrower child grant |
| `/federation/v1/*` | Cross-domain gateway (mTLS), see `docs/gateway.md` |

### Additional routes

| Route | Purpose |
|---|---|
| `GET /v1/catalog/entries`, `PUT /v1/agents/{agentId}`, `POST /v1/agents/{agentId}/approval` | List, self-register, approve catalog entries |
| `GET /v1/tasks`, `/v1/tasks/next?wait=`, `/v1/tasks/{id}/tree`, `/v1/tasks/{id}/stream` (SSE), `POST /v1/tasks/{id}/reconcile` | Listing, poll-for-work fallback, DAG, live output, reconciliation |
| `GET /v1/approvals`, `GET /v1/approvals/{id}`, `POST /v1/approvals/{id}/decision` | Structured approvals bound to action digest + revision |
| `POST /v1/conversations`, `GET /v1/conversations`, `GET /v1/conversations/{id}`, `/join`, `/leave`, `/members`, `/summary`, `GET /v1/messages/{id}`, `POST /v1/messages/read`, `GET /v1/inbox` | Conversations, inbox |
| `POST /v1/events/ack`, `GET /v1/subscriptions` | Event cursor, subscription list |
| `GET /v1/context-offers/{id}`, `POST /v1/context-offers/{id}/decline` | Offers |
| `PUT/GET /v1/objects/{grant}` | Presigned object transfer for the local filesystem store |
| `GET /v1/connection`, `POST /v1/runtimes`, `POST /v1/runtimes/heartbeat`, `DELETE /v1/runtimes/self`, `GET /v1/runtimes` | Transport details, runtime instances |
| `POST /v1/sealed`, `GET /v1/sealed`, `POST /v1/sealed/{id}/open`, `GET /v1/sealed/recipients/{kind}/{id}/key` | Sealed-secret extension |
| `GET /healthz`, `/readyz`, `/metrics` | Operations |
| `/v1/admin/principals`, `/policy`, `/audit`, `/audit/verify`, `/events`, `/messages`, `/tasks`, `/outbox`, `/outbox/requeue`, `/maintenance`, `/signing-keys/rotate`, `/overview`, `/whoami`, `/failpoints` | Administration and introspection (role gated) |
| `/v1/admin/policy-decisions`, `/conversations`, `/catalog`, `/context-packs[/{id}/{version}]`, `/artifacts` | Operations UI read models |
| `/v1/admin/federation/*` | Peer, export and A2A administration |
| `/ui/*` | Operations UI and its session endpoints |

### Example

```http
POST /v1/tasks HTTP/1.1
Authorization: Bearer <assertion>
Idempotency-Key: review-pr-729-at-61a8d52
Content-Type: application/json

{"capability": {"id": "code.review", "version": "2.1"}, "targetAgentId": "agent/reviewer",
 "input": {"repository": "billing/import-service", "commit": "61a8d52"}}
```

```json
{"taskId": "task_01J...", "state": "queued", "revision": 2, "attempt": 1, "traceId": "00-bce9...-01"}
```

## gRPC

Package `somework.v1`, proto in `crates/somework-api/proto/somework/v1/somework.proto`. Enable with

```toml
[grpc]
listen = "127.0.0.1:50051"
# [grpc.tls] cert_path = "...", key_path = "...", client_ca_path = "..."   # optional (mutual) TLS
```

Ids, revisions, fencing tokens and task states are typed fields; schema-defined payloads (capability input/output,
ContextPack, message content, results) are `google.protobuf.Struct`/`Value` so the JSON v1 contracts stay canonical.
Task responses carry typed essentials plus the complete `Task` document in `task`.

Request metadata: `authorization: Bearer ...`, `idempotency-key`, `if-match` (or `expected-revision`), `traceparent`.
Response metadata (also on errors): `trace-id`, `traceparent`; every message has `trace_id`. Errors carry a
`google.rpc.ErrorInfo` detail: `reason` = problem `code`, metadata `traceId`, `httpStatus`, `details` (JSON).
Health (`grpc.health.v1`) and server reflection are served.

| Spec row | gRPC |
|---|---|
| `POST /v1/catalog/search` | `CatalogService.Search` |
| `GET /v1/agents/{agentId}` | `CatalogService.GetAgent` |
| `GET /v1/capabilities/{id}/{version}` | `CatalogService.GetCapability` |
| `POST /v1/messages` | `MessageService.Send` |
| `GET /v1/conversations/{id}/messages` | `MessageService.List` |
| `GET /v1/events` | `EventService.Watch` (server streaming; `after` cursor, `from_start`, acknowledged cursor by default), `EventService.Ack` |
| `POST /v1/tasks` | `TaskService.Submit` |
| `GET /v1/tasks/{id}` | `TaskService.Get` |
| `GET /v1/tasks/{id}/events` | `TaskService.ListEvents` |
| `POST /v1/tasks/{id}/claim` / `heartbeat` / `progress` / `input` / `complete` / `fail` / `cancel` | `TaskService.Claim` / `Heartbeat` / `Progress` / `ProvideInput` / `Complete` / `Fail` / `Cancel` |
| `GET /v1/tasks/{id}/stream` | `TaskService.Watch`: snapshot first, then one update per task event; ends when the task is terminal |
| `POST /v1/context-packs` / `GET ...` / `offer` / `accept` | `ContextService.Create` / `Get` / `Offer` / `Accept` |
| `POST /v1/artifacts/uploads` / `complete` / `GET .../{version}` / `download-grants` | `ArtifactService.BeginUpload` / `CompleteUpload` / `GetMetadata` / `GetDownload` |
| `POST /v1/subscriptions`, `DELETE ...` | `SubscriptionService.Create` / `Delete` (`wake_on_match` is `optional bool`; unset is `INVALID_ARGUMENT`) |
| `POST /v1/authorizations/delegate` | `AuthorizationService.Delegate` |

`GatewayService` belongs to the federation gateway package and is not part of this API surface.

```
grpcurl -plaintext -H "authorization: Bearer $TOKEN" -H "idempotency-key: k1" \
  -d '{"capability":{"id":"code.review","version":"2.1"},"input":{"repository":"a/b"}}' \
  127.0.0.1:50051 somework.v1.TaskService/Submit
```

Parity is tested in `crates/somework-it/tests/grpc_parity.rs`: one scenario scripted over REST and over gRPC must give
the same states, revisions, fencing tokens, event sequences and problem codes.

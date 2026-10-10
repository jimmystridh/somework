# SomeWork API: REST and gRPC

REST and gRPC expose **identical domain semantics**: both authenticate through the same credential path
(`Domain::authenticate` / OIDC mapping), build the same request documents and call the same `Domain` method. There is
no business logic in either transport. MCP and the SDK are thin adapters over REST.

## Conventions (REST)

| Item | Behaviour |
|---|---|
| Auth | `Authorization: Bearer <token>`: a workload assertion (Ed25519, minted per request by the SDK), or an OIDC token of a human whose `(iss, sub)` is mapped to a principal. The sender is always derived from the credential, never from the body. |
| Idempotency | Mutating calls accept `Idempotency-Key` (1-256 chars). A retry with the same key and request returns the stored response; the same key with a different request is `409 idempotency_conflict`. |
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
| `stale_revision`, `artifact_not_ready`, `expired` | 409/422/410 | `FAILED_PRECONDITION` |
| `idempotency_conflict`, `conflict` | 409 | `ALREADY_EXISTS` |
| `payload_too_large`, `quota_exceeded`, `rate_limited` | 413/429 | `RESOURCE_EXHAUSTED` |
| `policy_unavailable`, `unavailable` | 503 | `UNAVAILABLE` |
| `internal` | 500 | `INTERNAL` |

Policy denials are recorded (decision, audit entry, non-waking `policy.denied` event) identically on both transports;
the audit row's `sourceTransport` tells them apart. The internal decision payload is not returned to the caller.

## REST routes

Routes are defined in `crates/somework-api/src/routes/*.rs`. Path parameters are percent-encoded (`agent%2Freviewer`).

### Platform contract

| Route | Semantics |
|---|---|
| `POST /v1/catalog/search` | Policy-filtered agent and capability discovery (capabilities are advertisements) |
| `GET /v1/agents/{agentId}` | AgentCard restricted to what the caller may see |
| `GET /v1/capabilities/{id}/{version}` | Capability contract |
| `POST /v1/messages` | Canonical typed message (`chat.message`, `chat.notice`, `event.notification`); `artifacts[]` attaches artifacts (see below) |
| `GET /v1/conversations/{id}/messages?cursor=&limit=` | Cursor-based history |
| `GET /v1/events?after=&limit=&wait=` | Cursor long-poll; `Accept: text/event-stream` for SSE |
| `POST /v1/artifacts/uploads`, `POST /v1/artifacts/{id}/complete` | Upload grant / digest verification |
| `GET /v1/artifacts/{id}/{version}`, `POST .../download-grants` | Metadata / short-lived download URL |
| `POST /v1/subscriptions`, `DELETE /v1/subscriptions/{id}` | Durable subscriptions (`wakeOnMatch` is mandatory) |

### Additional routes

| Route | Purpose |
|---|---|
| `GET /v1/catalog/entries`, `PUT /v1/agents/{agentId}`, `POST /v1/agents/{agentId}/approval` | List, self-register, approve catalog entries |
| `POST /v1/conversations`, `GET /v1/conversations`, `GET /v1/conversations/{id}`, `/join`, `/leave`, `/members`, `/summary`, `GET /v1/messages/{id}`, `POST /v1/messages/read`, `GET /v1/inbox?unread=` | Conversations, inbox, read receipts |
| `POST /v1/events/ack`, `GET /v1/subscriptions` | Event cursor, subscription list |
| `POST /v1/events/publish` | Producers publish an event under a topic (see *Events and rules* below) |
| `GET /v1/rules`, `GET/PUT/DELETE /v1/rules/{name}`, `POST /v1/rules/{name}/pause` / `resume` | Rules: wake-only subscriptions |
| `PUT/GET /v1/objects/{grant}` | Presigned object transfer for the local filesystem store |
| `GET /v1/connection`, `POST /v1/runtimes`, `POST /v1/runtimes/heartbeat`, `DELETE /v1/runtimes/self`, `GET /v1/runtimes` | Transport details, runtime instances |
| `POST /v1/sealed`, `GET /v1/sealed`, `POST /v1/sealed/{id}/open`, `GET /v1/sealed/recipients/{kind}/{id}/key` | Sealed-secret extension |
| `GET /healthz`, `/readyz`, `/metrics` | Operations |
| `/v1/admin/principals`, `/policy`, `/audit`, `/audit/verify`, `/events`, `/messages`, `/outbox`, `/outbox/requeue`, `/maintenance`, `/signing-keys/rotate`, `/overview`, `/system`, `/whoami`, `/failpoints` | Administration and introspection (role gated) |
| `/v1/admin/policy-decisions`, `/conversations`, `/catalog`, `/artifacts` | Operations UI read models |
| `/ui/*` | Operations UI and its session endpoints |

Removed with ADR 0003: `/v1/tasks*`, `/v1/approvals*`, `/v1/context-packs*`, `/v1/context-offers*`, `/v1/authorizations/delegate`,
`/v1/admin/tasks`, `/v1/admin/context-packs`, `/v1/admin/federation/*`, `/federation/v1/*` (the federation gateway and A2A bridge are gone).

### Attachments and artifact access

Uploads are independent of any conversation. `POST /v1/messages` accepts `artifacts: [ArtifactRef]`; every reference must name an
artifact version that exists in this domain, is `complete` (digest verified) and carries the digest and size the domain recorded
(`artifact_not_ready` or `integrity_failure` otherwise), and its classification must not exceed the conversation's. Any
authenticated principal holding `artifact.read` may read the metadata or request a download grant for **any** artifact, subject to
the classification clearance of the principal; there is no per-task or per-conversation scoping. `sourceTaskId` and `taskId` are gone from uploads and downloads.

### Example

```http
POST /v1/messages HTTP/1.1
Authorization: Bearer <assertion>
Idempotency-Key: review-pr-729-at-61a8d52
Content-Type: application/json

{"recipients": [{"kind": "agent", "id": "agent/reviewer"}], "triggerMode": "directed",
 "content": {"mediaType": "text/plain", "data": "Please review billing/import-service@61a8d52"},
 "artifacts": []}
```

```json
{"messageId": "msg_01J...", "conversationId": "conv_01J...", "seq": 42, "traceId": "00-bce9...-01"}
```

Without `conversationId` the domain opens (or reuses) a direct conversation with the recipients. Without explicit recipients in a
group conversation, `triggerMode: directed` wakes every member. `causationId` names the message being answered; the domain derives
`hopDepth` from it and turns the trigger to `never` once `max_agent_hops` (16) is reached, which stops agent ping-pong.

## gRPC

Package `somework.v1`, proto in `crates/somework-api/proto/somework/v1/somework.proto`. Enable with

```toml
[grpc]
listen = "127.0.0.1:50051"
# [grpc.tls] cert_path = "...", key_path = "...", client_ca_path = "..."   # optional (mutual) TLS
```

Ids and revisions are typed fields; schema-defined payloads (capability input/output, message content) are
`google.protobuf.Struct`/`Value` so the JSON v1 contracts stay canonical.

Request metadata: `authorization: Bearer ...`, `idempotency-key`, `traceparent`.
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
| `POST /v1/events/publish` | `EventService.Publish` |
| `POST /v1/artifacts/uploads` / `complete` / `GET .../{version}` / `download-grants` | `ArtifactService.BeginUpload` / `CompleteUpload` / `GetMetadata` / `GetDownload` |
| `POST /v1/subscriptions`, `DELETE ...` | `SubscriptionService.Create` / `Delete` (`wake_on_match` is `optional bool`; unset is `INVALID_ARGUMENT`) |

The removed gRPC services (`TaskService`, `ContextService`, `AuthorizationService`, `GatewayService`) have reserved field numbers in the proto.

```
grpcurl -plaintext -H "authorization: Bearer $TOKEN" -H "idempotency-key: k1" \
  -d '{"recipients":[{"kind":"agent","id":"agent/reviewer"}],"content":{"mediaType":"text/plain","data":"hi"}}' \
  127.0.0.1:50051 somework.v1.MessageService/Send
```

Parity is tested in `crates/somework-it/tests/grpc_flow.rs` and `grpc_services.rs`: the same scenario over REST and over gRPC must give
the same results, event sequences and problem codes.


## Events and rules

The design is in `docs/EVENTS.md` and the vocabulary in `CONTEXT.md`; this section is the wire reference.

### Publishing: `POST /v1/events/publish`

Caller: any principal holding `events.publish:<topic glob>` for the topic (the `*` action does not grant it; the `admin`
role does). Enrol a dedicated producer with `somework admin enroll-producer --id producer/github --publish 'github.*' --key-out github.key.json`,
give an agent the same grant with `enroll-agent --publish 'test.*'` (also `set-agent-permissions --publish`), and narrow or widen a producer later
with `set-publish-permissions`.

```json
{ "topic": "github.pull_request.opened", "key": "<stable key, 1-200 chars>", "source": "github",
  "data": { "number": 7, "draft": false }, "classification": "internal", "verified": true,
  "occurredAt": "2026-10-05T12:00:00Z" }
```

`topic` must match `^[a-z][a-z0-9_]*(\.[a-z0-9_]+){2,}$` (at most 200 characters), `data` must be a JSON object of at most 64 KiB,
`classification` (default `internal`) must be a level of the active policy and not above the publisher's clearance. Answer:
`201 {"seq", "eventId", "duplicate": false}`; publishing the same `(principal, key)` again within 30 days answers
`200` with `duplicate: true` and the original `seq`/`eventId` and emits nothing. Errors: `403 policy_denied` (topic outside the
grants, clearance), `400 validation_failed`, `413 payload_too_large`. `causedByTask` is no longer accepted.

The stored event's `type` is the topic, its payload is `{topic, source, key, data, classification, verified, occurredAt, publishedBy}`
and it is also routed to NATS subject `somework.event.published.<topic>`. A producer never receives its own events through its
own subscriptions. Metrics: `somework_events_published_total`, `somework_events_duplicate_total`.

### Rules

`PUT /v1/rules/{name}` (name: lowercase letters, digits, `.`, `_`, `-`, at most 64) creates or replaces a rule; `201` when new, `200`
otherwise, and an identical repeat changes nothing. Permission `rules.manage` (enrol the deployer with
`somework admin enroll-service --id deployer/rules --action rules.manage --key-out deployer.key.json`) allows everything: create, replace,
delete, pause, resume and reads. Runtime control is a separate, narrower permission, `rules.control`, which allows only
`POST /v1/rules/{name}/pause` and `/resume` plus the reads. Reads (`GET /v1/rules`, `/v1/rules/{name}`) need `rules.manage`, `rules.control` or
`ops.read`. Like all administrative actions, neither is implied by the `*` action; the admin role holds both.

```json
{ "description": "Wake the reviewer for every opened pull request", "owner": "automation/pr-review",
  "selector": "github.pull_request.opened", "where": [ { "path": "/data/draft", "equals": false } ],
  "wake": true, "status": "active" }
```

* A rule is a wake-only subscription owned by an active agent or service principal: matching events appear in the owner's event
  feed with `wake: true` (and arrive through its subscription consumer on NATS). What the agent then does is up to the agent (the TypeScript kit).
* `selector` is a glob over the topic (`*` matches any run); `where` clauses are JSON-pointer equality checks over the event payload,
  all of which must hold.
* A rule has no `reaction`, `maxDepth` or `maxFiringsPerHour`; a body that contains `reaction` is `422 validation_failed`.
  There is no firing ledger and no `GET /v1/rules/{name}/firings`.
* `GET /v1/rules/{name}` returns the rule plus `subscriptionId`, `createdAt` and `updatedAt`. `DELETE` answers `204`. `pause` and `resume` answer the rule.

Admin commands: `enroll-producer`, `set-publish-permissions`, `enroll-service`, and `enroll-agent` / `set-agent-permissions` (with `--publish`) for automation principals.

### Retention

The maintenance retention job removes, once older than 30 days (`PUBLISHED_EVENT_RETENTION_DAYS`): events published by producers (events
whose NATS subject is `somework.event.published.*`) together with their recipient rows, delivered outbox rows and dedupe keys, and any other
dedupe keys. A published event whose outbox rows are still `pending` or `failed` is kept, as are messages and the audit chain. After a
purge the same producer key may be published again as a new event.

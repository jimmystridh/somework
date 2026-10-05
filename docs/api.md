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
| `POST /v1/events/publish` | Producers publish an event under a topic (see *Events, rules and reactions* below) |
| `GET /v1/rules`, `GET/PUT/DELETE /v1/rules/{name}`, `POST /v1/rules/{name}/pause` / `resume`, `GET /v1/rules/{name}/firings` | Rules: subscriptions with an optional reaction |
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
| `POST /v1/events/publish` | `EventService.Publish` |
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


## Events, rules and reactions

The design is in `docs/EVENTS.md` and the vocabulary in `CONTEXT.md`; this section is the wire reference.

### Publishing: `POST /v1/events/publish`

Caller: a `service` principal holding `events.publish:<topic glob>` for the topic (the `*` action does not grant it; the `admin`
role does). Enrol one with `somework admin enroll-producer --id producer/github --publish 'github.*' --key-out github.key.json`
and narrow or widen it later with `set-publish-permissions`.

```json
{ "topic": "github.pull_request.opened", "key": "<stable key, 1-200 chars>", "source": "github",
  "data": { "number": 7, "draft": false }, "classification": "internal", "verified": true,
  "causedByTask": "tsk_...", "occurredAt": "2026-10-05T12:00:00Z" }
```

`topic` must match `^[a-z][a-z0-9_]*(\.[a-z0-9_]+){2,}$` (at most 200 characters), `data` must be a JSON object of at most 64 KiB,
`classification` (default `internal`) must be a level of the active policy and not above the publisher's clearance. Answer:
`201 {"seq", "eventId", "duplicate": false}`; publishing the same `(principal, key)` again within 30 days answers
`200` with `duplicate: true` and the original `seq`/`eventId` and emits nothing. Errors: `403 policy_denied` (topic outside the
grants, clearance), `400 validation_failed`, `413 payload_too_large`.

The stored event's `type` is the topic, its payload is `{topic, source, key, data, classification, verified, depth, causedByTask,
occurredAt, publishedBy}` and it is also routed to NATS subject `somework.event.published.<topic>`. `depth` is 0, or the origin
depth of `causedByTask` plus one when that task was started by a reaction. A producer never receives its own events through its
own subscriptions. Metrics: `somework_events_published_total`, `somework_events_duplicate_total`.

### Rules

`PUT /v1/rules/{name}` (name: lowercase letters, digits, `.`, `_`, `-`, at most 64) creates or replaces a rule; `201` when new, `200`
otherwise, and an identical repeat changes nothing. Permission `rules.manage` (enrol the deployer with
`somework admin enroll-service --id deployer/rules --action rules.manage --key-out deployer.key.json`) allows everything: create, replace,
delete, pause, resume and reads. Runtime control is a separate, narrower permission, `rules.control` (enrol with
`somework admin enroll-service --id ops/controller --action rules.control --key-out controller.key.json`), which allows only
`POST /v1/rules/{name}/pause` and `/resume` plus the reads; its holder gets `403 policy_denied` on `PUT` and `DELETE`, so rules can be stopped at
runtime but never created or changed. Reads (`GET /v1/rules`, `/v1/rules/{name}`, `/v1/rules/{name}/firings`) need `rules.manage`, `rules.control` or
`ops.read`. Like all administrative actions, neither is implied by the `*` action; the admin role holds both.

```json
{ "description": "Review every opened pull request", "owner": "automation/pr-review",
  "selector": "github.pull_request.opened", "where": [ { "path": "/data/draft", "equals": false } ],
  "wake": false,
  "reaction": { "capability": { "id": "code.review", "version": "2.1" },
                "input": { "repository": "${/data/repository}", "pullNumber": "${/data/number}" },
                "budget": { "maxTokens": 200000, "maxMinutes": 20 }, "maxDepth": 3, "maxFiringsPerHour": 30 },
  "status": "active" }
```

* `owner` is the handle of an active agent or service principal; the rule is a `topic` subscription owned by it. An automation
  principal is an ordinary agent enrolled without a card: `somework admin enroll-agent --id automation/pr-review --may-invoke code.review --side-effects read --key-out ...`.
  With a `reaction` the owner must be allowed to invoke the capability (`400` otherwise).
* `selector` is a glob over the topic (`*` matches any run); `where` clauses are JSON-pointer equality checks over the event payload,
  all of which must hold. A rule with `wake: true` and no reaction is an agent subscription: the agent sees matching events in
  its event feed with `wake: true` (and through its subscription consumer on NATS).
* In `reaction.input`, a string that is exactly `${/pointer}` is replaced by the typed value at that JSON pointer of the event
  payload; `${/pointer}` inside a longer string is replaced by its text form; `$${` writes a literal `${`; a missing pointer skips the firing
  with reason `error`. `budget` is merged into `input.budget` unless the template sets one. `maxDepth` defaults to 3 (1-10),
  `maxFiringsPerHour` to 30 (1-3600).
* `GET /v1/rules/{name}` returns the rule plus `subscriptionId`, `createdAt`, `updatedAt`, `lastFiredAt` and
  `counters: {fired, skipped: {duplicate, depth, rate, denied, approval, error, paused}}`. `GET /v1/rules/{name}/firings?limit=` lists the ledger
  (`status` pending, fired or skipped, `reason`, `detail`, `taskId`, `approvalId`). `DELETE` answers `204`. `pause` and `resume` answer the rule.

### Reactions

Each matching event writes one `reaction_firings` row (unique on rule and event id) and one outbox row for the sink `reaction`; the
server's reaction worker settles it: skip when the rule is paused/removed, when the event depth has reached `maxDepth` (published events
carry their depth; task events carry the origin depth of a reaction-started task plus one), or when `maxFiringsPerHour` fired in the last
hour; otherwise render the input and submit the task as `owner` through the normal path (policy, `may-invoke`, delegation, idempotency
key `reaction:<rule>:<eventId>`). Reactions of write class or above always wait for a structured approval; a denied or expired approval is
counted in `skipped.approval`. The task carries `origin: {kind: "reaction", rule, eventId, depth}` (visible on task reads). Events
of type `reaction.*` never start reactions. Outcomes are announced as domain events `reaction.fired` and `reaction.skipped` (`reason`, `detail`) and counted in
`somework_reactions_fired_total` and `somework_reactions_skipped_total{reason}`. `process_reaction` is safe to repeat for the same row.

Admin commands: `enroll-producer`, `set-publish-permissions`, `enroll-service`, and the existing `enroll-agent` / `set-agent-permissions` for automation principals.

### Tasks that answer an event: `causedByEvent`

`POST /v1/tasks` (and `TaskService.Submit`, field `caused_by_event`, and `Client::submit_task_for_event`) accepts an optional
`causedByEvent: "<eventId>"`. The domain never trusts it: the event must exist in this domain and have been **addressed to the submitting
principal** (a row in the event feed, `GET /v1/events`). Anything else (unknown id, an event delivered to someone else, one the caller
published but did not receive) fails with the same `422 validation_failed` ("causedByEvent does not name an event that was addressed to the
caller"), so ids cannot be probed. A verified task records `origin: {kind: "event", eventId, depth}` where `depth` is the event's depth plus one
(a published event's `depth`; a task event's origin depth plus one; any other event 0). The submitter's own authority and approvals apply
unchanged (nothing is forced to wait for approval, unlike reactions). Task events then carry `originDepth`, and an event published with
`causedByTask: <that task>` has `depth = origin.depth + 1`, so a chain event, agent task, published event, reaction keeps counting and
every rule's `maxDepth` cuts it. `origin` is returned on task reads (`TaskInfo.origin` in the client crate).

### Retention

The maintenance retention job also removes, once older than 30 days (`PUBLISHED_EVENT_RETENTION_DAYS`): events published by producers (events
whose NATS subject is `somework.event.published.*`) together with their recipient rows, delivered outbox rows and dedupe keys; settled
(`fired` or `skipped`) `reaction_firings`; and any other dedupe keys. A published event whose outbox rows are still `pending` or `failed` is kept,
as are `pending` firings. Task events and task lifecycle events, `reaction.*` events, messages and the audit chain are not touched. After a
purge the same producer key may be published again as a new event.

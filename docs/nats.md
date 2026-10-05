# NATS / JetStream machine plane (`somework-nats`)

NATS is the **delivery** plane. SQLite stays canonical: a task is durable when its transaction commits, and the NATS
plane only publishes rows of the transactional outbox (`outbox_events`, sink `nats`). Agents never receive Matrix,
SQLite or object-store credentials; they hold outbound-only NATS credentials scoped to their own subjects plus an HTTPS
channel to the domain service.

## Subject space (per trust domain account)

| Subject | Stream | Purpose |
|---|---|---|
| `somework.work.pool.<pool>` | `SOMEWORK_WORK` (7 d) | work-ready notifications, one shared durable pull consumer per pool |
| `somework.inbox.<agent>` | `SOMEWORK_INBOX` (30 d) | directed messages, context offers, wake-ups; one filtered consumer per logical agent |
| `somework.event.task.<id>`, `.conversation.<id>`, `.catalog.changed`, `.policy.denied` | `SOMEWORK_EVENTS` (30 d) | projections for dashboards / the Matrix projector |
| `somework.subscription.<sub>` | `SOMEWORK_SUBSCRIPTIONS` (30 d) | one consumer *per agent* whose filter set follows that agent's subscriptions |
| `somework.stream.task.<id>.text|tool` | core NATS (ephemeral) | live chunks, never persisted |
| `somework.presence.<agent>` | core NATS (ephemeral) | liveness hints |

All ids pass through `somework_core::ids::subject_token`, so user strings cannot add levels or wildcards.
A work-ready notification is exactly `{eventId, taskId, revision, capabilityId, capabilityVersion, poolId, traceparent}`:
enough to *claim* the canonical task, nothing else.

## Delivery semantics

* `NatsSink` publishes with `Nats-Msg-Id = outbox.dedupe_key` and waits for the JetStream ack (pipelined per batch).
  A crash between publish and "published" bookkeeping re-publishes the row; the 5-minute duplicate window absorbs it and
  consumers are idempotent anyway (claim is a compare-and-swap in SQLite).
* Worker algorithm: receive -> `POST /v1/tasks/{id}/claim` -> success **or** `already_claimed`/terminal: ACK;
  transient error: do not ACK (redelivered after `ack_wait`).
* Offline agents: the inbox/pool consumers are durable and created from the directory (all enrolled agents), so
  messages sent while an agent is down are waiting when it reconnects (DEL-01).
* NATS down: submissions keep returning 2xx; rows wait in the outbox with exponential backoff (dead-letter after
  `max_attempts`). JetStream state loss: the reconciler re-creates streams/consumers when the connection epoch changes and
  `somework admin republish-queued` (or `Domain::republish_queued_tasks`) re-enqueues every queued task from SQLite (BAK-02).
* Dispatch: work-ready rows are claimed ahead of other outbox traffic (per-subject order is preserved); status updates
  are committed once per batch.

## Accounts, users and credentials

`conf::server_conf` renders `nats-server.conf` with a system account and one account per trust domain
(`DOMAIN_<ID>`, JetStream enabled) that `include`s a `users.conf` fragment (same directory; nats-server resolves includes
relative to the main file). `NatsConfigGenerator::users_fragment` creates:

* the domain-service admin user (full access inside the account),
* one user per enrolled agent (`a_<token>`) allowed to **publish only**: pull/info/ack on its own inbox, its pool and its
  subscription consumers; `somework.stream.task.*.*`; its own `somework.presence.<agent>`. It may subscribe only to `_INBOX.>`.
  It cannot publish to work/inbox/event/subscription subjects nor touch another agent's consumers.

Per-agent passwords are `HMAC-SHA256(key = SHA256("somework-nats-creds:" + master key), "agent:" + id)` (first 40 hex),
so they survive restarts without storing anything. `GET /v1/connection` returns them to the authenticated agent:

```json
{"nats": {"url", "user", "password", "inboxStream", "inboxConsumer", "workStream",
          "poolConsumers": [{"poolId", "stream", "consumer", "filter"}],
          "subscriptionStream", "subscriptionConsumer", "presenceSubject", "streamSubjectPrefix"}}
```

**New agents reach the broker without a restart:** the plane rewrites `users_file` whenever the agent/pool set changes and
runs `reload_command` (e.g. `["sh","-c","kill -HUP $(cat /run/nats.pid)"]`; a Kubernetes deployment would signal the pod or
use a config-reloader sidecar). `GET /v1/connection` additionally waits until the credentials are accepted.

## Streaming and presence

`NatsStreamSource` serves `GET /v1/tasks/{id}/stream` (SSE): the durable snapshot first, then chunks. A chunk is relayed
only if `taskId`, `fencingToken` and `runtimeInstanceId` match the canonical lease, so a worker that lost its lease (or
never had one) cannot inject output. Missing chunks are not data loss: reconnecting consumers re-read the snapshot (STR-02).
`ChunkPublisher` is the sidecar helper. The presence listener only refreshes already-registered runtimes and ignores
signals whose payload disagrees with the subject.

## Metrics

`somework_jetstream_consumer_lag{stream,consumer}` (pending + ack-pending) and `somework_jetstream_redelivery_count_total`
are refreshed every `metrics_interval_ms` from consumer info; outbox backlog/age gauges come from the domain.

## Configuration

```toml
[nats]
url = "nats://127.0.0.1:4222"      # domain service connection (admin user)
user = "somework-domain"
password = "..."
client_url = "nats://nats.example:4222"   # what agents are told (optional)
users_file = "/etc/nats/users.conf"
reload_command = ["sh", "-c", "kill -HUP $(cat /run/nats.pid)"]
replicas = 3                       # production: replicate across failure domains
```

Deviations from the spec: per-subscription consumers are realised as one consumer per agent with a multi-subject filter
(the consumer name must be known to a static permission set); human-owned subscriptions are not projected to NATS.

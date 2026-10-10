# NATS / JetStream machine plane (`somework-nats`)

NATS is the **delivery** plane. SQLite stays canonical: a message or event is durable when its transaction commits, and the NATS
plane only publishes rows of the transactional outbox (`outbox_events`, sink `nats`). Agents never receive Matrix,
SQLite or object-store credentials; they hold outbound-only NATS credentials scoped to their own subjects plus an HTTPS
channel to the domain service.

## Subject space (per trust domain account)

| Subject | Stream | Purpose |
|---|---|---|
| `somework.inbox.<agent>` | `SOMEWORK_INBOX` (30 d) | directed messages and wake-ups (`{kind, messageId, messageType, conversationId, wake, sender}`); one filtered consumer per logical agent |
| `somework.event.conversation.<id>`, `.published.<topic>`, `.catalog.changed`, `.policy.denied` | `SOMEWORK_EVENTS` (30 d) | projections for dashboards / the Matrix projector |
| `somework.subscription.<sub>` | `SOMEWORK_SUBSCRIPTIONS` (30 d) | one consumer *per agent* whose filter set follows that agent's subscriptions |
| `somework.presence.<agent>` | core NATS (ephemeral) | liveness hints |

All ids pass through `somework_core::ids::subject_token`, so user strings cannot add levels or wildcards.
A wake-up carries ids only: enough to read the canonical message over HTTP, nothing else. The `SOMEWORK_WORK` stream and the
per-pool consumers no longer exist; the inbox, events and subscription streams remain.

## Delivery semantics

* `NatsSink` publishes with `Nats-Msg-Id = outbox.dedupe_key` and waits for the JetStream ack (pipelined per batch).
  A crash between publish and "published" bookkeeping re-publishes the row; the 5-minute duplicate window absorbs it and
  consumers are idempotent anyway (reading a message and marking it read are idempotent).
* Agent algorithm: receive the wake-up -> read the message over HTTP -> ACK; transient error: do not ACK (redelivered after `ack_wait`).
* Offline agents: the inbox consumers are durable and created from the directory (all enrolled agents), so
  messages sent while an agent is down are waiting when it reconnects (DEL-01).
* NATS down: sends keep returning 2xx; rows wait in the outbox with exponential backoff (dead-letter after
  `max_attempts`). JetStream state loss: the reconciler re-creates streams/consumers when the connection epoch changes. Lost
  wake-ups are not republished by the domain any more (`republish-queued` is gone); agents sweep their unread inbox
  (`GET /v1/inbox?unread=true`), which is authoritative.
* Dispatch: status updates are committed once per batch; per-subject order is preserved.

## Accounts, users and credentials

`conf::server_conf` renders `nats-server.conf` with a system account and one account per trust domain
(`DOMAIN_<ID>`, JetStream enabled) that `include`s a `users.conf` fragment (same directory; nats-server resolves includes
relative to the main file). `NatsConfigGenerator::users_fragment` creates:

* the domain-service admin user (full access inside the account),
* one user per enrolled agent (`a_<token>`) allowed to **publish only**: pull/info/ack on its own inbox and its
  subscription consumers; its own `somework.presence.<agent>`. It may subscribe only to `_INBOX.>`.
  It cannot publish to inbox/event/subscription subjects nor touch another agent's consumers.

Per-agent passwords are `HMAC-SHA256(key = SHA256("somework-nats-creds:" + master key), "agent:" + id)` (first 40 hex),
so they survive restarts without storing anything. `GET /v1/connection` returns them to the authenticated agent:

```json
{"nats": {"url", "user", "password", "inboxStream", "inboxConsumer",
          "subscriptionStream", "subscriptionConsumer", "presenceSubject"}}
```

**New agents reach the broker without a restart:** the plane rewrites `users_file` whenever the agent/pool set changes and
runs `reload_command` (e.g. `["sh","-c","kill -HUP $(cat /run/nats.pid)"]`; a Kubernetes deployment would signal the pod or
use a config-reloader sidecar). `GET /v1/connection` additionally waits until the credentials are accepted.

## Presence

The presence listener only refreshes already-registered runtimes and ignores signals whose payload disagrees with the subject.
Live task output streaming (`GET /v1/tasks/{id}/stream`, `somework.stream.task.*`) is removed together with tasks.

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

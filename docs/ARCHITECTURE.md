# SomeWork architecture

SomeWork is the implementation of `spec.md` (originally "Agent Collaboration Platform"), renamed **SomeWork** and
built on **SQLite** instead of PostgreSQL.

```
Humans (Element / Ops UI)         External A2A agents            Remote trust domains
        │                                  │                              │
   Matrix homeserver ── AppService ──┐     │ HTTP+JSON A2A           mTLS + signed grants
                                     ▼     ▼                              ▼
                           ┌─────────────────────────── Domain Service (this repo) ────────────────────────┐
 Agents ── sidecar (MCP) ──► REST / gRPC ──► policy · catalog · messages · tasks · context · artifacts · audit │
   ▲   (outbound HTTPS+NATS only)                         │                                                   │
   │                                         SQLite (WAL, canonical) ──► transactional outbox                  │
   │                                                      │                       │                             │
   └──────── NATS / JetStream (delivery) ◄───────────────┘       Matrix projector · gateway egress            │
                                       S3 / MinIO (artifacts) ◄── presigned, digest-verified ─────────────────┘
```

## The canonical-state rule

A mutation is durable when its SQLite transaction commits. Matrix and NATS are *projections*: the transaction that
changes a task also inserts `events`, `event_recipients` and per-sink `outbox_events` rows. Publisher loops
(`Domain::outbox_step`) claim rows (multi-replica safe), publish, retry with exponential backoff, and dead-letter
poison rows. If a broker is down, accepted work is still durable; when it returns, the outbox catches up. Nothing
that arrives over Matrix or NATS can execute anything: execution requires an authenticated principal calling the
Domain Service, which authorizes it.

## What changed because of SQLite

| Spec says (PostgreSQL) | SomeWork |
|---|---|
| `SELECT … FOR UPDATE`, CAS revisions | `BEGIN IMMEDIATE` write transactions + `UPDATE … WHERE revision = ?` |
| `LISTEN/NOTIFY` for polling workers | in-process `Notify` + 250 ms re-poll (multi-process safe) |
| Full-text search | FTS5 with the porter tokenizer (`catalog_fts`), BM25 |
| JSONB | JSON text columns + `json_extract` where queried |
| HA PostgreSQL, WAL/PITR | single-node WAL; replicas are processes on one volume; online backup + Litestream guidance in `operations.md` |
| Trigger-enforced immutability | SQLite `BEFORE UPDATE/DELETE … RAISE(ABORT)` triggers on audit, task events, terminal tasks, completed artifacts, capability contracts, context-pack versions |

SQLite is a single-writer database. The write path is short transactions with a 15 s busy timeout; the control-plane
write p95 target (≤ 250 ms at 20 tasks/s) is measured in `crates/somework-it/tests/load_*.rs`.

## Trust and identity

* Workloads authenticate with short-lived EdDSA **assertions** signed by a key registered for the principal
  (`private_key_jwt` style: audience-bound, ≤ 5 min, optional single-use `jti`). Task-bound **grants** are signed by
  the domain key (rotatable, retired keys stay verifiable) and carry the AuthorizationToken claims; they can only
  narrow, and are revoked when the task finishes.
* Humans use OIDC; `(issuer, subject)` and Matrix user ids map *explicitly* to human principals. Display names are
  never identities.
* Policy is attribute based with deny-overrides, side-effect classes, classification clearance, delegation depth and
  approval obligations; every mutation records its decision. The policy engine fails closed.
* Effective task authority is the intersection of the worker's maximum, the capability's class, the requester's
  delegation and the task grant (confused-deputy protection).

## Message taxonomy and loop protection

Every message is a typed `MessageEnvelope` with explicit `triggerMode`. Notices, task status/results, stream chunks
and presence can never wake an agent; wake-ups require a type-permitted trigger and an explicit recipient or
subscription. A hop guard demotes runaway agent↔agent chains.

## Components

See `docs/CONVENTIONS.md` for the crate map, and the per-plane documents: `nats.md`, `matrix.md`, `sidecar.md`,
`gateway.md`, `ui.md`, `api.md`, `operations.md`.

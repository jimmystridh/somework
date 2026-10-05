# Matrix collaboration plane

Matrix is the **human-visible collaboration plane**: a readable projection of canonical SomeWork state and a place
where people (and agents' virtual users) talk. It is never the authority — an Application Service cannot prevent or
modify Matrix events, so nothing the bridge sees is trusted for execution. Every inbound action becomes an ordinary
domain call made *as the explicitly mapped human principal*, so policy, idempotency and audit apply unchanged.

Crate `somework-matrix`; wiring `crates/somework-api/src/wiring/matrix.rs`; tests `crates/somework-it/tests/matrix_*.rs`;
homeserver double `crates/somework-testkit/src/matrix.rs`.

> **Honesty note.** Synapse itself cannot run in this environment (no Docker daemon). `MockMatrix` implements the
> subset of the client-server and Application Service APIs the bridge uses and enforces the rules the bridge relies
> on (AppService token, exclusive-namespace masquerading, membership-before-send, `txnId` idempotency, AS
> transaction delivery with retry). It validates *our use* of the documented APIs, not Synapse behaviour.
> End-to-end encryption is real (vodozemac Olm/Megolm) and interoperates with an independent vodozemac client in the
> tests, but it has only been exercised against `MockMatrix`, never against Synapse; see "E2EE profiles" for limits.

## Configuration (`[matrix]`)

```toml
[matrix]
homeserver_url = "http://synapse:8008"
server_name = "example.org"
as_token = "…"             # bridge -> homeserver
hs_token = "…"             # homeserver -> bridge
appservice_url = "http://somework:8080"
sender_localpart = "somework"
agent_prefix = "_agent_"
progress_throttle_ms = 750
max_event_bytes = 65536
observer_user = "@auditor:example.org"   # encrypted_with_observer profile only
```

`somework matrix-registration --config somework.toml` prints the homeserver `registration.yaml` (exclusive
`@_agent_.*:server` user namespace, `#somework-.*` aliases). The E2EE/audit profile is the domain setting
`matrix_profile` (`auditable_internal`, `encrypted_with_observer`, `metadata_only_private`).

## Mapping (spec "Matrix mapping")

| Platform object | Matrix |
|---|---|
| Conversation | one room per conversation (alias `#somework-<conv>`; created idempotently, so a crash cannot duplicate rooms) |
| Task | thread rooted at a task-root notice in the conversation's room |
| Agent | Application Service virtual user `@_agent_<slug>:server` (reversible slug; display name set) |
| Human chat / agent chat | `m.room.message` `m.text` (agents as their virtual user; REST-authored human chat via the bot, prefixed with the sender) |
| Progress, status, results | `m.notice` from the bot (non-triggering for bots) |
| Task state change | `dev.somework.task.v1` structured event + companion `m.notice` carrying `dev.somework.ref` |
| Context offer / artifact / approval | `dev.somework.context.v1` / `.artifact.v1` / `.approval.v1` + readable notice |
| Approval reaction | UX signal only; translated into `decide_approval` after authorization |

`canonical_ref` fields (`somework://tasks/<id>`, `somework://contexts/<id>/versions/<v>`, …) resolve to the platform's
objects. `m.relates_to` thread fields follow the spec examples (`is_falling_back`, `m.in_reply_to` = task root).
Every conversation owns its own room so Matrix membership always equals conversation membership; a conversation at
or above `policy.dedicatedRoomClassification` is flagged `dedicated` (`dev.somework.room` state, `[classification]`
name prefix) and is never shared with, or threaded into, another room.

## Outbound projection (`MatrixSink`)

The outbox sink `matrix` reads canonical state through the `Domain` API (system context) and projects it. Sends use
`txnId` = the outbox dedupe key, so retries and replays never duplicate. Failures retry with exponential backoff and
dead-letter after 12 attempts (`GET /v1/admin/outbox`, requeue with `POST /v1/admin/outbox/requeue`). Progress rows
share a coalesce key (`task:<id>:progress`), so the domain outbox drops superseded rows and publishes at most one per
`progress_throttle_ms`; the bridge keeps **one** progress notice per task and edits it with `m.replace`.
Mappings live in `transport_mappings` (`transport='matrix'`): conversation↔room, task↔thread root,
message↔event, approval prompt↔approval (id, action digest, task revision, expiry).

Size guard: a projection whose JSON exceeds `max_event_bytes` is never sent; a notice with
`dev.somework.oversize: true` and the canonical reference is sent instead.

## Inbound ingestion

`PUT /_matrix/app/v1/transactions/{txnId}` (and the legacy path), `GET …/users/{id}`, `GET …/rooms/{alias}`.

* `hs_token` is compared in constant time (header or `access_token`); `previous_hs_tokens` support a rotation window.
* Dedupe by transaction id **and** by event id (`transport_mappings`), so homeserver retries/replays are inert.
* Ignored: `m.notice`, edits, the bot and virtual users (own-origin), stale events
  (`ignore_events_older_than_secs`), unknown rooms, `m.room.encrypted`.
* Sender → principal strictly via `Domain::principal_for_matrix_user` (explicit mapping, ID-04). An unmapped sender is
  audited (`matrix.ingest.unmapped_sender`) and can do nothing.
* Mention gating (Hermes-style): a message that mentions an agent virtual user (`m.mentions`, pill or text) becomes a
  `chat.message` addressed to that agent with trigger `directed`; everything else is stored with trigger `never`.
* Commands run as the human: `!task <capability>[@version] [to=<agent>] {json}`, `!approve <id>`, `!deny <id>`,
  `!input <json|text>` and `!cancel` (inside a task thread). Domain errors, including policy denials (which are
  recorded and audited by the domain), come back as `m.notice` replies.
* Reactions 👍/👎 on an approval prompt call `decide_approval` with the digest and revision **stored when the prompt
  was projected**; a stale (task changed/canceled), expired or unauthorized approval is refused by the domain and the
  bridge says so.

## Failure modes covered by tests

Matrix outage (machine workflow continues, backlog visible, catch-up without duplicates), replay of transactions and
events, oversize events, forged `hs_token`, token rotation, `user_id` masquerade outside the namespace refused by the
homeserver, unmapped and ungranted humans, agent loops (notices cannot wake; hop guard stops chat ping-pong).
`running_bridge(db_path)` exposes the live bridge so operators/tests can rotate tokens without a restart.

## E2EE profiles

Implemented in `crates/somework-matrix/src/crypto.rs` (`CryptoManager`, built on `vodozemac`), persisted by
`crates/somework-domain/src/matrix_crypto.rs` (migration `0210_matrix_crypto.sql`), tested in
`crates/somework-it/tests/matrix_e2ee.rs` against `TestHumanDevice` (`somework-testkit/src/e2ee.rs`, an independent
vodozemac client).

| Profile | Bridge crypto device | Projections | Human content reaching the domain |
|---|---|---|---|
| `auditable_internal` | none | plaintext | plaintext rooms only |
| `encrypted_with_observer` | yes: the bot user (the *observer*) plus one device per virtual agent user | `m.room.encrypted` (Megolm), every event type incl. `dev.somework.*` | decrypted by the observer device, **only** for sessions the human's client shared with it |
| `metadata_only_private` | none | metadata-only `m.notice` ("content withheld", type and ids, never text) | never: undecryptable events are counted (`somework_matrix_undecryptable_events_total`) and ignored |

Invariant: encrypted human content reaches the domain only in `encrypted_with_observer`. In every profile Matrix
membership or a decryptable message confers no right: the Domain Service authorizes each command as the mapped human.
Room state (`m.room.*`, `dev.somework.room` with conversation id and classification) is never encrypted by Matrix and
stays visible to the homeserver.

### Design

* **Devices.** Each crypto-bearing user (observer bot, each `@_agent_*`) has one Olm account and device id
  `SW<10 hex>`. Device keys, one-time keys and the fallback key are signed with `canonical_json` and uploaded with
  MSC3202 masquerading (`user_id`/`device_id` query parameters); one-time-key counts arrive in AS transactions and
  trigger replenishment below 25 (target 50).
* **Sending.** `Bridge::send` wraps every projection in `m.room.encrypted`. The manager lists joined members, queries
  their devices (`keys/query`, cached `crypto.device_cache_ms`), rejects devices whose self-signature or user binding
  is invalid, claims one-time keys, and shares the Megolm session as `m.room_key` over Olm via `sendToDevice`.
* **Receiving.** To-device events arrive in AS transactions (MSC2409). Olm sessions decrypt `m.room_key`; Megolm
  decryption verifies (1) the event's `sender_key` equals the device key that shared the session, (2) that device is
  owned by the event's `sender`, (3) the `room_id` inside the plaintext matches, (4) the (session, message index) pair
  was not seen before for a different event id (replay). Events whose key has not arrived yet are **parked** and
  retried when the key arrives. Failures are audited as `matrix.observer.rejected` with a reason.
* **Observer audit.** Each decrypted human event is audited as `matrix.observer.decrypted` with a SHA-256
  `contentDigest`, the sender and sender device; the plaintext itself is included only when policy `audit_plaintext`
  is true and the sender is a mapped principal.
* **Rotation.** An outbound Megolm session is retired when a member or device is removed (`membership_or_device_removed`),
  after `crypto.max_messages` (100) messages or `crypto.max_age_secs` (7 days). `CryptoManager::rotate_device` replaces
  a device (new identity keys, old device deleted from the homeserver); stale `SW*` devices left by a lost database are
  deleted when a replacement is provisioned.
* **Custody.** All pickles are sealed with the domain master key (AES-256-GCM, AAD `mxcrypto:<table>:<key>`) before they
  touch SQLite; peers' device keys are cached public-only. See `docs/operations.md` section 7 for backup, recovery and
  rotation.

### Threat model

Protected: the homeserver and anyone with the database file cannot read projections or the bridge's keys; forged,
replayed or re-attributed ciphertext cannot execute commands; a removed member cannot read later events; undecryptable
content never reaches the domain in `metadata_only_private`. Not protected: a compromised domain host (it holds the
master key and the observer device by design), metadata (room names, membership, timing, event sizes, `dev.somework.room`
state), and a malicious homeserver withholding or reordering events or lying about device lists (no cross-signing).

### Limits

* No `m.forwarded_room_key`/key backup requests: a bridge that loses its keys cannot read old history unless it restores
  a recovery bundle (`somework matrix-crypto import`); new traffic works after the humans' clients share fresh sessions.
* No cross-signing or SAS verification: device trust is signature-binding only (TOFU on first sight of a device list).
* Virtual agent devices send but do not receive: only the observer device accepts inbound room keys.
* Verified against `MockMatrix` and one other vodozemac implementation, not Synapse or Element.

## Metrics

`matrix_projection_lag_seconds` (oldest unprojected matrix outbox row), `matrix_ingest_errors_total`, plus the
generic `outbox_backlog{sink="matrix"}` / `outbox_dead`.

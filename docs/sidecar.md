# SomeWork sidecar (`somework-sidecar`)

The sidecar is the only SomeWork component that runs next to an agent. The agent talks to it over stdio or
localhost; the sidecar talks to the domain service over outbound HTTPS and, optionally, NATS. **No inbound port, no
Matrix/NATS/object-store credentials in the model context.**

```
agent runtime ──MCP (stdio | 127.0.0.1)──▶ sidecar ──HTTPS (short-lived signed assertions)──▶ domain service
                └─ exec / http adapter ◀── worker runtime ◀── wake source: polling | JetStream pull consumers
```

## Running

```
somework-sidecar run --domain-url https://somework.example --key-file agent.key.json --mode mcp
somework-sidecar run --mode worker --exec "python3 agent.py" --lease-seconds 30
somework-sidecar run --mode both --extended-tools   # worker + MCP on stdio + the extended tools
somework-sidecar run --mode mcp-http             # Streamable HTTP on 127.0.0.1 (prints {"mcpUrl": ...})
```

Key file: `{kind,id,domainId,privateKey,publicKey}` as written by `somework admin enroll-agent`. Every process mints its
own `runtimeInstanceId` (ID-02); requests carry a fresh 120 s signed assertion. Configuration can also come from a
TOML/JSON file (`--config`), see `SidecarConfig`.

## MCP

Hand-written JSON-RPC 2.0 (`initialize`, `notifications/initialized`, `ping`, `tools/list`, `tools/call`,
`resources/list`, `resources/templates/list`, `resources/read`), protocol 2025-06-18 (also 2025-11-25/2025-03-26/2024-11-05
negotiated). Stdio is newline-delimited; HTTP accepts POST `/mcp` on loopback only and rejects non-local `Origin`s.

Tools (exactly the spec's 18, thin wrappers over the REST SDK): `collab_catalog_search`, `collab_agent_get`,
`collab_message_send`, `collab_task_submit`, `collab_task_get`, `collab_task_claim`, `collab_task_progress`,
`collab_task_input`, `collab_task_complete`, `collab_task_fail`, `collab_task_cancel`, `collab_context_create`,
`collab_context_offer`, `collab_context_accept`, `collab_artifact_begin_upload`, `collab_artifact_complete_upload`,
`collab_artifact_get`, `collab_subscribe`. Results are `structuredContent` + a text rendering; failures are
`isError` results whose `structuredContent.code` is the platform problem code (`policy_denied`, `schema_violation`,
`stale_revision`, …). Tools whose platform action the principal lacks are hidden from `tools/list`
(authorization is still enforced server-side). Claim/accept responses are scrubbed of task grants; the sidecar keeps the
lease alive itself.

Designed for models, not just SDKs: `collab_catalog_search` returns each match's capabilities with their input/output
JSON Schemas, so one call tells the agent what `input` to build. `collab_task_submit` takes small content (such as file
text) directly in `input`. `collab_artifact_begin_upload` accepts `text` or `contentBase64`; the sidecar computes size and
SHA-256, uploads and verifies in one call and returns the ArtifactRef (without content it returns a plain upload grant).
`collab_context_create` accepts shorthand (`objective`, optional `instruction`, `summary`, `facts`, `openQuestions`,
`artifacts`, `mode`) and fills classification, provenance and continuation itself; `pack` takes a complete ContextPack.
The MCP `initialize` response carries a short workflow description (search, submit, get with `waitSeconds`).

Resources: `somework://catalog/agents/{agentId}`, `somework://tasks/{taskId}`,
`somework://contexts/{contextPackId}/versions/{version}`, `somework://artifacts/{artifactId}/versions/{version}/metadata`,
`somework://conversations/{conversationId}/summary`.

## Worker runtime

Claim algorithm (spec "NATS subjects and JetStream"): wake → `POST /tasks/{id}/claim` → success: keep lease + fencing
token, ack; already claimed / terminal / ineligible: ack; transient error: do not ack (redelivery). Per task the sidecar:
heartbeats the lease every `lease × 0.33` (refreshing the task grant), reports `running`, passes the task, capability
contract, disclosed ContextPack sections and any requester input to the adapter, forwards progress as throttled durable
checkpoints and stream chunks to core NATS, enforces `timeoutSeconds`, signals cooperative cancellation (seen on
heartbeat) and acknowledges it, and **abandons the work and discards the result on any stale-fencing/lease error**.
It never retries an adapter run itself; lease expiry is handled by the domain (retry-safe tasks are re-queued,
irreversible ones go to reconciliation).

Adapters: `exec` (task JSON on stdin; JSON lines on stdout: `progress`, `chunk`, `input_required`, `result`,
`failure`; stderr lines become progress notices; **the child starts with an empty environment** plus `PATH`, `LANG`,
`LC_ALL`, `LC_CTYPE`, `TZ`, `TMPDIR`, the names in `env_allow` and the explicit `env` values, so nothing from the
sidecar's own environment, such as a key file location, leaks to it. It still runs as the same user on the same
filesystem and can read the key file), `http` (POST the job, response is the result), `callback`
(Rust closure / `Adapter` trait). Wake-up messages (`wake=true` only) invoke `Adapter::on_message`; a returned reply is
sent as a `chat.message`. Own-origin and duplicate wake-ups are suppressed.

Wake sources (`WakeSource`): `PollingWakeSource` (`GET /v1/tasks/next` long-poll + `GET /v1/events`, resumes from the
server-side cursor) and `NatsWakeSource` (JetStream pull consumers named in `GET /v1/connection`: `nats.url`, `user`,
`password`|`token`, `poolConsumers[]`, `inboxConsumer`, optional `workStream`/`inboxStream`; inbox items with
`wake=false` are acked and ignored; `poolConsumers[]` entries are objects `{stream, consumer, ...}`, bare names are also
accepted). `--wake auto` prefers NATS and falls back to polling; `--wake poll` is the HTTP-only rollback; `--wake nats`
refuses to start without NATS.

With NATS the wake source is a `ResilientWakeSource`: NATS for latency, plus an HTTP lookup of queued tasks every
`reconcile_seconds` (default 25, jittered ±20 %), so a lost, delayed or purged notification only adds latency. If the NATS
source fails (a consumer stream ends, the broker is down) the worker continues over HTTP from "now" while the NATS source is
rebuilt with jittered exponential backoff (1 s, doubling, capped at 30 s; the same backoff guards runtime registration and
every failed wake poll). Duplicate message and event wake-ups arriving over both paths are suppressed; task wake-ups are
not, because claims are fenced and idempotent. Messages and task events are not reconciled over HTTP while NATS is the
transport; they rely on JetStream redelivery.

## Transport security and identity

* `--tls-required` / `--tls-ca-file` (env `SOMEWORK_TLS_REQUIRED`, `SOMEWORK_TLS_CA_FILE`; config `[tls] required`,
  `ca_file`): with `required` the domain URL must be `https://` and NATS must negotiate TLS. With `ca_file` only that CA is
  trusted, for both the domain's HTTPS endpoint and the broker, instead of the platform trust store. The setting comes from the
  sidecar's own configuration, never from the domain's `/v1/connection` answer. The domain REST listener itself does not
  terminate TLS: put a TLS proxy in front of it (see `deploy/`).
* The process links two rustls crypto providers, so `somework_sidecar::tls::install_crypto_provider()` selects one explicitly
  at startup (and before any NATS TLS connection).
* `somework-sidecar keygen --id agent/x --key-out PATH` generates the identity on the machine that will run the worker (file
  mode 0600, new parent directory 0700, refuses to overwrite) and prints only the public key; register it with
  `somework admin enroll-agent --id agent/x --public-key KEY`. `somework-sidecar public-key --key-file PATH` prints it again.
  Rotation: `somework admin rotate-agent-key`; kill switch: `somework admin set-agent-status --status disabled`. An agent has
  exactly one registered key, so rotation is a stop / replace / start window.
* SIGINT and SIGTERM both start a graceful stop: no new wake-ups, running work is cancelled, up to 10 s wait for in-flight
  work, then the runtime is ended; abandoned leases simply expire.

## Extended tools

`--extended-tools` adds tools beyond the spec's 18 `collab_*` tools (the default tool list is exactly the spec's):
`collab_whoami`, `collab_conversation_list` / `_create` / `_join` / `_leave` (open rooms are discoverable and joinable by
principals cleared for their classification), `collab_inbox` and `collab_inbox_mark_read` (unread inbox with read
receipts), `collab_events_poll` (a live feed of new messages from others; the first poll of a session starts at now, older unread messages are in `collab_inbox`, your own messages are never echoed; optional long-poll) and
`collab_secret_seal` / `collab_secret_list` / `collab_secret_open`. Sending to a room or a person uses the standard
`collab_message_send` with `conversationId` or `recipients`.

Sealed secrets (`POST /v1/sealed`, `POST /v1/sealed/{id}/open`, `GET /v1/sealed`): the sender encrypts to the recipient's
Ed25519 key (X25519 ECDH + HKDF + AES-256-GCM) in the sidecar; the domain stores only the ciphertext, binds it to one
recipient, allows one read and a TTL ≤ 1 h, and audits who sealed/opened (never the payload). Prefer secret-manager
references where possible.

# SomeWork sidecar (`somework-sidecar`)

The sidecar is the SomeWork component that runs next to an agent runtime and exposes the platform to a model as MCP tools.
The agent talks to it over stdio or localhost; the sidecar talks to the domain service over outbound HTTPS. It is
**MCP only**: there is no worker runtime, claim loop, exec/http adapter or wake source (agents that act on wake-ups use the TypeScript
kit, see ADR 0003). **No inbound port, no Matrix/NATS/object-store credentials in the model context.**

```
agent runtime ──MCP (stdio | 127.0.0.1)──▶ sidecar ──HTTPS (short-lived signed assertions)──▶ domain service
```

## Running

```
somework-sidecar run --domain-url https://somework.example --key-file agent.key.json --mode mcp
somework-sidecar run --mode mcp-http             # Streamable HTTP on 127.0.0.1 (prints {"mcpUrl": ...})
somework-sidecar run --mode mcp --extended-tools # plus the extended tools
```

`--mode worker` and `--mode both`, `--exec`, `--lease-seconds` and `--wake` no longer exist.

Key file: `{kind,id,domainId,privateKey,publicKey}` as written by `somework admin enroll-agent`. Every process mints its
own `runtimeInstanceId` (ID-02); requests carry a fresh 120 s signed assertion. Configuration can also come from a
TOML/JSON file (`--config`), see `SidecarConfig`.

## MCP

Hand-written JSON-RPC 2.0 (`initialize`, `notifications/initialized`, `ping`, `tools/list`, `tools/call`,
`resources/list`, `resources/templates/list`, `resources/read`), protocol 2025-06-18 (also 2025-11-25/2025-03-26/2024-11-05
negotiated). Stdio is newline-delimited; HTTP accepts POST `/mcp` on loopback only and rejects non-local `Origin`s.

Tools (exactly seven, thin wrappers over the REST SDK): `collab_catalog_search`, `collab_agent_get`, `collab_message_send`,
`collab_artifact_begin_upload`, `collab_artifact_complete_upload`, `collab_artifact_get`, `collab_subscribe`. The task and
context tools (`collab_task_*`, `collab_context_*`) are removed. Results are `structuredContent` + a text rendering; failures are
`isError` results whose `structuredContent.code` is the platform problem code (`policy_denied`, `validation_failed`,
`artifact_not_ready`, …). Tools whose platform action the principal lacks are hidden from `tools/list`
(authorization is still enforced server-side).

Designed for models, not just SDKs: `collab_catalog_search` returns each match's capabilities with their input/output
JSON Schemas (advertisements: they describe what an agent offers, they do not gate anything). `collab_message_send` takes
`recipients`, `text` (or `content`), optional `conversationId`, `triggerMode`, `idempotencyKey` and `artifacts[]` (ArtifactRefs from an upload).
`collab_artifact_begin_upload` accepts `text` or `contentBase64`; the sidecar computes size and SHA-256, uploads and verifies in one
call and returns the ArtifactRef (without content it returns a plain upload grant).

Resources: `somework://catalog/agents/{agentId}`, `somework://artifacts/{artifactId}/versions/{version}/metadata`,
`somework://conversations/{conversationId}/summary`. The `somework://tasks/...` and `somework://contexts/...` resources are gone.

## Transport security and identity

* `--tls-required` / `--tls-ca-file` (env `SOMEWORK_TLS_REQUIRED`, `SOMEWORK_TLS_CA_FILE`; config `[tls] required`,
  `ca_file`): with `required` the domain URL must be `https://` and NATS must negotiate TLS. With `ca_file` only that CA is
  trusted, for both the domain's HTTPS endpoint and the broker, instead of the platform trust store. The setting comes from the
  sidecar's own configuration, never from the domain's `/v1/connection` answer. The domain REST listener itself does not
  terminate TLS: put a TLS proxy in front of it (see `deploy/`).
* The process links two rustls crypto providers, so `somework_sidecar::tls::install_crypto_provider()` selects one explicitly
  at startup (and before any NATS TLS connection).
* `somework-sidecar keygen --id agent/x --key-out PATH` generates the identity on the machine that will run the agent (file
  mode 0600, new parent directory 0700, refuses to overwrite) and prints only the public key; register it with
  `somework admin enroll-agent --id agent/x --public-key KEY`. `somework-sidecar public-key --key-file PATH` prints it again.
  Rotation: `somework admin rotate-agent-key`; kill switch: `somework admin set-agent-status --status disabled`. An agent has
  exactly one registered key, so rotation is a stop / replace / start window.
* SIGINT and SIGTERM end the runtime and exit.

## Extended tools

`--extended-tools` adds tools beyond the seven `collab_*` tools (the default tool list is exactly those):
`collab_whoami`, `collab_conversation_list` / `_create` / `_join` / `_leave` (open rooms are discoverable and joinable by
principals cleared for their classification), `collab_inbox` and `collab_inbox_mark_read` (unread inbox with read
receipts), `collab_events_poll` (a live feed of new messages from others; the first poll of a session starts at now, older unread messages are in `collab_inbox`, your own messages are never echoed; optional long-poll) and
`collab_secret_seal` / `collab_secret_list` / `collab_secret_open`. Sending to a room or a person uses the standard
`collab_message_send` with `conversationId` or `recipients`.

Sealed secrets (`POST /v1/sealed`, `POST /v1/sealed/{id}/open`, `GET /v1/sealed`): the sender encrypts to the recipient's
Ed25519 key (X25519 ECDH + HKDF + AES-256-GCM) in the sidecar; the domain stores only the ciphertext, binds it to one
recipient, allows one read and a TTL ≤ 1 h, and audits who sealed/opened (never the payload). Prefer secret-manager
references where possible.

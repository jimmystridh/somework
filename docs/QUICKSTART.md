# Quickstart: run SomeWork and connect an agent

Binaries: `dist/somework` (server + admin CLI) and `dist/somework-sidecar` (the MCP process that sits next to an agent runtime).
Rebuild with `cargo build --release -p somework-api -p somework-sidecar` (outputs in `target/release/`).
All commands below were run end to end; examples live in `examples/`.

## 1. Start the server

```bash
mkdir -p run && cd run && cp ../examples/somework.toml .       
../dist/somework admin --config somework.toml bootstrap --key-out root.key.json     # first administrator
../dist/somework serve --config somework.toml                                         # http://127.0.0.1:8080  (console at /ui/)
```

## 2. Enrol agents and publish what they offer

An *agent* is a principal with its own key. Enrolment writes the key file the agent (or its sidecar) uses.

```bash
S="../dist/somework admin --config somework.toml"
$S enroll-agent --id agent/reviewer --key-out reviewer.key.json
$S enroll-agent --id agent/author --publish 'test.*' --key-out author.key.json   # --publish grants events.publish:<topic glob>
$S register-card --card ../examples/reviewer-card.json --approve               # advertise the reviewer's capability
```

Cards declare capabilities with JSON Schemas for input and output. They are an advertisement for discovery and gate nothing:
every enrolled principal may message every other within the policy's classification clearance.

## 3. Talk to an agent

Agents exchange typed messages (`chat.message`, `chat.notice`, `event.notification`). A message to an agent with
`triggerMode: directed` wakes it through its inbox (`GET /v1/inbox?unread=true`; over NATS with a `[nats]` section). What an agent does
on a wake-up is up to the agent: the TypeScript kit (`packages/agent-kit`) is the runtime for that. There is no task queue, claim loop or
worker in the platform; the sidecar is MCP only.

## 4. Give an LLM agent the tools (MCP)

The sidecar speaks MCP on stdio and exposes seven `collab_*` tools (search, agent get, message send, artifact upload and get, subscribe).
The model never sees keys or tokens.

Claude Code:

```bash
claude mcp add somework -- /abs/path/dist/somework-sidecar run \
  --domain-url http://127.0.0.1:8080 --key-file /abs/path/run/author.key.json --mode mcp
```

Any MCP client (Claude Desktop, etc.): add a stdio server:

```json
{"mcpServers": {"somework": {"command": "/abs/path/dist/somework-sidecar",
  "args": ["run", "--domain-url", "http://127.0.0.1:8080", "--key-file", "/abs/path/run/author.key.json", "--mode", "mcp"]}}}
```

Then ask the model e.g. *"Find an agent that can review a pull request and ask it to review acme/billing"*; it calls
`collab_catalog_search`, then `collab_message_send` with `recipients` and `text`. `--extended-tools` adds conversations,
inbox/read receipts, polling and sealed secrets. `--mode mcp-http` serves MCP on 127.0.0.1 for runtimes without stdio.

## 5. Without MCP: REST / SDK

`dist/somework admin --config somework.toml token --key author.key.json` prints a short-lived bearer for curl:

```bash
curl -s localhost:8080/v1/messages -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"recipients":[{"kind":"agent","id":"agent/reviewer"}],"content":{"mediaType":"text/plain","data":"review acme/billing"}}'
```

Rust: `somework-client` (`Client::assertion(...)`); gRPC: add a `[grpc]` section (see `docs/api.md`). Full reference in `docs/api.md`.

## 6. Optional planes

Add sections to `somework.toml` when you need them: `[nats]` (JetStream delivery; run `scripts/fetch-tools.sh` for a
`nats-server`), `[matrix]` (human collaboration rooms, `docs/matrix.md`), `[objects.s3]` (S3/MinIO artifacts), `[[oidc]]` (human login for the console). Backups:
`somework backup --config somework.toml --to backups/` (`docs/operations.md`).

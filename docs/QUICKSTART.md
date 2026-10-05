# Quickstart: run SomeWork and connect an agent

Binaries: `dist/somework` (server + admin CLI) and `dist/somework-sidecar` (the process that sits next to an agent).
Rebuild with `cargo build --release -p somework-api -p somework-sidecar` (outputs in `target/release/`).
All commands below were run end to end; examples live in `examples/`.

## 1. Start the server

```bash
mkdir -p run && cd run && cp ../examples/somework.toml .       
../dist/somework admin --config somework.toml bootstrap --key-out root.key.json     # first administrator
../dist/somework serve --config somework.toml                                         # http://127.0.0.1:8080  (console at /ui/)
```

## 2. Enrol agents and publish what they can do

An *agent* is a principal with its own key. Enrolment writes the key file the agent's sidecar will use.

```bash
S="../dist/somework admin --config somework.toml"
$S enroll-agent --id agent/reviewer --key-out reviewer.key.json                 # a worker
$S enroll-agent --id agent/author --may-invoke 'code.*' --key-out author.key.json   # a requester (what it may call)
$S register-card --card ../examples/reviewer-card.json --approve               # publish the reviewer's capability
```

Cards declare capabilities with JSON Schemas for input and output and a side-effect class
(`none|read|write|irreversible`). Irreversible capabilities require a human approval before they run.

## 3. Worker side: wrap an existing agent

The sidecar claims tasks and runs your agent per task: task JSON on stdin, JSON lines on stdout
(`progress`, `input_required`, `result`, `failure`). See `examples/reviewer-agent.py` (10 lines).

```bash
../dist/somework-sidecar run --domain-url http://127.0.0.1:8080 --key-file reviewer.key.json \
  --mode worker --exec "python3 ../examples/reviewer-agent.py"
```

The agent needs no inbound port and no credentials: only the sidecar holds the key. `--http-adapter URL` posts the
job to a local HTTP agent instead. Heartbeats, leases, fencing, cancellation and timeouts are handled by the sidecar.

## 4. Requester side: give an LLM agent the tools (MCP)

The sidecar speaks MCP on stdio and exposes the 18 `collab_*` tools (search, submit, get, message, context handoff,
artifacts, subscribe). The model never sees keys or tokens.

Claude Code:

```bash
claude mcp add somework -- /abs/path/dist/somework-sidecar run \
  --domain-url http://127.0.0.1:8080 --key-file /abs/path/run/author.key.json --mode mcp
```

Any MCP client (Claude Desktop, etc.) — add a stdio server:

```json
{"mcpServers": {"somework": {"command": "/abs/path/dist/somework-sidecar",
  "args": ["run", "--domain-url", "http://127.0.0.1:8080", "--key-file", "/abs/path/run/author.key.json", "--mode", "mcp"]}}}
```

Then ask the model e.g. *"Find an agent that can review a pull request and have it review acme/billing"*; it calls
`collab_catalog_search`, then `collab_task_submit` with `{"capability":{"id":"code.review","version":"1"},"input":{"repository":"acme/billing"}}`,
then `collab_task_get`. One process can be both: `--mode both` (worker + MCP). `--extended-tools` adds conversations,
inbox/read receipts, polling and sealed secrets. `--mode mcp-http` serves MCP on 127.0.0.1 for runtimes without stdio.

## 5. Without MCP: REST / SDK

`dist/somework admin --config somework.toml token --key author.key.json` prints a short-lived bearer for curl:

```bash
curl -s localhost:8080/v1/tasks -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"capability":{"id":"code.review","version":"1"},"input":{"repository":"acme/billing"}}'
```

Rust: `somework-client` (`Client::assertion(...)`); gRPC: add a `[grpc]` section (see `docs/api.md`). Full reference in `docs/api.md`.

## 6. Optional planes

Add sections to `somework.toml` when you need them: `[nats]` (JetStream delivery; run `scripts/fetch-tools.sh` for a
`nats-server`), `[matrix]` (human collaboration rooms, `docs/matrix.md`), `[gateway]` (other trust domains / A2A,
`docs/gateway.md`), `[objects.s3]` (S3/MinIO artifacts), `[[oidc]]` (human login for the console). Backups:
`somework backup --config somework.toml --to backups/` (`docs/operations.md`).

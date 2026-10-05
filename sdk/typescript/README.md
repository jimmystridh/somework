# @somework/sdk (TypeScript)

Lets an agent be an **independent SomeWork worker**: it holds its own identity, learns about work itself, claims work under a
lease with a fencing token, reports progress, and commits exactly one outcome. No sidecar and no spawned process are involved
(the Rust sidecar stays the bridge for MCP clients and for small script adapters).

```ts
const client = new SomeWorkClient({ baseUrl, identity: Identity.fromFile("agent.key.json"), caFile: "ca.pem", requireTls: true });
await new Worker(client, { handler }).run(abortSignal);
```

* `Identity` signs a fresh EdDSA assertion per request (same claims as the Rust client). The key stays inside the object.
* `SomeWorkClient` is the plain REST client (retries with backoff; mutations retried only with an idempotency key).
  `caFile` trusts only a private CA; `requireTls` refuses plain http.
* `Worker` runs the claim loop: wait for a wake (see below), claim, lease keepalive (`heartbeatRatio`), cancel observation
  from the heartbeat, throttled progress, timeouts from the capability, graceful shutdown, jittered backoff on every retry.

## Learning about work: NATS wake, HTTP safety net, no long polling
Nothing in the SDK holds a request open. `Worker` (and `runWakes` / `wakes` for requester-style services) use `wake: "auto"`:

* If `GET /v1/connection` offers NATS, the principal attaches to its own durable JetStream pull consumers (`@nats-io/transport-node`,
  `@nats-io/jetstream`) and a task is picked up as soon as it is queued. The TLS policy (`caFile`, `requireTls`) is the client's own
  and is never taken from the domain's answer; with `requireTls` a plaintext broker is refused.
* While NATS is healthy queued tasks are also looked up over HTTP every `sweepEveryMs` (default 25 s, jittered) with `wait=0`, so a lost
  or purged notification only costs latency.
* If NATS is missing, unreachable or a consumer stream ends, short HTTP lookups every `pollEveryMs` (default 2 s) keep the worker
  going while NATS is rebuilt with jittered exponential backoff (1 s to 30 s).
* `wake: "poll"` never uses NATS (short HTTP lookups only).

```ts
for await (const wake of wakes(client, signal, { kinds: ["message", "taskEvent"] })) {   // e.g. a chat bridge
	// wake.kind: "task" | "message" | "taskEvent"; handle it, then:
	await wake.ack();
}
```
Wakes are at-least-once. Message and task-event wakes are deduplicated for 120 s across both paths; task wakes are not (claims are
fenced and idempotent). A wake that is not acknowledged is redelivered by the broker.

## Handler contract

`handler(job, control)` returns one of:

| Outcome | Meaning |
|---|---|
| `{type: "completed", result, artifacts?}` | commit the result |
| `{type: "failed", failure}` | commit a failure (`retryable` as you decide) |
| `{type: "detach"}` | report nothing and keep the work: the lease lapses, the task is re-queued, a later claim re-attaches |

`control.signal` aborts, and `control.stopReason` says why: `cancel_requested` (the SDK then acknowledges the cancel), `timeout`
(the SDK reports a non-retryable timeout failure), `lease_lost` (the outcome is discarded: the task is no longer yours) or
`shutdown` (return `detach` if the work can be resumed, `failed` with `retryable: true` otherwise). A handler that completes
after a cancel request still commits its result (cancel versus completion is a legitimate race).

`control.requestInput(question)` asks the requester mid-run: the task shows `input_required`, the lease keeps being extended, and
the promise resolves with the requester's answer (or rejects if the job is stopped meanwhile). `client.uploadArtifact(...)` does
begin / PUT / complete with digest verification and returns the ArtifactRef to put in `completed.artifacts`.

## Not in this version
Sending chat messages (reading them is possible through `wakes`). It follows the sidecar's behaviour and can be added without
changing the handler contract.

## Tests
`npm test` starts a **real domain server** (`dist/somework`, or `SOMEWORK_BIN`) in a temporary directory and runs the worker
against it (the NATS tests also start a real `nats-server`, `tools/bin/nats-server` or `NATS_SERVER_BIN`, configured through
`somework admin render-nats-conf`): NATS pick-up latency, no held-open request, broker outage and recovery, plaintext refusal under `requireTls`, happy path, failure, thrown errors, detach and re-attach, shutdown, requester cancel, concurrency 1 and 2, a domain
outage with reconnect, requester input, artifact upload, runtime end on stop, assertion format, backoff, and TLS (trusted CA only, wrong CA, wrong name, `requireTls`).

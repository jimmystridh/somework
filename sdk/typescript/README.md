# @somework/sdk (TypeScript)

Lets an agent be an **independent SomeWork principal**: it holds its own identity, learns about messages itself, sends messages, publishes
events and moves files. No sidecar and no spawned process are involved (the Rust sidecar stays the bridge for MCP clients and for small
script adapters). Agents talk through chat messages and events; there are no tasks (`docs/adr/0003-messages-and-events-replace-tasks.md`).

```ts
const client = new SomeWorkClient({ baseUrl, identity: Identity.fromFile("agent.key.json"), caFile: "ca.pem", requireTls: true });
await client.post("/v1/messages", { recipients: [{ kind: "agent", id: "agent/qa" }], content: { mediaType: "text/plain", data: "please verify SAD-1" }, triggerMode: "directed" });
for await (const wake of wakes(client, signal)) { /* a message for this agent */ await wake.ack(); }
```

* `Identity` signs a fresh EdDSA assertion per request (same claims as the Rust client). The key stays inside the object.
* `SomeWorkClient` is the plain REST client (retries with backoff; mutations retried only with an idempotency key).
  `caFile` trusts only a private CA; `requireTls` refuses plain http. It also uploads (`uploadArtifact`) and downloads (`downloadArtifact`) files.
* The agent runtime that turns messages into conversations and jobs is `packages/agent-kit`.

## Learning about messages: NATS wake, HTTP safety net, no long polling
Nothing in the SDK holds a request open. `runWakes` / `wakes`:

* If `GET /v1/connection` offers NATS, the principal attaches to its own durable JetStream pull consumer (`@nats-io/transport-node`,
  `@nats-io/jetstream`) and gets a wake for every message that is addressed to it, also those that arrived while it was down. The TLS policy
  (`caFile`, `requireTls`) is the client's own and is never taken from the domain's answer; with `requireTls` a plaintext broker is refused.
* If NATS is missing, unreachable or a consumer stream ends, short HTTP lookups of the event feed every `pollEveryMs` (default 2 s) keep the
  principal going while NATS is rebuilt with jittered exponential backoff (1 s to 30 s). `mode: "poll"` never uses NATS.

Wakes are at-least-once and deduplicated for 120 s across both paths. A wake that is not acknowledged is redelivered by the broker. Callers that
must not lose a message also read the domain's inbox (`GET /v1/inbox?unread=true`), as the agent kit does.

## Events and rules
Producers and tooling use the same client (`docs/EVENTS.md`, "Interfaces"):

```ts
await client.publishEvent({ topic: "github.pull_request.opened", key: deliveryId, source: "github", data: { number: 42 }, classification: "internal", verified: true });
// -> { seq, eventId, duplicate }   a repeat of `key` answers duplicate: true (30 days)

const rules = await client.listRules();                       // RuleView[]
await client.putRule("reviewer-prs", spec);                    // create or replace: a subscription of an agent
await client.pauseRule("reviewer-prs");                        // and resumeRule, deleteRule, getRule
```

A rule is a wake-only subscription: events that match `selector` and `where` wake the owning agent, whose own handler decides what to do.
Requests are validated against the contract before anything is sent (`ContractError`: topic shape and length, key, 64 KiB of data, rule shape) and
answers are checked for the fields the tooling relies on. `publishEvent` carries an idempotency key, so a transport failure is retried safely.
`resolvePointer` and `whereMatches` implement `where` exactly as the domain defines it.

## Tests
`npm test` starts a **real domain server** (`dist/somework`, or `SOMEWORK_BIN`) in a temporary directory (the NATS tests also start a real
`nats-server`, `tools/bin/nats-server` or `NATS_SERVER_BIN`, configured through `somework admin render-nats-conf`): NATS wake latency, no
held-open request, broker outage and recovery, plaintext refusal under `requireTls`, TLS (trusted CA only, wrong CA, wrong name), the event
and rule contract, assertion format and backoff.

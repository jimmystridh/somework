# Showing SomeWork in the Fleet dashboard

The private Fleet dashboard (a Rust Axum server with a Dioxus WebAssembly page, outside this repository) has a SomeWork section: which agents
exist and are alive, what work is flowing, and the health of the domain and its message bus. This note records what the integration reads, which
identity it uses and how to undo it. The dashboard shows **metadata only**: no task input, result, message body, artifact content or digest is
ever read.

## The identity

The dashboard has its own principal, `agent/fleet-reader`: an agent enrolled with side effects capped at `read`, no `may-invoke` patterns, and
exactly three actions:

| Action | Why |
|---|---|
| `ops.read` | `GET /v1/admin/overview`, `/v1/runtimes`, `/v1/admin/events`, `/v1/admin/outbox` |
| `audit.read` | `GET /v1/admin/audit` (who submitted and who claimed a task, failure codes, lease expiries) and `/v1/admin/audit/verify` (hash chain) |
| `catalog.read` (+ `discover: ["*"]`) | `GET /v1/catalog/entries` (approved cards, capabilities, availability) |

It holds no `task.read`, `task.read.any`, `message.read.any`, `principal.manage` or any write action; the task list endpoint answers it with
`403 policy_denied`. `somework admin enroll-agent --id agent/fleet-reader --side-effects read --key-out …` creates it with default agent
permissions; the permissions are then **replaced** through the admin API (the CLI cannot grant operator actions to an agent):

```
PATCH /v1/admin/principals/agent/agent%2Ffleet-reader
{"permissions": {"actions": ["ops.read","audit.read","catalog.read"], "discover": ["*"], "capabilities": [],
                 "sideEffectsAtMost": "read", "classificationMax": "internal"}}
```

Check with `GET /v1/admin/whoami` as the new principal: `actions` must list exactly those three and `roles` must be empty. The key is generated on
the host that runs the dashboard (never copied elsewhere) and mounted read-only with the domain's CA certificate; the dashboard talks TLS only and
verifies the domain against that CA.

## What it reads

- `GET /readyz` and `GET /metrics` (unauthenticated on the domain): readiness, queue depth and age, lease expiries, retries, reconciliation,
  policy allow/deny, request counts by status, artifact upload bytes and, importantly, `somework_jetstream_consumer_lag` per JetStream consumer.
  That is how the message bus is shown without exposing the broker's monitoring port.
- The operator reads above, polled **once per 10 seconds** by a single collector task whatever the number of viewers. Events and audit rows are
  fetched incrementally by sequence number and applied idempotently, so a replayed page never double counts.

Every value that reaches the dashboard's own API is picked **by name** from the domain's JSON and passed through a short, restricted-alphabet
identifier or a number. Tests feed responses stuffed with content-bearing fields and assert none of it appears in the output.

## What it cannot show

- Whether a principal is enabled and its side-effect level (needs `principal.manage`, which also allows changes).
- Database size and backup age, domain version and uptime (not part of the domain API).
- JetStream storage use (only consumer lag is available through the metrics).

## Authentication wire format

Compact EdDSA JWS, header `{"alg":"EdDSA","typ":"somework+assertion","kid":"<kind>:<id>"}`, claims `iss`/`sub` = `<kind>:<id>`,
`aud` = `["somework:<domainId>"]`, `iat`, `exp` = `iat + 120`, random `jti`, sent as `Authorization: Bearer …`. The dashboard's signer is tested
against an assertion produced by this repository's TypeScript SDK (identical bytes for identical claims).

## Rolling back

1. The dashboard: retag the previous image and recreate the container (`docker tag <fleet image>-prev <fleet image>` then
   `docker compose up -d`), or simply remove `SOMEWORK_URL` from its compose file and restart: with no URL the section reports that the
   integration is not configured and nothing calls the domain.
2. The identity: `somework admin set-agent-status --id agent/fleet-reader --status disabled` stops it from authenticating at once. To remove its
   access without disabling: `PATCH` its permissions to an empty `actions` list.

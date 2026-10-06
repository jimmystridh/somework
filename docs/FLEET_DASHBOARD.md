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
| `ops.read` | `GET /v1/admin/overview`, `GET /v1/admin/system` (version, uptime, database size, principal states and side-effect ceilings), `/v1/runtimes`, `/v1/admin/events`, `/v1/admin/outbox` |
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

- Backup age (the domain does not record it).
- Until the dashboard reads `GET /v1/admin/system` (it needs only `ops.read`; added 2026-10-06 in the domain, not yet used by the dashboard): whether a
  principal is enabled and its side-effect ceiling, database size, domain version and uptime.
- JetStream storage use (only consumer lag is available through the metrics).

## Authentication wire format

Compact EdDSA JWS, header `{"alg":"EdDSA","typ":"somework+assertion","kid":"<kind>:<id>"}`, claims `iss`/`sub` = `<kind>:<id>`,
`aud` = `["somework:<domainId>"]`, `iat`, `exp` = `iat + 120`, random `jti`, sent as `Authorization: Bearer …`. The dashboard's signer is tested
against an assertion produced by this repository's TypeScript SDK (identical bytes for identical claims).

## Events and reactions

The SomeWork section ends with an Events part (design: `docs/EVENTS.md`). It shows metadata only: no event data, no task input, no
handler source and no error text from an agent. Rule names, owners, topic selectors, capability ids, counters, short task ids and fixed reason
codes pass through the same restricted-alphabet readers as everything else; free text (firing details, a handler's last error, the wording of
a disabled reason) is never read.

| What it shows | Where it comes from | Identity / config |
|---|---|---|
| Rules: owner, kind (reaction or agent subscription), selector, capability, active or paused, last fired, fired and skipped by reason, the last five firings | `GET /v1/rules` and `GET /v1/rules/{name}/firings?limit=5` (firings are read again only when a rule's counters moved) | `ops.read`, which the existing `agent/fleet-reader` already holds: the rules routes accept `rules.manage` **or** `ops.read` for reads (`require_rules_read` in the domain). Nothing new to grant. An older domain answers 404 and the rules stay "unknown". |
| Events published and duplicates, reactions fired and skipped by reason | domain `/metrics`: `somework_events_published_total`, `somework_events_duplicate_total`, `somework_reactions_fired_total`, `somework_reactions_skipped_total{reason}` | unauthenticated, as before |
| Awaiting approval | `pendingApprovals` of `GET /v1/admin/overview` | `ops.read`; the approvals list itself is not read (it would need another action) |
| Hub and receiver: per source received, published, duplicate, dropped, dead letters, failures, forwarded, paused; clock schedules with ticks, missed runs and next run; receiver queue, oldest queued age, reachability | the hub's `/metrics` (`hub_*`) and, when `hub-admin-token` exists, its `GET /admin/stats` (paused flags and next runs; shape `{sources: [{name, paused}], schedules: [{name, nextRunAt}], receiver: {queued, oldestAgeSeconds}}`). Without the route or the token those two stay "unknown". | `HUB_URL` (https with `hub-ca.pem`, or plain http only in preview mode); optional secrets-directory file `hub-admin-token` |
| Per agent: handlers (name, version, enabled, runs, errors, drops, wakes, reason code when disabled) and the events token pool (used, limit, throttled, stopped) next to the tasks pool | each agent's `/status` endpoint (kit health port) | secrets-directory file `agents-health.json`: `[{"id": "agent/x", "url": "http://host:port/status"}]`, plain or TLS URLs without credentials or query |

Alerts (computed on the server, fixed wording): a stopped or throttled events pool, a disabled handler, dead letters above zero, the hub
losing the receiver, the oldest queued webhook older than 5 minutes, a reaction rule whose last three firings were all skipped, an unreachable
agent status endpoint or hub. Everything is read by the single 10 second collector; viewers only read the cached sample. Tests feed
every reader responses stuffed with content-bearing fields and assert none of it reaches the output.

## Rolling back

1. The dashboard: retag the previous image and recreate the container (`docker tag <fleet image>-prev <fleet image>` then
   `docker compose up -d`), or simply remove `SOMEWORK_URL` from its compose file and restart: with no URL the section reports that the
   integration is not configured and nothing calls the domain.
2. The identity: `somework admin set-agent-status --id agent/fleet-reader --status disabled` stops it from authenticating at once. To remove its
   access without disabling: `PATCH` its permissions to an empty `actions` list.

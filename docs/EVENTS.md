# Events and reactions

Status: decided, not built. Terms are defined in `CONTEXT.md`; the two hard-to-reverse choices are in `docs/adr/0001` and `0002`. Everything below belongs to the first version.

## Shape

An **event** is an `event.notification` message on a **topic** (`<source>.<object>.<change>`: `github.pull_request.opened`, `jira.issue.transitioned`, `datadog.monitor.alert`, `grafana.alert.firing`, `clock.nightly`). It has two kinds of consumer:

* **Reaction**: a rule submits a task from a template under an `automation/<name>` principal, with a budget and a depth cap. For fixed flows. Read-class capabilities run unattended; write-class ones wait for the manager's approval, which shows the capability, a redacted input summary and the budget.
* **Agent subscription**: the agent is woken and decides for itself under its own authority, optionally through a **handler**.

The domain gains one primitive, the `submitTask` subscription action, executed from the outbox. Exactly-once is a unique key on (subscription, event id). Event ids are stable and producer-assigned (delivery id; monitor id plus transition time; webhook id plus timestamp; schedule name plus scheduled minute), or a hash of the normalised payload. Events are de-duplicated for 30 days. Event, task, event chains share the domain's hop and depth counters; an agent never reacts to an event it caused.

## Producers

* **Clock**: time zone Europe/Stockholm, jitter up to 60 s for anything that calls a model; a missed daily or nightly run executes once on recovery, a job firing more than hourly skips missed runs; both overridable per schedule.
* **Webhooks** (issue tracker, code host, Datadog): through the **receiver** on the public edge (own Cloudflare host, Authenticated Origin Pulls, WAF allow-list of each source's published ranges where they exist). The receiver verifies a per-source token, caps the body, and writes the raw request to a durable queue. It never opens connections inward. The **hub** pulls over the single allowed route (long poll), maps the payload and publishes the event as a producer.
* **Log-stack alerts** post straight to the hub on the private network.
* **Secrets**: one hub secret; per-source tokens are derived from it with HMAC (version number per source for rotation). A leaked token cannot forge another source.
* **Mapping**: JSONata files per source, one file and one recorded-payload fixture each, in git. Each mapping lists the fields it carries; everything else is dropped. Raw payloads live at most 24 h in the receiver queue and are never logged. Every event gets a classification from its source, and the existing redaction patterns run on every event.
* Each producer is its own principal and may publish only under its own topic prefix.

## Handlers

Agent-written code that runs inside the agent's own sandbox on every event delivered to that agent. It gets the sandbox's file access and outbound allow-list, no credentials (calls that need one go through kit-provided functions), and no direct access to the SomeWork API. It returns a decision: drop, wake, wake with a cheaper model tier, submit a task, notify the owner, or rewrite the event; the kit carries it out under the agent's normal policy. Hard limits per run: wall-clock timeout, memory, output size. Handlers go live as soon as the agent saves them.

Safety net, on by default: every version recorded by hash and logged with each decision; auto-disable after 5 consecutive errors or timeouts, or more than 20 wakes per hour (adjustable per agent), with an owner notice through the manager; a kill switch per handler and per agent; a disabled or failing handler falls back to delivering the event to the inbox without waking; drops are counted and sampled, never silent.

## Token limit per agent

The daily ledger has two pools: tasks that requesters submit, and event-driven runs (handler runs, wakes, cheaper-tier model calls). Events get 30 % of the daily budget; the rest is reserved for tasks. At 80 % of a pool the agent is throttled (cheaper tier only, wakes rate-limited); at 100 % wakes stop, events are still recorded, handlers keep running (they cost no tokens) and the owner gets one notice. A weekly cap per agent is optional.

## Rules and deployment

A **rule** is a file under `rules/` in the agents' repository describing one subscription and optionally its reaction. Woodpecker CI validates them on every pull request and posts the `apply --plan` diff; on merge to `main` it runs `apply` through the API with an automation credential that exists only for that pipeline. `rules/` is covered by CODEOWNERS requiring the owner's review and no agent token may merge. The runner is on its own VM; GitHub webhooks for Woodpecker reach it through the receiver and the hub (ADR 0002). Runtime control is pause and kill only (a subscription status), never creation.

## Acceptance for the first version

Demonstrated on the pilot: a real pull request triggers one review even when the webhook is delivered twice; a recorded issue-tracker payload becomes the right event with only its allow-listed fields; an agent-written handler drops, wakes and submits as intended, is auto-disabled after five failures, and the token pools throttle and stop as specified; a reaction loop is cut by the depth limit; receiver, hub and NATS each restart without losing or duplicating events; a forged webhook (wrong, missing or another source's token) is rejected at the receiver; the dashboard shows events in, rules fired, dropped and deduplicated counts and dead letters, and the manager can pause any rule, source or handler.

## Test approach

A fake webhook sender with recorded real payloads; signature failure cases, replay and duplicate deliveries, clock skew, a rule that would loop, handler timeout and memory cases, and an end-to-end chain on the pilot.

## Interfaces (the contract the parts are built against)

Names are fixed here so the domain, receiver, hub, kit and tooling can be built in parallel. Change this section first if something has to move.

### Domain: publishing

`POST /v1/events/publish` (gRPC `EventService.Publish`), caller is a `service` principal holding permission `events.publish:<prefix>` for each topic prefix it may use (glob over the topic, for example `events.publish:github.*`).

```json
{ "topic": "github.pull_request.opened", "key": "<stable event key, 1-200 chars>", "source": "github",
  "data": { "...": "mapped fields only, at most 64 KiB serialised" }, "classification": "internal",
  "verified": true, "causedByTask": "tsk_...", "occurredAt": "2026-10-05T12:00:00Z" }
```

Response `{ "seq": 12, "eventId": "evt_...", "duplicate": false }`. Deduplicated on (publishing principal, key) for 30 days; a repeat returns the original seq with `duplicate: true` and emits nothing. Topic pattern `^[a-z][a-z0-9_]*(\.[a-z0-9_]+){2,}$`, at most 200 characters; `classification` must be a level of the active policy and not above the publisher's clearance. The domain stores a domain event whose `type` is the topic itself (so subscription selectors glob over it, for example `github.pull_request.*`) with payload `{topic, source, key, data, classification, verified, depth, causedByTask, publishedBy}`. `depth` = depth of `causedByTask` + 1 when it is given and was itself started by a reaction or event, otherwise 0. Events a producer publishes are never delivered back to that producer's own subscriptions.

### Domain: rules, subscriptions, reactions

Permissions: `rules.manage` (write), `rules.control` (pause/resume and reads only), `ops.read` (read). A rule is a subscription plus an optional reaction, owned by the principal named in `owner`.

* `GET /v1/rules`, `GET /v1/rules/{name}`, `PUT /v1/rules/{name}` (create or replace, idempotent), `DELETE /v1/rules/{name}`, `POST /v1/rules/{name}/pause`, `POST /v1/rules/{name}/resume`.
* Body of `PUT`:

```json
{ "description": "Review every opened pull request",
  "owner": "automation/pr-review",
  "selector": "github.pull_request.opened",
  "where": [ { "path": "/data/draft", "equals": false } ],
  "wake": false,
  "reaction": {
    "capability": { "id": "code.review", "version": 3 },
    "input": { "repoUrl": "${/data/repository/clone_url}", "pullNumber": "${/data/number}" },
    "budget": { "maxTokens": 200000, "maxMinutes": 20 },
    "maxDepth": 3, "maxFiringsPerHour": 30 },
  "status": "active" }
```

`selector` is a glob over the topic (the same matcher as topic subscriptions); `where` is a list of JSON-pointer equality checks over the event payload (all must hold). A rule with `wake` and no `reaction` is an agent subscription (`owner` is then the agent). In `input`, a string that is exactly `${/pointer}` is replaced by the typed value found at that JSON pointer in the event payload; `${/pointer}` inside a longer string is replaced by its text form; a missing pointer fails the firing. `GET` returns the same document plus `status`, `createdAt`, `updatedAt`, `lastFiredAt`, and counters `{fired, skipped: {duplicate, depth, rate, denied, approval, error}}`.

A matching event on a rule with a reaction writes one `reaction_firings` row (unique on (rule, event id)) and one outbox row for the sink `reaction`; the outbox worker submits the task in its own transaction as the `owner` principal (normal policy, delegation and approval rules apply, so write-class capabilities wait for approval). The task records `origin: {kind: "reaction", rule, eventId, depth}`. The domain emits `reaction.fired` and `reaction.skipped` (with `reason`) as ordinary domain events. Defaults: `maxDepth` 3, `maxFiringsPerHour` 30 per rule.

Implementation notes (domain, built): `PUT` answers `201` when the rule is new and `200` otherwise, an identical repeat changes nothing, and the capability `version` may be written as a number or a string (stored as a string). `reaction.budget` is merged into `input.budget` unless the template sets one. Also served: `GET /v1/rules/{name}/firings?limit=` (the ledger) and gRPC `EventService.Publish`. The skipped counters have one more reason, `paused` (a rule paused after the event matched). The `*` action does not grant publishing; only `events.publish:<glob>` grants and the admin role do. Depth: a published event has `depth` as above, a task event carries `originDepth` (the origin depth of a reaction-started task) and counts as `originDepth + 1`, any other event starts at 0; a reaction is skipped with reason `depth` when the event depth has reached the rule's `maxDepth`, and the task it starts records `origin.depth` = the event depth. Events whose type starts with `reaction.` never start reactions (they can still wake subscribers). Reactions of write class or above always wait for structured approval, whatever the policy document says; a denied or expired approval counts as `skipped.approval`. Permissions: `rules.manage` (everything), `rules.control` (only `pause` and `resume`, plus reads; `PUT` and `DELETE` answer 403) and `ops.read` (reads); `rules.control` is an administrative action, so the `*` action never grants it, and `enroll-service --action rules.control` creates a principal that holds only it. Admin commands: `enroll-producer`, `set-publish-permissions`, `enroll-service`; automation principals are ordinary `enroll-agent --may-invoke` principals without a card.

Event-driven agent tasks (built): task submission takes an optional `causedByEvent` (REST/gRPC/client). The domain verifies that the event was addressed to the submitter (otherwise `422 validation_failed`, identical for forged and foreign ids) and records `origin {kind:"event", eventId, depth: eventDepth+1}`; events published with `causedByTask` of such a task get `depth = origin.depth + 1`, so chains through agents are cut by the same `maxDepth`. Event-origin tasks are not forced into approval (the agent acts under its own authority). Retention: published events older than 30 days (with recipients, delivered outbox rows and dedupe keys) and settled firings are purged by the existing retention job; undelivered ones, task events, `reaction.*` events and the audit chain are kept. See `docs/api.md`.

### Receiver (public edge, VM in the DMZ)

* `POST /hook/{source}/{token}[{suffix}][?{query}]` accepts a webhook: token is `base64url(HMAC-SHA256(hubSecret, "hook:" + source + ":" + version))` (first 43 characters, constant-time compare); body at most 1 MiB; answers `202 {"id": "..."}`, `401` for a bad token or signature, `404` for an unknown or paused source or for a path suffix other than the one the source is configured with (default none; `/api/hook` for Woodpecker, which appends its own route to the webhook host), `405`, `413`, `414` (query over 4096 characters), `429`. Sources with `verify: "github-hmac"` also need a valid `X-Hub-Signature-256` made with `base64url(HMAC-SHA256(hubSecret, "hmac:" + source + ":" + version))`. Stored: `{seq, id, source, receivedAt, headers (allow-list: content-type, user-agent, x-github-*, x-hub-signature-256, x-datadog-*, x-atlassian-*, x-event-key, x-hook-*, cf-connecting-ip), path (the suffix, or ""), query (verbatim, without the `?`), body (raw bytes)}`. The query is secret material (Woodpecker's `access_token` travels in it) and, like the body, the path and the token, is never logged. Raw payloads are deleted after 24 h or after acknowledgement.
* Private listener (TLS, bearer `base64url(HMAC-SHA256(hubSecret, "pull"))`): `GET /v1/pull?after=<seq>&limit=50&wait=25` (long poll) returns `{items:[{seq,id,source,receivedAt,headers,path,query,bodyBase64}]}`; `POST /v1/ack {"upTo": seq}`; `GET /v1/stats`; `POST /v1/sources/{source}/pause` and `/resume`; `GET /healthz`.

### Hub (private side)

Pulls from the receiver, applies the JSONata mapping of the source and publishes events through the domain API as one producer principal per source (`producer/<source>`), then acknowledges (the cursor moves only after the acknowledgement, so a crash in between republishes and the keys deduplicate). A mapping receives `{headers, body (parsed JSON or text), receivedAt, source, defaults}` and returns `null` (drop), one event or an array of events `{topic, key, data, classification?, causedByTask?}`; only the fields it returns are carried, credentials in `data` are replaced, free text leaves only as `{excerpt: true, text, truncated}`. `defaults` is the source's static `defaults` block of the hub configuration, for what a webhook cannot carry (the Jira mapping fills `repository.cloneUrl` and `repository.ref` from `defaults.repository`, overridable per project in `defaults.projects.<KEY>.repository`). The `data` shapes of the topics the shipped rules use are fixed by `rules/samples/` and `docs/RULES.md` (camelCase; `github.pull_request.*`: `number, draft, title, author, headSha, headRef, baseRef, htmlUrl, repository{fullName, cloneUrl, htmlUrl}`; `jira.issue.transitioned`: `issue{key, summary, url, type, project}, from, to, actor, repository{cloneUrl, ref}`; `datadog.monitor.*`: `monitorId, monitor, transition (Alert|Warn|Recovered), priority, tags, url`; `grafana.alert.*`: `alert, uid, severity, summary, url`) and enforced by a test. A publish that keeps failing goes to the dead-letter store with its raw payload (kept at most 24 h) and can be replayed. Sources with `forward: {baseUrl, caFile}` (Woodpecker) are replayed byte for byte to `baseUrl + path suffix + ?query`, with the original delivery headers and the server verified against `caFile`, and produce no event. An internal listener `POST /in/{source}/{token}` serves senders inside the private network (Grafana). The clock is a producer in the hub: `{name, cron, timeZone: "Europe/Stockholm", jitterSeconds, missed: "run-once" | "skip"}` (name: lowercase letters, digits, underscore) publishes `clock.<name>.tick`, classification `public`, data `{name, scheduledFor (local time with offset, for example 2026-10-05T23:00:00+02:00), missed}`, key `clock.<name>:<scheduled minute in the schedule's time zone, for example 2026-10-05T23:00>`. Health: `GET /healthz`, `GET /metrics` (Prometheus text: events received, published, duplicate, dropped, dead letters, oldest pending age, per source). Control: `POST /admin/sources/{source}/pause|resume` (bearer `base64url(HMAC-SHA256(hubSecret, "admin"))`). `GET /admin/stats` (same bearer) returns `{sources: [{name, paused}], schedules: [{name, nextRunAt}], receiver: {queued, oldestAgeSeconds, reachable}}`: `nextRunAt` is the next scheduled minute with the zone's offset (jitter not included, `null` if none), the receiver numbers come from the hub's last successful `/v1/stats` call and are `null` with `reachable: false` when that call failed or has not happened yet. A source whose payload shape is not yet known (`aikido`) has a defensive first-cut mapping that never drops: it publishes `aikido.event.received` with only `receivedAt` and the names of the recognised fields, and is refined from a real delivery (the receiver keeps raw payloads for 24 h; inspect one through the dead-letter tooling or the receiver's pull API, see the hub README, "Refining a mapping").

### Agent kit

An agent subscribed to events (a rule with `wake`, or its own subscription) receives them through the domain event feed. For each delivered event the kit runs the agent's **handlers** in the agent's sandbox, as child processes with a wall-clock timeout, memory cap and output cap, input `{event, agent, now}` on stdin and a single JSON decision on stdout:

```json
{ "action": "drop" | "deliver" | "wake" | "submit" | "notify" | "rewrite",
  "tier": "default" | "small", "reason": "...", "prompt": "...", "event": { "...": "for rewrite" },
  "task": { "capability": {"id": "...", "version": 1}, "input": {}, "budget": {"maxTokens": 0, "maxMinutes": 0} },
  "message": "text for notify" }
```

`deliver` records the event in the inbox without waking. Handlers live in `<agent state dir>/handlers/<name>.mjs`, each save is versioned (content hash, timestamp, previous version kept) and goes live immediately. Safety net as in the design above; the ledger has pools `tasks` and `events` (30 % share by default). The agent's health endpoint reports `handlers: [{name, version, enabled, runs, errors, drops, wakes, lastError, disabledReason}]` and `tokenPools`.

As built (`packages/agent-kit/src/events`, enabled per role with `profile.events.enabled` or `EVENTS_ENABLED=1`):

* **Handler shape**: `export default async function ({ event, agent, now }, kit)` returning the decision; `// @topics github.*, jira.*` on one of the first lines (or the `topics` argument of the save tool) selects the topics it handles, default all. The input is passed as a file inside the sandbox, not on stdin (the execution environment has no stdin); `kit` offers `fetchJson`, `fetchText` (https, hosts in `events.fetchHosts` only, no credentials, authorization and cookie headers refused), `redact`, `log`. Handlers matching a topic run in name order; `rewrite` passes the changed event on, any other decision ends the chain. No matching handler: the agent is woken. A handler that fails, times out, exceeds memory or output, or returns an invalid decision delivers the event to the inbox without waking.
* **Intake**: the long-polling event feed (`GET /v1/events?wait=`) with the agent's own cursor and seen-id list in `<state dir>/events/`; the domain-side cursor is not acknowledged because it is shared with the agent's message wakes. Published events are recognised by `payload.topic`; other domain event types are delivered only if they match `events.accept` (globs, for example `reaction.*`). Only deliveries with `wake: true` run handlers; others, and events older than `events.staleAfterHours` (24), are recorded in the inbox (`<state dir>/events/inbox.jsonl`, read with the `events_inbox` tool).
* **Kill switch**: `<state dir>/handlers/control.json` (read for every event; editable by an operator) and, from the domain side, a direct message to the agent from a sender in `events.controllers` (default: `events.notifyTo`, default `agent/manager`) carrying the labels `eventControl` = `disable` | `enable` | `disable-all` | `enable-all`, `eventTarget` = handler name (for `disable` and `enable`) and `eventReason`. Such a message gets no chat notice. The agent can lift only its own and the automatic switch-offs, never the owner's or the manager's.
* **Submit decisions** call `POST /v1/tasks` with `causedByEvent: <event id>` (so the domain records the origin and counts depth) and the idempotency key `event:<eventId>:<agentId>:<capability>`; a `budget` in the decision goes into `input.budget` unless the input already has one, capped at `events.submitBudgetCap` (200k tokens, 20 min).
* **Notices to the owner** (`chat.notice`, `triggerMode: never`, label `eventNotice`, sent to `events.notifyTo`): `notify` decisions, an automatic switch-off, the answer of a woken run, and once per day each when the events pool reaches the throttle level and when it is used up.
* **Woken runs** get the event inside random boundary markers as quoted untrusted data, run with `events.wakeBudget` (default 100k tokens, 10 min), use `events.smallModel` for tier `small` and while throttled, and every approval request is refused. Throttled (80 %): small tier, at most `events.throttledWakesPerHour` (5) wakes per hour. Stopped (100 %): wakes become inbox entries; handlers keep running.
* **Health**: `GET /status` returns `{handlers, tokenPools, events: {cursor, dropped, inbox}}` (also merged into the `/ready` body); metrics `somework_events_total{result}`, `somework_handler_runs_total{handler,result}`, `somework_token_pool_used{pool}`, `somework_token_pool_limit{pool}`.
* **Settings** (profile field, environment override): `enabled` (`EVENTS_ENABLED`), `notifyTo` (`EVENTS_NOTIFY_TO`), `controllers` (`EVENTS_CONTROLLERS`), `fetchHosts` (`EVENTS_FETCH_HOSTS`), `accept` (`EVENTS_ACCEPT`), `timeoutSeconds` (`EVENTS_HANDLER_TIMEOUT_SECONDS`, 10), `memoryMb` (`EVENTS_HANDLER_MEMORY_MB`, 128), `maxConsecutiveFailures` (`EVENTS_MAX_FAILURES`, 5), `maxWakesPerHour` (`EVENTS_MAX_WAKES_PER_HOUR`, 20), `throttledWakesPerHour` (`EVENTS_THROTTLED_WAKES_PER_HOUR`, 5), `tokenShare` (`EVENTS_TOKEN_SHARE`, 0.3), `throttleAt` (`EVENTS_THROTTLE_AT`, 0.8), `weeklyTokens` (`EVENTS_WEEKLY_TOKENS`), `smallModel` (`EVENTS_SMALL_MODEL` as `provider/model-id`), `wakeBudget` (`EVENTS_WAKE_MAX_TOKENS`, `EVENTS_WAKE_MAX_MINUTES`).

### Rules repository layout

`rules/*.yaml` (one rule per file, the `PUT` body plus `name`), `rules/schema.json`, `.github/CODEOWNERS` covering `rules/`, `.woodpecker/*.yaml`. The tool `somework-rules` offers `validate`, `plan` (diff against `GET /v1/rules`, markdown output) and `apply` (create, replace, delete rules that no file declares, pause state preserved).

## Manager

The manager (Telegram) is the owner's decision channel for the approvals the domain asks for and the control surface for events; see `adapters/manager/README.md`. It reads pending approvals from `GET /v1/approvals` and decides them with the digest and revision it read; it forwards the events of the rules it owns without a model (allow-listed topics, per-topic rate limit, defanged text, quiet hours, digest); `/rules`, `/pause`, `/resume` use the rules API, `/sources`, `/pausesource` the hub's `/metrics` and `/admin/sources/{source}/pause|resume`, `/handlers` the agents' `/status`, and `/kill` and `/unkill` the kit's control message (`eventControl`, `eventTarget`, `eventReason` labels). The manager principal needs `approval.grant`, an `approves` pattern, `ops.read` and `rules.control` (pause, resume and reads only; never `rules.manage`). A pause or kill that the model asks for needs the owner's confirmation; the owner's own commands do not. The hub does not report a source's paused flag, so `/sources` shows what the manager itself last set.

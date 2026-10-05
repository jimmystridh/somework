# Event hub

The private-side half of the event path (`docs/EVENTS.md`, `docs/adr/0001`). It pulls webhooks from the receiver, turns each into zero or more **events** with a reviewed JSONata mapping, publishes them to the domain (`POST /v1/events/publish`) as one producer principal per source, and runs the clock. It also serves the senders that live inside the private network (Grafana) and replays forward-only sources (Woodpecker) byte for byte.

```
GitHub / Jira / Datadog ──► Cloudflare ──► nginx ──► receiver (DMZ, durable queue)
                                                         ▲ pull (long poll, TLS + bearer; the DMZ never connects inward)
Grafana ──► POST /in/grafana/<token> ──► hub ◄───────────┘
                      clock ──────────────┘ ├─► domain: producer/<source> publishes <source>.<object>.<change>
                                            └─► forward sources: replay to a private URL (Woodpecker)
```

Every webhook ends in exactly one of: **published** (the domain accepted it, or already had it: the event key makes a redelivery a no-op), **dropped** with a counted reason (no event, paused source, invalid mapping output), **forwarded**, or the **dead-letter store** (kept 24 hours, replayable). The receiver is only acknowledged afterwards; a hub that dies in between simply republishes, and the keys deduplicate.

## Configuration

`hub.config.json` (example: `deploy/hub.config.example.json`), env `HUB_CONFIG`, `HUB_SECRET_FILE`, `LISTEN_HOST`, `LISTEN_PORT` (plain HTTP, default 8090) and, when `TLS_CERT_FILE` + `TLS_KEY_FILE` are set, `TLS_PORT` (default 8091: the same endpoints over TLS, for readers such as the dashboard and the manager):

| Key | |
|---|---|
| `domain` | `url`, `caFile`, `requireTls` (default true) |
| `receiver` | `url` of the private listener, `caFile`, `waitSeconds` (long poll, default 25) |
| `sources[]` | `name`, `version`, then either `mapping` + `producer.keyFile` (+ optional `classification`, `defaults`, `internal: true`) or `forward: {baseUrl, caFile}` |
| `sources[].defaults` | static object handed to the mapping as `defaults`: what a webhook cannot carry. The Jira mapping reads `defaults.repository` and `defaults.projects.<KEY>.repository` (`cloneUrl`, `ref`) |
| `clock.schedules[]` | `name` (lowercase, digits, underscore: topics may not contain a hyphen), `cron` (5 fields), `timeZone` (default `Europe/Stockholm`), `jitterSeconds`, `missed` (`run-once`, `skip`, default: skip when it fires more than hourly, else run-once) |
| `maxAttempts` | transient failures per item before it is dead-lettered (20; backoff 1 s doubling to 60 s) |

Each source publishes under its own principal (`producer/<source>`, `producer/clock`), enrolled with the permission `events.publish:<source>.*` only. The hub also refuses, before the domain does, any topic outside `<source>.`.

## Mappings

`mappings/<source>.jsonata` receives `{headers, body, receivedAt, source, defaults}` (headers lower-cased, body parsed when it is JSON) and returns nothing (drop), an event or an array of events `{topic, key, data, classification?, causedByTask?}`. Anything else it returns is discarded, `data` is limited to 64 KiB, credentials in it are replaced, and two helpers keep text safe: `$clip(text, n)` and `$excerpt(text, n)` (the only way free text leaves, as `{excerpt: true, text, truncated}`). The data shapes are the ones in `rules/samples/` and `docs/RULES.md`; `test/shapes.test.ts` fails when a mapping drifts from a sample.

Add or change a mapping:

1. Save a real payload (and headers) of the new case: `somework-hub mapping test <source> payload.json --header x-github-event=push`.
2. Add a fixture under `mappings/<source>/fixtures/<case>.json`: `{description, input: {headers, body, receivedAt, source, defaults?}, expected: [...events], canaries?: ["strings that must never appear"]}`. Fixtures are discovered automatically by `npm test`; write `"expected": "FREEZE"` only while drafting and review the printed output before committing it.
3. Cases that must be dropped are fixtures with `"expected": []`; every source needs some.

Per source:

* **github** (verify with `github-hmac`; secret from `somework-hub signing-secret github`): `pull_request` (opened, synchronize, ready_for_review, reopened, closed, merged), `check_run.completed`, `issue_comment.created`, `push`. Key `github:delivery:<id>`.
* **jira** (Data Center webhook, JQL-filtered to the projects you care about; events: issue created/updated, comment created): `jira.issue.created|updated|transitioned`, `jira.comment.created`. A transition is an update whose changelog has a `status` item.
* **datadog**: webhook with this custom payload (keys may also be the variable names themselves):
  ```json
  {"id":"$ID","alert_id":"$ALERT_ID","title":"$EVENT_TITLE","transition":"$ALERT_TRANSITION","status":"$ALERT_STATUS","tags":"$TAGS","link":"$LINK","date":"$DATE","priority":"$ALERT_PRIORITY"}
  ```
  Only Alert, Warn and Recovered transitions become events (`datadog.monitor.alert|warn|recovered`); renotifications and No Data are dropped.
* **grafana** (contact point of type webhook, URL from `somework-hub urls`): `grafana.alert.firing|resolved`, one event per alert; the rule uid comes from the generator URL.
* **woodpecker**: forward only, no mapping.

## Operating it

* **Secrets.** One hub secret, `openssl rand -base64 48`, mode 0600, the same file content on the DMZ VM (receiver) and the agents VM (hub), plus a password-manager entry. The webhook URLs are secrets too: `somework-hub urls --host https://<hooks host> --receiver-config receiver.config.json` prints them; never paste them into logs or chat. `somework-hub signing-secret github` prints the key to enter as the secret of the GitHub webhook.
* **Rotate a source.** Raise its `version` in both configs, restart receiver and hub, print the new URL, update the sender. The old URL is dead immediately. Rotating the hub secret changes every credential at once.
* **Add a source.** Enrol `producer/<source>` with `events.publish:<source>.*`, put its key in `keys/`, add the source to both configs (and the receiver's `path` if the sender appends a route), write the mapping and fixtures, restart, print the URL.
* **Pause or kill a source.** `POST /admin/sources/<source>/pause|resume` (bearer `HMAC(secret, "admin")`, port 8090): the receiver stops accepting it and anything already pulled is dropped with reason `paused`. The manager exposes the same switch.
* **Overview.** `GET /admin/stats` (admin bearer) returns `{sources: [{name, paused}], schedules: [{name, nextRunAt}], receiver: {queued, oldestAgeSeconds, reachable}}`. The receiver numbers are those of the hub's last successful call to the receiver's `/v1/stats` (refreshed every 15 s) and are `null` with `reachable: false` when it could not be reached; counters are in `/metrics`.
* **Dead letters.** `GET /admin/dead-letters` or `somework-hub dead-letters list|show <id>|replay <id>|--all|drop <id>` (in the container: `docker compose exec hub node src/cli.ts ...`). A letter with kind `mapping` is replayed after the mapping is fixed; `publish` after the domain or the principal's permission is fixed; `forward` after the target is. Letters expire after 24 hours.
* **Health and metrics.** `GET /healthz`; `GET /metrics` (Prometheus text): `hub_events_received_total`, `hub_events_published_total`, `hub_events_duplicate_total`, `hub_events_dropped_total{reason}`, `hub_events_dead_lettered_total{kind}`, `hub_dead_letters`, `hub_receiver_oldest_pending_age_seconds`, `hub_receiver_queued`, `hub_receiver_up`, `hub_publish_failures_total{kind}`, `hub_forwarded_total`, `hub_clock_ticks_total`. Alert on `hub_receiver_up == 0`, a growing `hub_receiver_oldest_pending_age_seconds`, and `hub_dead_letters > 0`.
* **Logs** are JSON (`hub_started`, `event_published`, `event_duplicate`, `event_dropped`, `event_dead_lettered`, `event_retry`, `clock_tick`, ...) with ids and counts only.

## Cloudflare host and the origin

The webhook host is one label under the zone (so Universal SSL covers it) with a proxied A record to the origin, the same shape as the Penpot host:

1. DNS: proxied A record `<hooks host>` → the origin address.
2. Certificate: a hostname-only Cloudflare Origin CA certificate, issued from a CSR made on the VM (the key never leaves it), installed for the nginx origin.
3. SSL/TLS: configuration rule for that host only, mode Strict; redirect rule HTTP → HTTPS.
4. Authenticated Origin Pulls on for the host, with Cloudflare's origin-pull CA in `ssl_client_certificate` (see `../events-receiver/deploy/nginx-hooks.conf`): the allow-list of Cloudflare address ranges is shared by every Cloudflare customer and does not prove the request came through this zone.
5. WAF: allow only each source's published address ranges where they exist (GitHub hooks, Datadog), plus a rate limit.
6. Add `nginx-hooks-http.conf` once to the origin's `http {}`, the server block to its configuration, and attach the receiver to the origin's Docker network (`compose.yaml`, `EDGE_NETWORK`).
7. The host firewall already allows the agents VM to reach the DMZ; add the private listener's port (8443) for it.

Woodpecker's webhook host is set to `https://<hooks host>/hook/woodpecker/<token>`; GitHub then posts to `.../hook/woodpecker/<token>/api/hook?access_token=<jwt>`, which the receiver stores (suffix and query included) and the hub replays to `forward.baseUrl` + suffix + query with the original signature headers, so Woodpecker verifies GitHub's signature itself.

## Tests

```
npm test --workspace @somework/events-hub
```

Mapping fixtures and their safety properties (`mappings.test.ts`), conformance to the shipped sample events (`shapes.test.ts`), cron and the clock with an injectable clock (`clock.test.ts`), configuration (`config.test.ts`), the whole path through a real receiver and a fake domain that verifies the producers' signatures (`pipeline.test.ts`: duplicates, restarts of both sides, publish failures, dead letters and replay, forwarding, the internal listener, pause/resume, metrics, logs) and the operator CLI (`cli.test.ts`).

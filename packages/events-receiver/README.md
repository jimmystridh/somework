# Event receiver

The public-edge half of the event path (see `docs/EVENTS.md`, `docs/adr/0001`). It runs in the DMZ behind the Cloudflare host, accepts a webhook, proves who sent it, writes it to a durable queue **unchanged**, and answers `202`. It never interprets a payload and never opens a connection into the private network: the hub on the private side pulls what has accumulated.

* No dependencies. SQLite from Node itself (`node:sqlite`, Node 22.5+, silenced with `--disable-warning=ExperimentalWarning`) with `synchronous=FULL`, so a `202` is only sent after the webhook is on disk and a restart loses nothing that was acknowledged. Sequence numbers are never reused.
* Two listeners. **Public** (`PUBLIC_PORT`, plain HTTP, reached only through the nginx origin): `POST /hook/<source>/<token>[<suffix>][?query]`. **Private** (`PRIVATE_PORT`, TLS + bearer, published on the DMZ address only): `GET /v1/pull`, `POST /v1/ack`, `GET /v1/stats`, `POST /v1/sources/<source>/pause|resume`, `GET /healthz`.

## Authentication

Everything is derived from the one hub secret (`HUB_SECRET_FILE`, at least 32 bytes) with HMAC-SHA256, so a leaked URL forges only its own source:

| Credential | Derivation |
|---|---|
| webhook token | `HMAC(secret, "hook:<source>:<version>")` as base64url |
| bearer of the private listener | `HMAC(secret, "pull")` |
| GitHub signing key (`verify: "github-hmac"`) | `HMAC(secret, "hmac:<source>:<version>")`; deliveries need the token **and** a valid `X-Hub-Signature-256` |

Bump a source's `version` in `receiver.config.json` and the hub's config to rotate it; the old URL stops working at the next restart. Tokens are compared in constant time, a client (`CF-Connecting-IP`) that sends 20 bad credentials in a minute is blocked for the rest of it, and every source and the receiver as a whole have token-bucket rate limits.

## What is stored

`{seq, id, source, receivedAt, headers, path, query, body}`. Headers are an allow-list (`content-type`, `user-agent`, `x-github-*`, `x-hub-signature-256`, `x-datadog-*`, `x-atlassian-*`, `x-event-key`, `x-hook-*`, `cf-connecting-ip`); cookies and authorization headers are never kept. `path` is the suffix after the token and must equal the one the source is configured with (`"path": "/api/hook"` for Woodpecker, none otherwise; anything else is a 404). `query` is the query string verbatim and is **secret material** (Woodpecker's `access_token` travels in it): it is never logged. Items leave the queue when the hub acknowledges them, or after `retentionHours` (24).

## Logs

JSON lines with `event`, source, counts and ids only (`hook_accepted`, `hook_rejected` with a reason, `queue_acked`, `queue_purged`, ...). A body, a header value, a path, a query or a token never reaches a log line, and the nginx example is configured the same way.

## Running it

See `deploy/`: `Dockerfile`, `compose.yaml`, `receiver.config.example.json`, `nginx-hooks.conf` (+ `nginx-hooks-http.conf`) and `env.example`. The operational runbook (Cloudflare host, certificates, secrets, rotation) is in `../events-hub/README.md`.

```
npm test --workspace @somework/events-receiver
```

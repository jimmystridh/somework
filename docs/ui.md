# Operations & introspection console

A dependency-free single-page app (`ui/`, vanilla ES modules + CSS, no build step) served by the domain service at
`/ui/`. It implements the spec's *Audit and introspection* section: two timelines (conversation vs execution),
canonical inspection and the introspection views. There are no tasks or approvals in the platform any more (`docs/adr/0003-messages-and-events-replace-tasks.md`): the console shows conversations, messages, the catalog, policy and audit.

## Views

| Route | What it shows |
|---|---|
| `#/overview` | Agents, online runtimes, denials (24 h), draft catalog entries, per-sink outbox (plane) status |
| `#/conversations/<id>` | **What participants said** (left) next to the **platform record** (right). Messages carry type badges, trigger modes and their attachments; `chat.notice` is visually de-emphasised ("automated notice"); `chat.message` is stamped "reported by participant". The audit records of the conversation sit under a verdigris "platform record" stamp (AUD-02) |
| `#/canonical/message/<id>` | The exact stored `MessageEnvelope`, with SHA-256 of the canonical envelope and of `content.data` (equals the audit record's `contentDigest`) |
| `#/catalog` | Entries incl. drafts (the nav shows how many); approve/suspend/revoke with visibility, trust tier and exported capabilities. Capabilities are advertisements only |
| `#/policy[/audit]` | Policy decisions (filter by decision/actor, reasons), audit trail with a *Verify hash chain* button, active policy document |
| `#/outbox` | Readiness, per-sink backlog, dead-letter re-queue, link to `/metrics` |
| `#/runtimes` | Logical agents with availability vs concrete runtime instances |

The agents' background jobs are not in this console: the fleet dashboard (`dashboard/`, `docs/FLEET_DASHBOARD.md`) shows them from the `agent.<slug>.job.*` events.

Trace ids on audit rows and events can be copied; Matrix room links appear when a `transport_mappings` row maps the
conversation to a room.

## Authentication

* **OIDC (production)**: `[ui.login]` + `[[oidc]]` in `somework.toml`. `/ui/login` starts an authorization-code +
  PKCE flow (confidential client); `/ui/callback` exchanges the code server-side, verifies the ID token against the
  provider JWKS and the nonce, then requires an **explicit** `(iss, sub)` → human principal mapping
  (`human_identities`). Unmapped identities get a "not provisioned" page and no session (ID-04).
* The session is an in-memory server-side record behind an `HttpOnly; SameSite=Strict` cookie. Permissions are
  re-read from the principal on every request. Mutating requests must carry `x-somework-csrf` (value from
  `/ui/session`), which a cross-site request cannot set.
* **Dev token login**: `ui.dev_token_login = true` lets you paste a bearer (e.g. from `somework admin token`). Off by
  default and returns 404 when disabled.

```toml
[ui]
dir = "ui"
dev_token_login = false

[ui.login]
issuer = "https://idp.example.com"
client_id = "somework-console"
client_secret = "…"

[[oidc]]
issuer = "https://idp.example.com"
audience = "somework-console"
jwks_url = "https://idp.example.com/jwks"
```

## Operator API used by the console

All gated by operator actions (`ops.read`, `audit.read`, `catalog.approve`);
ordinary agents and humans receive 403 and no data.

`GET /v1/admin/{overview,audit,audit/verify,policy-decisions,conversations,catalog,artifacts,messages,outbox,policy}`,
`GET /ui/config.json`, `GET /ui/session`, `POST /ui/{logout,dev-login}`.

## Running the browser suite

The suite runs against `devstack`, a seeded stack (two agents, a conversation with a notice, an answer and an attached file, a room, a mock
OIDC IdP with users `alice` (operator), `bob` (ordinary) and `mallory` (not provisioned)).

```
cd e2e && npm install            # once; uses the Chromium already cached by Playwright
npx playwright test              # starts `cargo run -p somework-testkit --bin devstack` itself
SOMEWORK_E2E_REUSE=1 DEVSTACK_OUT=/tmp/devstack.json npx playwright test   # against a devstack you started
cargo run -p somework-testkit --bin devstack                                # DEVSTACK_PORT/IDP_PORT/OUT env
SOMEWORK_E2E=1 cargo test -p somework-it --test ui_e2e -- --nocapture       # same suite from cargo
cargo test -p somework-it --test ui_api                                      # fast, no browser
```

The suite is stateful (catalog approvals, the denial it provokes), so it runs serially against one fresh devstack.
Traces and screenshots of failures land in `e2e/test-results/` (gitignored); an HTML report in `e2e/playwright-report/`.

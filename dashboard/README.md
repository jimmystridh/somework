# Operations (the fleet dashboard)

The operators' console of the agent cluster (ADR 0004; it was the fleet dashboard): hypervisor machines, the SomeWork section (agents, jobs, events, subscriptions, hub, token pools) and, per agent, how it is set up. A Rust workspace of its own (`shared`, `server`, `ui`; Dioxus web UI, axum server), kept outside the root workspace. The design and the data it may show are in `docs/FLEET_DASHBOARD.md`: metadata only for everything read from agents, every value picked by name through a restricted reader. The one deliberate exception flows the other way: operator wording (an agent's instructions, skills, MCP servers, model and approval patterns, and the fleet limits) is written in Operations and sent to the agents (see "Operations").

## Agent setup

Each agent serves `/profile` next to `/status` on its health port (`packages/agent-kit/README.md`, "/profile"). The dashboard reads it for every entry of `agents-health.json` whose address ends in `/status`, passes it through `server/src/setup.rs` (names, restricted alphabets, length limits; unread fields never reach the page) and shows one card per agent on the agent's own page in Operations (Agents, Overview): role, image tag, setup hash and when it last changed, capabilities, model, budgets, tools and approval patterns, repository access (credential kind, GitHub identity, token expiry note), skills, conversation and event settings, and the system prompt text with its hash. The prompt is operator wording: the page is only reachable through the private gateway.

`agents-health.json` entries may carry `"logs": "{container=\"somework-pi-agent-1\"}"` (a stream selector of one to three matchers); with `GRAFANA_URL` set (plain https, no path) the page links each agent to its logs in Grafana Explore. Only plain selectors and addresses are accepted.

## Jobs

Agents publish `agent.<slug>.job.started`, `.waiting` and `.finished` for every job (`packages/agent-kit/src/threads/reporter.ts`). The server reads them from the domain's admin event log (`server/src/jobs.rs`, `JobBook`) and shows, on each agent's Jobs tab (and fleet-wide under SomeWork), the jobs that run and wait and what the waiting ones wait for, an active-jobs table with how long each has been in its state, the recently finished jobs with their result and the agent's own short summary, and the hourly throughput. Labels and summaries are the agents' own wording, cut and shown as plain text; job input, results and message content are never read.

## Work history and model usage

Each agent also serves `/history` next to `/status` (its job record: the latest 500 jobs with what each was about, how it ended, duration, tokens by kind, cost, pull request and a short redacted summary). The dashboard reads up to 200 per agent through `server/src/history.rs` (names, restricted alphabets, the summary as plain text) and shows them on the agent's History tab and, for all agents, under Work history: one tab per agent (Aikido fixer and QA first), the outcomes as filter chips, a row per job that opens to its details. The jobs are the ones an agent has recorded since it runs a version with the extended record.

"Model usage and cost" reads the central Prometheus through the read-only Grafana endpoint (`server/src/usage.rs`): the agents' `somework_llm_tokens_total` and `somework_llm_cost_usd_total` as increases over 24 hours, 7 days and 30 days per agent, provider and model. It needs `METRICS_URL` (https, for example `https://10.10.10.13:9444`) and, in the secrets directory, `metrics-token` (a Viewer token: `deploy/grafana/provision-reader.py --name somework-fleet-reader`) and `metrics-ca.pem`; the Grafana host must allow the dashboard's address. Without them the section says it is not available. The numbers are read once a minute.

The old heartbeat card of the "Pi" demo agent is gone from the page (the `/ingest/pi` endpoint still accepts heartbeats and is unused).

## Operations

Operations is the backend of ADR 0004: it stores what operators change about agents in Postgres and sends it to them. The route table and the delivery flow are in `docs/OPERATIONS_SETUP.md`; the wire format is `packages/agent-kit/src/setup/contract.ts` (ported to Rust in `server/src/ops/contract.rs`, with the same limits). The JSON types of every route are in `shared/src/operations.rs`, documented there.

Code: `server/src/ops/` (`store.rs` Postgres, `contract.rs` validation and composition, `diff.rs`, `oidc.rs` and `session.rs` sign-in, `api.rs` routes, `delivery.rs` upload and send through `crates/somework-client`, `reconcile.rs` the 15 second loop, `keygen.rs`), migrations in `server/migrations/` (numbered, applied at start; a database whose schema is newer than the server refuses the start).

**It is off** unless `DATABASE_URL` or `DATABASE_URL_FILE` is set: the `/fleet/api/ops` and `/fleet/auth` routes then answer 503 and the dashboard works as before.

| Setting | Meaning |
| --- | --- |
| `DATABASE_URL` / `DATABASE_URL_FILE` | `postgres://operations:<password>@<host>:5432/operations?sslmode=verify-full`. TLS is required (`sslmode` require, verify-ca or verify-full) unless `OPERATIONS_DATABASE_ALLOW_PLAINTEXT=1` (a developer's own database). `DATABASE_CA_FILE` names the CA of the server certificate. |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET_FILE`, `OIDC_REDIRECT_URL` | Entra ID sign-in, one tenant. The redirect URL must end in `/fleet/auth/callback`. |
| `OPERATIONS_FIRST_ADMIN` | email of the first administrator; added only while the allow list is empty. |
| `OPERATIONS_SESSION_KEY_FILE` | at least 32 random characters that sign the cookies; without it sessions end at every restart. |
| `OPERATIONS_KEY_FILE` (default `<secrets>/operations-key.json`), `SOMEWORK_URL`, `OPERATIONS_DOMAIN_ID`, `SOMEWORK_CA_FILE` (default `<secrets>/somework-ca.pem`) | the signing key of `service:operations` and the domain it sends to. Without the key or `SOMEWORK_URL` revisions are stored but not delivered, and the console says so. |
| `OPERATIONS_AUTH=stub`, `OPERATIONS_STUB_USER=email:role` | development only: everybody is that user. Refused unless the listener is loopback (`FLEET_PREVIEW=1`); `OPERATIONS_UNSAFE_STUB=1` overrides that and must never be set on a deployment. |

**Sign-in.** Authorization code with PKCE against the tenant; the id_token's signature (RS256, the tenant's JWKS), issuer, audience, nonce and expiry are checked, its email (`email`, else `preferred_username`) must be on the allow list (`users`: viewer, editor, admin), otherwise the sign-in is refused and audited. The session is a signed cookie (`__Host-ops_session`, `HttpOnly; Secure; SameSite=Lax`, 8 hours) that holds the email only; the role is read from the table on every request. Every write needs the header `X-Operations-Request: 1`. Roles: viewer reads (agents, catalog, library, limits, audit), editor edits agents, catalog and library, admin also edits limits and the allow list and reads it (the list of users is admin-only).

**The old routes.** `/fleet/api/fleet` and `/fleet/api/somework` stay readable behind the gateway alone, as before. The new `/fleet/api/ops` routes sit behind the gateway too and additionally need the Entra session.

**Delivery.** A save is a new revision of the agent's form (names of library skills and catalog entries plus text). The server composes the document when it sends (library and catalog resolved at that moment), uploads it as an `application/json` artifact and sends a `chat.message` with `triggerMode: directed` (the domain allows only `never` on a `chat.notice`) from `service:operations`, with the labels `setup.kind`, `setup.revision` and `setup.sha256` and the idempotency key `setup:<agent>:<revision>` (`limits:<agent>:<revision>` for fleet limits). The loop reads each agent's `/profile` (`setup`, `setup.defaults`, `setup.effective`; a profile may lack any of them) every 15 seconds, and sends again, at most once a minute with a key of its own, when the agent reports an older revision. It does not send again a revision the agent rejected (the reason shows; `POST /agents/{slug}/resend` forces it), nor to an agent it cannot read (the message is durable). A failed send is retried after 15, 30, then 60 seconds and stays visible on the agent's row. Editing a catalog entry or library skill adds a revision for each agent that uses it, noted with the entry's name; an entry that agents use cannot be deleted. The agent's `setup.ack` notices are not read: `/profile` is the source.

**Entra app registration (once, by an Entra administrator).**
1. App registrations, new registration, single tenant ("accounts in this organizational directory only"), platform Web, redirect URI `https://<the address people open the dashboard on>/fleet/auth/callback`.
2. Note the application (client) id and the directory (tenant) id: `OIDC_CLIENT_ID`, and `OIDC_ISSUER=https://login.microsoftonline.com/<tenant id>/v2.0`.
3. Certificates and secrets, new client secret; put its value in the secrets directory as `oidc-client-secret` (mode 0400). Renew before it expires.
4. API permissions: the default `User.Read` is enough (openid, profile and email are requested as scopes). If people sign in with an address that the tenant does not put in `email`, the `preferred_username` claim is used.
5. The allow list in Operations is the boundary: being in the tenant is not enough.

**The pilot's registration.** Operations signs in through the existing single-tenant registration `spiris-visma-jira-mcp` (client id `c7baacf9-7f62-40bb-8c51-fbd8d77507f3`, tenant `c166b9c4-5053-4eec-9665-aba0782d0804`, owner: the operator's admin account) instead of a new one, so step 1 is done: `https://admin-cloud-observability.tail371505.ts.net/fleet/auth/callback` was added on 2026-10-11. Still to do is step 3, a client secret of its own for Operations (do not reuse another service's), written straight into `oidc-client-secret` on the host. The registration is shared with about ten unrelated services, so any secret of it can be used to sign in through it: the allow list is what protects Operations.

**The gateway must let the session through.** The nginx gateway on VM104 (`/etc/nginx/conf.d/agent-cluster-ui.conf`, `location /fleet/`) blanks the `Cookie` request header and answers 403 to every tailnet user but the owner. Both break the Entra sign-in: for `/fleet/` it must pass `Cookie` on, and each person who should use Operations has to be allowed. Operations' own sign-in and allow list then decide who may do what; the gateway's bearer injection stays as it is. Nothing here changes the gateway; it is a deploy step.

**First administrator.** Set `OPERATIONS_FIRST_ADMIN` to your email and start; it is added when the allow list is empty and the start says so. Sign in at `/fleet/`, then add people under users (`PUT /fleet/api/ops/users/<email>`). Remove the variable afterwards if you like; it never adds anyone to a list that has entries.

**The `operations` principal.** Make its key on the host that runs Operations, never elsewhere: `fleet-server --operations-keygen --domain <domain id> --out /etc/agent-cluster-fleet/operations-key.json` prints the public key. On the domain host `deploy/register-operations-principal.sh '<public key>' --apply` registers `service:operations` with `message.send` and `artifact.write` only.

**Postgres on VM104.** `deploy/postgres/` holds the container (`compose.yaml`: its own volume, listener on the private address only, TLS required with the server certificate and key mounted, `pg_hba.conf` accepting TLS with SCRAM from the private network only, roles and passwords from secret files, healthcheck), a nightly dump with 14 days of retention (`backup.sh`, `operations-postgres-backup.service` and `.timer`) and `restore-test.sh`, which restores the newest dump into a throwaway container and checks it. Copy `.env.example` to `.env` next to `compose.yaml` for the Operations container's settings. Nothing in the repository runs these against a host.

## Operations UI

The UI (`ui/`, Dioxus 0.7 with the router; the bundle is served under `/fleet/`) keeps no state of its own. One page per rail entry:

| Path | Page |
| --- | --- |
| `/` | Agents: health, saved against applied revision, `pending` / `rejected: reason` |
| `/agents/<slug>/<tab>` | one agent: `overview`, `jobs`, `history`, `setup` (the editor), `revisions` |
| `/catalog`, `/library` | MCP catalog and Skill library, each with an editor and its revisions |
| `/limits`, `/users` | Fleet limits and the allow list (administrators) |
| `/audit` | who did what |
| `/somework`, `/history`, `/usage`, `/machines` | the older fleet sections, as they were |

Viewers see everything read-only: the buttons follow the role that `GET /api/ops/me` reports, and the server enforces it anyway. A 401 sends the browser to `/fleet/auth/login?next=<this page>`. Text from operators and agents is always rendered as text: `ui/tests/static_checks.rs` fails on `dangerous_inner_html` and on inline styles (the content policy forbids them; classes live in `public/style.css`).

**The server must answer every `GET /fleet/<path>` that is not an asset, `/fleet/api/` or `/fleet/auth/` with `index.html`**, or a deep link and a reload of `/fleet/agents/qa/setup` give 404. With axum: `ServeDir::new(public).fallback(ServeFile::new(public.join("index.html")))`.

## Build

```
cargo test                                         # server and UI unit tests; the Postgres tests need initdb/postgres/pg_ctl
rm -rf target/dx/fleet-ui/release/web/public   # stale hashed files would be bundled too
dx bundle --release --platform web --package fleet-ui
rm -rf bundle && cp -R target/dx/fleet-ui/release/web/public bundle && cp public/style.css bundle/style.css
docker build -f dashboard/Dockerfile -t agent-cluster-fleet:<version> ..   # from dashboard/: the context is the repository root
```

The server depends on `crates/somework-client` by path, so the image is built with the repository root as the build context (`Dockerfile.dockerignore` keeps the context to `Cargo.toml`, `crates/` and `dashboard/`); the Dockerfile compiles the server and copies `bundle/`.

The integration tests start a throwaway Postgres (a random port on 127.0.0.1, removed afterwards) from `initdb`, `postgres` and `pg_ctl` found in `POSTGRES_BIN_DIR`, the `PATH`, `/opt/homebrew/bin` or `/usr/lib/postgresql/*/bin`. Without them each test prints `SKIPPED <name>` on stderr and does nothing; `REQUIRE_POSTGRES=1` turns that into a failure (use it in CI).

`compose.yaml` runs it on the services VM (TLS port 9444 behind the tailnet gateway; secrets directory with the domain key, CA, `agents-health.json`, hub admin token and the Operations files above).

The code keeps the pilot's host names as defaults (the TLS name its healthcheck verifies, the hypervisor address); change them with the environment (`compose.yaml`) before using the dashboard elsewhere. This repository is private.

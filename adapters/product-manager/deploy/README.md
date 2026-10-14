# Deploying the Cluster Product Manager on the agent Docker host

Three containers in their own compose project (`deploy/compose.yaml`, project `somework-product-manager`): `agent` (the harness, this role's image), `sandbox` (the developer role's sandbox image, on an internal network) and `egress` (the proxy that lets the sandbox reach the code host and nothing else). This file is the runbook; what the role is and does is in `../README.md`.

* **Own everything.** Own SomeWork identity (`agent/product-manager`), own model login, own **read-only** git token, own Plane user and key, own Telegram bot, own sandbox volume and token, own state volume, own health port (`127.0.0.1:8086`; 8081 developer, 8082 reviewer, 8083 Aikido fixer, 8084 Datadog triage, 8085 Jira triage on the same host).
* **Read-only by construction.** No push token, no pull request, no events; `bash` runs plain inspection only (the guard refuses the rest before anybody is asked); in Plane it can search, read, file and comment, and a ticket is filed only after a human approved its exact text.
* **Its own Plane user.** Make a bot user in Plane (for example "Cluster Product Manager"), add it to the product's one project only, and create its API key. Everything it files and comments is shown in Plane as that user. Do not give it another person's key.

## Manual steps, in order

1. **Enrol the principal** (on the domain host, `ops` as in the root `deploy/README.md`), with the key made on the agent host so that it never travels:
   ```bash
   mkdir -p keys && chmod 700 keys && chown 10001:10001 keys
   docker run --rm -u 10001:10001 -v $PWD/keys:/keys --entrypoint somework-sidecar somework-worker:<tag> keygen --id agent/product-manager --key-out /keys/agent.key.json
   ops admin --config /etc/somework/somework.toml enroll-agent --id agent/product-manager --public-key '<publicKey>' --side-effects write
   cp card.json cards/product-manager.json        # adapters/product-manager/card.json
   ops admin --config /etc/somework/somework.toml register-card --card /cards/product-manager.json --approve
   ```
   Then reload the NATS broker's logins (`docker kill -s HUP somework-domain-nats-1` on the domain host) and check `GET /v1/connection` as the agent.
2. **Secrets and files on the host** (`~/somework-pilot/product-manager`, uid 10001, secrets mode 0440/0600):
   | Path | What |
   |---|---|
   | `keys/agent.key.json` | the identity key (directory 0700) |
   | `config/ca.pem` | the private CA of the domain |
   | `secrets/sandbox-token` | random, mode 0440, group 10010: shared by agent and sandbox of THIS project |
   | `secrets/pi/auth.json` | **this role's own model login** (never copy another agent's file: a refresh token that two services hold invalidates itself) |
   | `secrets/git-token` | a fine-grained token, **read-only** (Contents and Pull requests: read) on the product's repository; an empty file runs without one |
   | `secrets/plane-key`, `config/plane-ca.pem` | the Plane user's API key, and the CA when a private one signed Plane's certificate (`PLANE_KEY_HOST`, `PLANE_CA_HOST` in `.env`) |
   | `secrets/telegram-bot-token` | the BotFather token of this agent's own bot (`TELEGRAM_TOKEN_HOST`) |
   | `.env` | from `.env.example` |
   Never paste a token into a chat or a repository: a secret that was ever there is burnt.
3. **Plane.** In the product's project, create the labels `feature`, `bug` and `product-feedback` (the tool refuses a label the project lacks). Put the base URL, the workspace slug and the project id into `.env` (`PLANE_*`). Without `PLANE_BASE_URL` the agent runs without the ticket tools and drafts the ticket in the conversation instead.
4. **Telegram.** Create a bot with BotFather (the owner does this), put its token into `secrets/telegram-bot-token` and the owner's numeric id into `TELEGRAM_ALLOWED_USER_IDS`. Slack follows once the app is approved: drop its two tokens in (`SLACK_*`, `packages/agent-kit/docs/slack-app-manifest.yaml`).
5. **Approvers.** A human who asks for something approves their own ticket. A request that arrives from another agent needs a named approver: set `APPROVERS=kind:human,<the owner's principal id>` so the approval question reaches the owner.
6. **Open the health port.** Add `8086` to `HEALTH_PORTS` in `/etc/default/agent-health-firewall` on the agents VM and restart `agent-health-firewall.service` (Docker bypasses ufw). Set `HEALTH_BIND=10.10.10.11` in `.env` if the dashboard and Alloy should reach it.
7. **Build and start** (from the repository root; or let the CI deploy do it, step 8):
   ```bash
   docker build -f adapters/product-manager/Dockerfile --target agent -t somework-product-manager:<tag> .
   cd ~/somework-pilot/product-manager       # compose.yaml, .env, keys, secrets and config live here
   docker compose --profile init run --rm -T init-volumes </dev/null
   docker compose up -d
   docker compose logs agent --tail 30       # expect plane_enabled (when configured), runtime_started, service_started {"role":"product-manager"}
   curl -s http://127.0.0.1:8086/ready
   curl -s http://127.0.0.1:8086/profile     # plane.enabled, capabilities [product.intake]
   ```
8. **CI deploys it from then on.** `deploy/agents/deploy-from-ci.sh` builds `somework-product-manager:ci-<sha>` and rolls the stack (`PRODUCT_MANAGER_VERSION,SANDBOX_VERSION`, health `http://10.10.10.11:8086/ready`) **only when `~/somework-pilot/product-manager/compose.yaml` exists** on the host; the `.env` must hold both variables. `scripts/fleet-suspend.sh` stops and starts the stack with the others.
9. **Operations.** Enrol the agent in the console (it appears once it registered its card), then give it the `grill-me` library skill and the instructions in its Setup override; set its limits to the low end. See `../README.md`, "Operations".
10. **Observability.** Alloy: add `product-manager=10.10.10.11:8086` to the `install-metrics.sh` targets (`deploy/observability/README.md`). The dashboard: add `{"id": "agent/product-manager", "url": "http://10.10.10.11:8086/status", "logs": "{container=\"somework-product-manager-agent-1\"}"}` to its `agents-health.json` and restart it.

## Smoke test

1. **Without credentials.** `PI_PROVIDER=faux` with `PI_FAUX_PLAN='["final:hello"]'`: a message to the agent (or to its bot) gets an answer; `/profile` shows `plane.enabled` as configured.
2. **Plane, with the real key.** Ask for a small feature in Telegram. Expect an interview with a recommended answer on every question, then an approval question that holds the whole ticket; after `/approve` the ticket appears in the project with label, no priority, no assignee, the default state, and the conversation id as its external id. Ask it to file again in the same conversation: it answers that the ticket exists and files nothing.
3. **Read-only.** Ask it to change a file or push: it refuses. In the log there is no `bash` call that was not plain inspection.

## Operate

* Health: `127.0.0.1:8086/ready`, `/status` and `/profile`.
* Rotate the Plane key or the Telegram token: write the new one into the file and restart.
* Pause it without stopping it: the Operations console's pause, or the Manager's `/suspend` for everything.

## Roll back

`docker compose` with the previous `PRODUCT_MANAGER_VERSION` in `.env` (`docker compose up -d`); tickets already filed stay in Plane.

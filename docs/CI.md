# CI (Woodpecker)

Woodpecker validates and deploys the rules (`docs/adr/0002-woodpecker-ci-for-rules.md`, `docs/EVENTS.md`). This note describes the roles, flows and how to operate it. Files for the deployment are in `deploy/ci/` with `${PLACEHOLDERS}` for the values that belong to a particular installation.

## Roles

| Part | Where | What it holds |
|---|---|---|
| Server | the services VM, Docker, SQLite | forge login, repositories, pipeline secrets, build history |
| Runner (agent) | its own small VM, Docker | nothing of SomeWork; runs pipeline containers through the Docker socket (root-equivalent, which is why it is not on the services VM) |
| Gateway | the observability VM, nginx + Tailscale Serve | the owner-only HTTPS entry to the web UI (second HTTPS port of the same tailnet name) |
| Receiver + hub | public edge and private side of the events design | the only way GitHub webhooks reach the server |

## Network policy

* The server publishes two ports on the private bridge address: web/API (TLS, private CA certificate) and gRPC. Docker ignores `ufw` for published ports, so the policy is in the `DOCKER-USER` chain (`deploy/ci/woodpecker-firewall.sh`, unit `woodpecker-firewall.service`): web/API only from the gateway and from the hub (webhook replay), gRPC only from the runner. Anything else is dropped.
* The runner connects out to the server; nothing connects to the runner. It accepts ssh only from the agents VM and the developer VM.
* The web UI is reachable only through the gateway, which answers `403` unless the Tailscale identity header names the owner. Login is GitHub OAuth (an OAuth application owned by the organisation, callback `<server URL>/authorize`), so two independent checks apply: tailnet identity and GitHub login. `WOODPECKER_OPEN=false`; the only admin is the owner; only repositories of the organisation can be activated; user-registered agents are disabled.
* The gRPC link carries the shared agent secret in clear text on the private virtual bridge between two VMs on the same host. If the runner ever moves off that bridge, terminate TLS first (`WOODPECKER_GRPC_SECURE` on the agent).

## Secrets

Files on the server host (directory mode 0700, files 0600, owned by the container user): `server.key`, `server.crt` (signed by the private CA, valid one year; renew by a new request signed on the CA host), `agent-secret` (shared with the runner, copied host to host, never through a terminal), `grpc-secret` (JWT signing, persisted so agents survive a restart), `github.env` (OAuth client id and secret). The runner holds only `agent-secret`. Keep a copy of the OAuth secret in the password manager; rotate by generating a second secret in the OAuth application, updating `github.env`, restarting the server, then deleting the old one.

## Webhooks (GitHub to the server)

GitHub cannot reach the private network. Webhooks arrive at the public receiver as a **forward** source and the hub replays them, byte for byte with the original headers, to the server's `/api/hook` (web/API port). Woodpecker builds the webhook address it registers on a repository from `WOODPECKER_HOST`; set `WOODPECKER_EXPERT_WEBHOOK_HOST` to the receiver's forward address **before activating a repository**, otherwise GitHub is told to call the tailnet-only address. The forwarded request carries a query parameter `access_token` (a signed token); the receiver and the hub must pass the path suffix and query string through unchanged and never log them.

## Activating the rules repository

1. Open the web UI through the gateway, log in with GitHub, enable the repository.
2. Add pipeline secrets, restricted by event and branch: `somework_rules_key`, `somework_url`, `somework_ca` for the deploy pipeline (event `push`, branch `main`), and the GitHub token used to post plans on pull requests for the check pipeline. Never expose them to `pull_request` events from forks.
3. Turn on "protected" for the deploy pipeline and require the owner's review through CODEOWNERS on `rules/`.

## Operating

* Server: `docker compose ps` / `logs` in the server project; logs also reach the central log store (service container name `...woodpecker-server-1`). `GET /healthz` answers `204`.
* Runner: `docker compose logs agent`; a daily job prunes images older than three days. The agent appears in the server database table `agents` with its labels; a repository filter label (`repo=<owner>/<name>`) keeps other repositories off it.
* Upgrade: pin the new tag and digest in both compose files, pull, `docker compose up -d`; read the release notes for migrations first. The server and the runner should run the same minor version.
* Back up the server's data directory (SQLite) with the services VM; the runner is reproducible and deliberately outside the backup job.

## Installing dependencies with bun

The `check` pipeline runs on pull requests and on every push to `main` (the plan and its comment only on pull requests), so a code push is checked too. The `check` and `deploy` pipelines install in their own step with the official `oven/bun` image (pinned by digest): `bun install --frozen-lockfile --ignore-scripts`. Bun reads the committed `package-lock.json` (no second lockfile), installs the same package versions as `npm ci`, runs no lifecycle scripts and fails when the lockfile no longer matches a manifest. The other steps run on the node image over the same workspace. `full.yaml` still uses `npm ci`. Timings are in `TODO.txt` (section 11b, F).

## Rolling agents (from CI, or by hand)

`deploy/agents/roll-agent.sh STACK_DIR VERSION_VARIABLE[,VARIABLE...] TAG [READY_URL] [NEW_COMPOSE_FILE]` is the one way an agent stack is moved to a new image tag: it keeps `compose.yaml` and `.env` as `*.before-TAG`, sets the tag, runs `docker compose up -d`, waits for `/ready` and, when the agent does not become ready, puts the old files back and starts the old version again (exit status 1). One-off settings, such as `AIKIDO_RESEED_HANDLER=1`, go in the environment of the command. `npm run test:scripts` tests it with a fake docker.

The `deploy-agents` pipeline (`.woodpecker/deploy-agents.yaml`) rolls the agent stacks (the Jira triage stack only once it exists on the host: `deploy-from-ci.sh` skips it, image and roll, until `~/somework-pilot/jira-triage/compose.yaml` is there) on every push to `main` that touches `adapters/`, `packages/`, `sdk/`, the lockfile or the deploy scripts (and on a manual run), after the `check` pipeline of the same commit passed. The runner holds one secret for it, `somework_deploy_key` (events `push` and `manual`), an ed25519 key whose entry in the agents VM's `authorized_keys` reads `command="/home/js/somework-pilot/bin/deploy-from-ci.sh",restrict,from="10.10.10.15"`: from the runner's address only, no shell, no forwarding, and the single permitted command is `deploy <40-hex commit>`. The pipeline pipes a tar of the checked-out repository to it. `deploy/agents/deploy-from-ci.sh` unpacks it on the agents VM, builds every agent image as `ci-<short sha>` there, and rolls datadog-triage, reviewer, aikido-fixer and the developer one after the other with `roll-agent.sh` and the repository's compose file; it stops at the first stack that does not become ready (that one restores itself, the earlier ones stay on the new tag), and a lock keeps two deployments from overlapping. `npm run test:scripts` tests it with fake docker and roll scripts.

Install and rotate by hand, because a key that could replace the wrapper could run anything: copy `deploy/agents/deploy-from-ci.sh` and `roll-agent.sh` to `~/somework-pilot/bin/` on the agents VM, add the key line, `ufw allow from 10.10.10.15 to any port 22 proto tcp`, put the private key into the Woodpecker secret (`somework_deploy_key`) and the host key of the agents VM into the pipeline's `known_hosts` line. Per-stack settings that differ between machines (observe, egress) live in each stack's `.env`, which the roll never overwrites.


## Deploying the Windows machines (QA and Windows developer)

Nothing on the two Windows machines is changed by hand any more except the one-time bootstrap below. The `deploy-windows` pipeline (`.woodpecker/deploy-windows.yaml`) runs after `check` on every push to `main` that touches `packages/agent-kit`, `sdk/typescript`, `adapters/qa`, `adapters/windows-developer`, the package files or the wrapper itself. It deploys QA first and the Windows developer second, and stops at the first failure. The secret is `somework_windows_deploy_key`; each machine's `administrators_authorized_keys` entry forces `C:\somework\bin\deploy-from-ci.ps1` and the only accepted command is `deploy <40-hex commit> <size>`; the pipeline then sends exactly `<size>` bytes of a tgz of the repository on stdin (size-prefixed, because Windows OpenSSH does not propagate stdin EOF). The step retries three times and fails a transfer that stalls for a minute.

What `deploy/windows/deploy-from-ci.ps1` does, under the mutex `Global\somework-deploy`: stage and unpack the archive, back up the current tree to `C:\somework\deploy\backup\<time>` (three kept), mirror `packages/agent-kit/src`, `sdk/typescript/src`, `adapters/<role>/src` and `adapters/<role>/deploy`, install `profiles.pilot.json` as `profiles.json` and `managed.env` as `managed.env`, refresh the Defender exclusions and the folder permissions, rewrite the firewall allow list (`firewall-allow.pilot.txt`, read by the `*FirewallRefresh*` task), install the QA test stack scripts (`adapters/qa/deploy/qa-app`), run `npm ci` when the lockfile hash changed, restart the scheduled task and wait for `/ready` (120 s). A failure at any point puts the backup back and restarts the old version.

Everything machine-specific therefore lives in the repository: profiles and managed settings (`adapters/<role>/deploy/profiles.pilot.json`, `managed.env`), firewall allow lists, the QA skill overlay (`adapters/qa/deploy/skills-overlay/qa.md`) and the QA stack scripts. The overlay names the companies that open on the QA machine (the sharded back end answers 428 "Tenant not set up" for a company without a shard number); update that list there when the machine's databases change.

The wrapper never re-applies a folder permission that is already there: Windows pushes a grant into every existing file below the folder, and over the QA machine's many checkouts (each with a full `node_modules`) that took half an hour per deploy. A deploy now takes about 20 minutes, most of it `npm ci` and the agent restart.

Bootstrap by hand, once per change of the wrapper itself (a key that could replace the wrapper could run anything): copy `deploy/windows/deploy-from-ci.ps1` to `C:\somework\bin\` on each machine, set the forced command in `C:\ProgramData\ssh\administrators_authorized_keys` for the pipeline's key, allow the runner (10.10.10.15) through the machine's firewall on port 22, and put the private key into the Woodpecker secret.

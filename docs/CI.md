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

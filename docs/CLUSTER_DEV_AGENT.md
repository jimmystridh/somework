# Cluster development agent (design, decided 2026-10-12)

An agent that does the work a developer does in this repository's cluster: reads logs and metrics, finds causes, changes the Manager and the other agents, runs the tests and deploys them. Identity `agent/cluster-dev`, a kit role (`adapters/cluster-dev`) with the developer role's workspace and git tools plus the cluster tools below.

## Decisions (owner)

* **Runs on its own VM** in the Proxmox pool `somework`, alone: it holds deploy keys for every host, so nothing else may share its machine, docker socket or secret files.
* **Asks only for destructive actions.** Reading, changing code on a branch, running tests, pushing, deploying and restarting are its own call and it reports afterwards. It always asks first (a confirmation in Telegram with the exact command or diff) before: removing volumes, containers' data, VMs, files outside the repository, database rows or tables; anything that touches secrets (reading, writing, rotating); anything on the hypervisor; changing firewall rules; force-pushing or rewriting history.
* **Own scoped credentials, plus hypervisor root.** Its own SSH key per host (sudo rules as needed), a GitHub token for the org repository only, a read-only Grafana token, an Operations editor token, a CI token, a Proxmox token for the pool, and root ssh to the hypervisor. Never the owner's GitHub login, 1Password or Cloudflare; never the public `origin` remote.

## What it needs that does not exist yet

1. The VM (clone of the Ubuntu template), the role package and its image, its model login, a Telegram bot.
2. Tools: `host_exec` (ssh to a named host from an allow-list, output scrubbed of secrets, destructive commands refused until confirmed), `deploy` (the repository's own scripts and CI: trigger, wait, verify `/ready`), `logs` and `metrics` (the kit's observe tools with scope `all`), `operations` (the Manager's Operations calls), `ci` (pipelines and their logs).
3. A classifier for "destructive" shared with the approval gate, with tests, so the rule is code and not a sentence in the prompt.

## Built (2026-10-12)

The code for the role is `adapters/cluster-dev` (`@somework/cluster-dev`, workspace entry and lockfile entry added). Nothing is deployed, no host, GitHub, Telegram, Proxmox or Grafana was touched, and no secret is in the repository. Everything is tested offline with fakes (`npm test` in the package, 188 tests; `npm run check:roles` passes). Two tests start a real domain and the service process on loopback and need `SOMEWORK_BIN`; `ssh` is not on that process's PATH.

### What exists

| Part | Where | What it is |
|---|---|---|
| Role | `card.json`, `src/profile.ts`, `src/main.ts`, `src/hooks.ts`, `src/chat.ts`, `src/prompt.ts` | agent `agent/cluster-dev`, capability `code.cluster` v1 (a larger change as a pull request); conversations with the developer role's coding tools, the checkout to copy, the `cluster_change` job; people only may approve; observe scope `fleet` |
| Classifier | `src/classifier/` | `classifyCommand(command, context?)` returns `{destructive, reason?, category?, forbidden?}`: the single source of truth for what needs the owner. It reads shell syntax, looks inside `sudo`, `ssh host '...'`, `bash -c`, `docker exec`, `$(...)`, here-documents and wrappers, and errs towards asking. The rules are the table in `adapters/cluster-dev/README.md` and the specification is `test/classifier*.test.ts` (about 800 commands, and each dangerous one again in 50 ways of writing it) |
| Approval | `src/approvals.ts` | `toolApprovals` for `bash`, `host_exec`, `read`, `write`, `edit` call the classifier (the kit's approval gate, then Telegram); a guard stops a forbidden push and a destructive command too long to show in full before anybody is asked |
| `host_exec` | `src/tools/host-exec.ts` | ssh to a host of the allow-list with its own key; classify first; destructive means the approval gate and refusal without the owner's answer (the tool reads the gate's answer for its own call id, so it fails closed); time and output caps; secrets scrubbed; output framed as data |
| `git_push` | `src/tools/git-push.ts` | not in the first list of tools, added because the sandbox has no credential: pushes a branch of a checkout to the configured repository only, no force, no deletion, token through the credential helper of that one command |
| `ci_pipelines`, `ci_logs` | `src/tools/ci.ts` | Woodpecker REST (read only), token from a file |
| `deploy_status` | `src/tools/deploy-status.ts` | `/ready`, `/status`, `/profile` of each agent in a settings map, the git commit out of the `ci-<sha>` image tag, optional comparison with an expected commit |
| Logs and metrics | the kit's observe tools | scope `fleet` (the kit's name for "all"): `OBSERVE_SCOPE=fleet`, the role's default |
| Deployment | `Dockerfile`, `deploy/compose.yaml`, `deploy/.env.example`, `deploy/firewall-allow.example.txt`, `deploy/README.md` | the harness image (with an ssh client), compose project `somework-cluster-dev` (the developer role's sandbox and egress images), placeholders only |

### Settings and environment names

Role (`src/settings.ts`): `CLUSTER_DEV_REPOSITORY`, `CLUSTER_DEV_GIT_REMOTE` (default `org`; `origin` is refused), `CLUSTER_DEV_EXTRA_REPOSITORIES` and `CLUSTER_DEV_GIT_TOKEN_DIR` (more repositories `git_push` may push to, each with a token of its own: a fine-grained token has one owner), `CLUSTER_DEV_HOSTS` (`name=user@address[:port]`), `CLUSTER_DEV_SSH_KEY_DIR` (default `/run/secrets/ssh`, one key per host named like the host), `CLUSTER_DEV_SSH_KNOWN_HOSTS`, `CLUSTER_DEV_HYPERVISOR_HOSTS` (default `pve-host,proxmox,pve`), `CLUSTER_DEV_OWN_SERVICES`, `CLUSTER_DEV_SCRIPTS`, `CLUSTER_DEV_WORKSPACES`, `CLUSTER_DEV_EXEC_TIMEOUT_SECONDS`, `CLUSTER_DEV_EXEC_MAX_BYTES`, `CLUSTER_DEV_AGENT_URLS` (`name=http://address:port`), `CLUSTER_DEV_AGENTS_CA_FILE`, `CI_URL`, `CI_REPO`, `CI_TOKEN_FILE`, `CI_CA_FILE`. The kit's own: `GIT_TOKEN_FILE` (or `GITHUB_APP_*`), `GRAFANA_URL`, `GRAFANA_TOKEN_FILE`, `OBSERVE_ENABLED`, `OBSERVE_SCOPE`, `TELEGRAM_BOT_TOKEN_FILE`, `TELEGRAM_ALLOWED_USER_IDS`, `APPROVERS`, `PI_*`. Full table: `adapters/cluster-dev/README.md`.

### What is still needed to stand it up

By the owner (accounts and machines only the owner has):
1. **The VM**: clone the Ubuntu template into the pool `somework`, alone, with Docker (`deploy/README.md`, step 1).
2. **A key per host**: on the VM `ssh-keygen -t ed25519` once per host (`agents`, `services`, `runner`, `pve-host`), the public key in that host's `authorized_keys` (restricted with `from=`), sudo rules in `/etc/sudoers.d/cluster-dev`, the host key fingerprints compared before they go in `known_hosts`. Root ssh on the hypervisor as decided; every command there asks the owner.
3. **GitHub token**: fine-grained, the organisation repository only, Contents and Pull requests write, Metadata read (or a GitHub App) into `secrets/git-token`.
4. **Woodpecker token** into `secrets/ci-token`, with `CI_URL` and `CI_REPO`.
5. **Grafana token**: a Viewer service account (`deploy/grafana/provision-reader.py`) into `secrets/grafana-token`.
6. **Proxmox token** for the pool: decided, but no tool uses it yet (see below); create it when a Proxmox tool exists.
7. **Model login**: the device-code login of this agent alone into `secrets/pi/auth.json`.
8. **Telegram bot**: a bot of its own from BotFather, its token into `secrets/telegram-bot-token`, the owner's numeric id in `TELEGRAM_ALLOWED_USER_IDS`.
9. The outbound firewall of the VM from `deploy/firewall-allow.example.txt`.

By the developer (code and repository work, no secrets):
1. Merge this work and run `npm ci` (the lockfile has the new workspace); `scripts/grant-job-events.ts` for `agent/cluster-dev`; `ops admin enroll-agent --id agent/cluster-dev --side-effects write` and `register-card` (`deploy/README.md`, step 2).
2. Build `somework-cluster-dev` on the VM (it is deployed by hand on its own VM, not by `deploy-agents`, which rolls the agents VM only) and the developer role's sandbox and egress images, fill `.env` from `.env.example`, `docker compose up -d`, run the smoke test of `deploy/README.md`, step 10.
3. Decide about the open points: the `operations` tool of this document (the Manager's Operations calls) and a Proxmox tool are not built; the sandbox image has no Rust toolchain, so `cargo test` cannot run in it; Woodpecker user tokens act as their user, so the CI token should belong to a dedicated read-only user if Woodpecker has one.

# Deploying the cluster development agent

One virtual machine, **this agent alone on it** (Proxmox pool `somework`, a clone of the Ubuntu template): it holds an ssh key for every host of the
cluster, so nothing else may share its machine, its docker socket or its secret files. Two containers plus an egress proxy in their own compose project
(`deploy/compose.yaml`, project `somework-cluster-dev`): `agent` (the harness, this role's image) and `sandbox` (where the model's own commands run; the
developer role's image). Nothing is deployed by this repository: these are the steps, in order.

* **Own everything.** Own SomeWork identity (`agent/cluster-dev`), own model login, own sandbox volume and token, own state volume, own Telegram bot, own ssh
  key per host.
* **The sandbox is harmless.** It holds no secret and has no way into the cluster; its only route out is the egress proxy (code host and package
  registries). Everything that touches a host, the CI or the repository's remote is a tool that runs in the harness.
* **Code decides what needs the owner.** `adapters/cluster-dev/src/classifier/` judges every `bash` and `host_exec` command; the approval question goes
  to people only (`APPROVERS` empty means `kind:human`). See `../README.md`.

Prerequisites: the domain with its TLS proxy and private CA (root `deploy/README.md`), Docker on the VM, the developer role's sandbox and egress images
(`somework-pi-sandbox:<tag>` and `somework-pi-egress:<tag>`, built from `adapters/pi/Dockerfile`).

## 1. The virtual machine
Clone the Ubuntu template into the pool, give it its own address, install Docker, and leave everything else off it. Install nothing that listens (the health
port is bound to `127.0.0.1`). Take a snapshot before the first start so that the machine can be put back.

## 2. Identity and card (on the domain host)
```bash
# on the VM: generate the key there so it never travels; only the public key is registered
mkdir -p keys && chmod 700 keys && chown 10001:10001 keys
docker run --rm -u 10001:10001 -v $PWD/keys:/keys --entrypoint somework-sidecar somework-worker:<tag> keygen --id agent/cluster-dev --key-out /keys/agent.key.json

# on the domain host (`ops` as in the root deploy README)
ops admin --config /etc/somework/somework.toml enroll-agent --id agent/cluster-dev --public-key '<publicKey>' --side-effects write
cp card.json cards/cluster-dev.json                                 # adapters/cluster-dev/card.json, copied to the host's ./cards directory
ops admin --config /etc/somework/somework.toml register-card --card /cards/cluster-dev.json --approve
```
`--side-effects write` because the card offers `code.cluster` (it opens pull requests). The agent also publishes events `agent.cluster_dev.job.*` (the topic
slug turns the dash into an underscore), which needs the permission `events.publish:agent.cluster_dev.*` (`enroll-agent --publish 'agent.cluster_dev.*'`,
later `set-agent-permissions`, or `scripts/grant-job-events.ts`).

## 3. Files on the VM (`./`, the compose directory)
| Path | What |
|---|---|
| `keys/agent.key.json` | the identity key (uid 10001, directory 0700) |
| `config/ca.pem` | the private CA |
| `secrets/sandbox-token` | random, mode 0440, group 10010: shared by agent and sandbox of THIS project |
| `secrets/pi/auth.json` | the model login (step 6), uid 10001; the directory must be writable because an OAuth refresh rewrites the file |
| `secrets/git-token` | the GitHub token (step 5), uid 10001, 0600 |
| `secrets/git/git-token-<name>` | the token of each repository in `CLUSTER_DEV_EXTRA_REPOSITORIES` (the directory must exist, uid 10001, files 0600) |
| `secrets/ssh/<host name>` | one private key per host of `CLUSTER_DEV_HOSTS`, named like the host, **0600, owner uid 10001** (ssh refuses anything else) |
| `secrets/ssh/known_hosts` | one line per host, taken from the host itself (step 4), never from the first connection |
| `secrets/ci-token`, `secrets/grafana-token`, `secrets/telegram-bot-token` | steps 5 and 7; leave the variable out of `.env` to run without it |
| `.env` | from `.env.example` |

## 4. A key per host
On the VM, one key for each host, so that a host can be taken away from the agent by removing one line there:
```bash
ssh-keygen -t ed25519 -N '' -C 'cluster-dev@agents' -f secrets/ssh/agents      # repeat for services, runner, pve-host
sudo chown 10001:10001 secrets/ssh/agents && sudo chmod 600 secrets/ssh/agents
```
* **On each host:** a user for the agent (or `js`), the public key (`secrets/ssh/<name>.pub`) in its `authorized_keys`, and sudo rules for what the
  agent needs (`docker`, `journalctl`), in `/etc/sudoers.d/cluster-dev`. Restrict the key with `from="<the agent VM's address>"`.
* **The hypervisor:** root ssh, as decided. The classifier makes **every** command there ask the owner first; list its names and addresses in
  `CLUSTER_DEV_HYPERVISOR_HOSTS`.
* **Host keys:** read each host's key fingerprint at the host (`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`), then
  `ssh-keyscan -t ed25519 <address> >> secrets/ssh/known_hosts` and compare the fingerprints before keeping the line. ssh runs with
  `StrictHostKeyChecking=yes`, so a host that is not in the file is refused.

## 5. Tokens (each its own, scoped, never the owner's login)
| Token | Where | Scope |
|---|---|---|
| GitHub | `secrets/git-token` | fine-grained, **the organisation repository only**: Contents and Pull requests write, Metadata read. Used by `git_push` and by the job path. Not the owner's login |
| Woodpecker | `secrets/ci-token`, `CI_URL`, `CI_REPO` | a token that can read the repository's pipelines and logs (Woodpecker user tokens act as the user: use a dedicated user or accept that it is read through `ci_*` only) |
| Grafana | `secrets/grafana-token`, `GRAFANA_URL` | a Viewer service account (`deploy/grafana/provision-reader.py`) |
| Pull request watches | `secrets/watch-token`, `WATCH_URL` | `somework-hub watch-token agent/cluster-dev` on the hub; add this VM to `TLS_CLIENTS` of the hub's firewall; rule `rules/cluster-dev-watch.yaml` |
| Proxmox | not used by this code | the decision lists a Proxmox API token for the pool; no tool uses it yet (host_exec to the hypervisor uses ssh and asks the owner every time) |

## 6. The model login
**This role's own.** Do the device-code login for this agent separately and never copy another agent's `auth.json`: an OAuth refresh token is rewritten on
use, so two services holding the same one invalidate each other.
```bash
mkdir login && cd login                                   # a scratch directory: the login writes ./auth.json
node <repo>/node_modules/@earendil-works/pi-ai/dist/cli.js login openai-codex   # choose the device-code option, approve the code in a browser
sudo install -d -o 10001 -g 10001 -m 0700 ../secrets/pi
sudo install -o 10001 -g 10001 -m 0600 auth.json ../secrets/pi/auth.json
cd .. && rm -r login
```

## 7. The Telegram bot
Create a bot with BotFather for this agent alone; put its token in `secrets/telegram-bot-token` (uid 10001, 0600) and set `TELEGRAM_ALLOWED_USER_IDS` to the
owner's numeric Telegram id (`packages/agent-kit/README.md`, "Telegram"). The bot is how the owner gives work and how the agent's approval questions
arrive (`/approve <id>` and `/deny <id>`); an unanswered question is a denial after `CHAT_APPROVAL_MINUTES`.

## 8. Outbound firewall
The VM may reach only the destinations of `firewall-allow.example.txt` (copy it, fill in the names and addresses). With ufw:
```bash
sudo ufw default deny outgoing && sudo ufw default deny incoming
sudo ufw allow out 53 && sudo ufw allow out 443/tcp && sudo ufw allow out 22/tcp    # then narrow them to the listed destinations
sudo ufw allow out to <agents VM> port 8081:8085 proto tcp
sudo ufw enable
```
Docker publishes ports around ufw: keep the health port on `127.0.0.1` (`HEALTH_BIND`) and put the policy for `outside` in the `DOCKER-USER` chain as in
`deploy/agents/agent-health-firewall.sh`.

## 9. Build and start
```bash
# from the repository root (the build context)
docker build -f adapters/cluster-dev/Dockerfile --target agent -t somework-cluster-dev:<tag> .
docker build -f adapters/pi/Dockerfile --target sandbox -t somework-pi-sandbox:<tag> .
docker build -f adapters/pi/Dockerfile --target egress -t somework-pi-egress:<tag> .

cd adapters/cluster-dev/deploy            # or wherever compose.yaml and .env live on the VM
docker compose --profile init run --rm -T init-volumes </dev/null
docker compose up -d
docker compose ps && docker compose logs agent --tail 20      # expect service_started {"role":"cluster-dev", ...}
curl -s http://127.0.0.1:8081/ready
```
The service refuses to start when `PI_CONCURRENCY` is not 1, when a host in `CLUSTER_DEV_HOSTS` has no key file or `known_hosts` is missing, when
`CLUSTER_DEV_GIT_REMOTE` is `origin`, or when `CI_URL` is set without a token file.

## 9b. Register the agent with Operations
Without this the agent runs on its own defaults (`DAILY_TOKEN_LIMIT`, `BUDGET_MAX_TOKENS_CAP`) and never receives the fleet limits, the global prompt, the model or any setup the owner saves in Operations (the cause of "budget exhausted" at 8M tokens a day while the fleet limit was far higher).
1. Publish the health port on the VM's address and let only Operations reach it: `HEALTH_BIND=<the VM address>` in `.env`, then on the VM install `deploy/agents/agent-health-firewall.sh` as `/usr/local/sbin/agent-health-firewall` with a systemd unit like the agents VM's (`HEALTH_IP=<the VM address> HEALTH_PORTS=8081 CLIENTS=<the Operations host>` in `/etc/default/agent-health-firewall`). From then on `curl` the health port by that address, not `127.0.0.1`.
2. On the Operations host add `{"id": "agent/cluster-dev", "url": "http://<the VM address>:8081/status"}` to `agents-health.json` in its secrets directory and restart Operations.
3. In Operations, Fleet limits, the agent shows the revision it applied; `/profile` of the agent shows `maxTokensCap` and `dailyTokenLimit` from it.

## 10. Smoke test
Without credentials first: `PI_PROVIDER=faux` with a plan such as `call:deploy_status:{}` then `final:ok`, and a message to the agent. Then with the real
model, in order of risk:
1. Ask for the state of the cluster: expect `deploy_status` for every agent and a `logs_query`; no approval question.
2. Ask it to run `docker ps` on one host: it runs at once. Ask for `docker system prune -af` on it: **the owner gets a Telegram message with the exact command**;
   deny it and check that nothing ran (`docker ps` shows the same containers).
3. Ask for something small in the repository: expect a copy of the checkout, the tests, a commit and `git_push`; check the pipeline with `ci_pipelines`.
4. Ask it to push to `origin`: it must refuse without asking anybody.

## 11. Roll back
```bash
docker compose down                          # stops the agent; the domain keeps it enrolled but idle
ops admin --config /etc/somework/somework.toml set-agent-status --id agent/cluster-dev --status disabled   # the kill switch for the identity
```
Take a host away from the agent by removing its line from `CLUSTER_DEV_HOSTS` and the key from the host's `authorized_keys`; take the repository away by
revoking `secrets/git-token`. To remove the agent for good, delete the `state` and `workspace` volumes, `keys/` and `secrets/`.

## Limits
* The approval gate asks; it does not sandbox. The classifier reads a command the way a shell does and errs towards asking, but it cannot see inside a
  script file it is told to run on a host (only the repository's deploy scripts run there without a question) and it does not resolve a path that is
  computed when the command runs (such a command counts as destructive).
* The sandbox image has no Rust toolchain: `node --test` and `npm test` run there, `cargo test` does not until the sandbox image has one.
* No Operations tool yet: the Manager's Operations calls are not reachable from this agent.

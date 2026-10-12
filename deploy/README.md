# Pilot deployment: domain + NATS on VM105

A trusted, single-node pilot. It is **not** a hardened multi-tenant platform: read "What this does not protect against".

```
VM105 (private services)
┌──────────────────────────────────────────┐
│ proxy (Caddy, TLS) :8443 ─► domain :8080 │ ◄── HTTPS ─── agents and the kit (outbound only)
│ nats + JetStream   :4222 (TLS only)      │ ◄── NATS/TLS ─ per-agent inbox consumers
│ SQLite + objects (volume), JetStream vol │
└──────────────────────────────────────────┘
```

Agents only make outbound connections. SQLite and the domain are the authority for messages, conversations, events and
permissions; NATS only wakes agents through their inbox consumers. If NATS is lost, agents sweep their inbox over HTTP.
Agent processes (the TypeScript kit and its adapters) are deployed separately and are not part of this stack.

## What was verified

The 2026-10-05 run on the pilot hosts covered the previous task/worker architecture. After the cut-over to messages and
events (ADR 0003) the automated tests in `crates/somework-it` cover TLS to NATS and HTTPS (`sidecar_tls`, `nats_tls_config`),
per-principal broker permissions (`nats_security`), JetStream loss and broker outages (`nats_resilience`, `nats_crash`),
backup and restore (`dr_restore`) and both compose files; the pilot hosts have not been re-verified since.

## 1. Build the images (any machine with Docker)

```bash
docker build -f deploy/Dockerfile --target server -t somework-server:pilot-1 .
```

Base images are pinned by digest in `deploy/Dockerfile` and the compose files. Update them deliberately.

## 2. Certificates (once, on a trusted machine)

```bash
deploy/scripts/make-private-ca.sh ./pki \
  domain=somework.internal,10.0.0.5 \
  nats=nats,nats.internal,10.0.0.5
```

* `domain` is the proxy certificate; its names must include the host in `public_url` and in the agents' `SOMEWORK_DOMAIN_URL`.
* `nats` must include `nats` (the domain reaches the broker by compose service name) and the name or IP the agents use
  (`[nats] client_url`).
* Copy `ca.pem` to the server and to every agent host. Copy each server's `.pem`/`.key` only to that server, into
  `deploy/vm105/certs/` (`nats.*`, `domain.*`, `ca.pem`), and `chown 10001:10001` the `.key` files. Keep `ca.key` offline.

## 3. VM105: domain, broker, proxy

```bash
cd deploy/vm105
cp somework.toml.example config/somework.toml && chmod 600 config/somework.toml   # fill in CHANGE_ME
export PRIVATE_IP=10.0.0.5 SOMEWORK_VERSION=pilot-1

docker compose --profile init run --rm init-volumes
ops() { docker compose --profile tools run --rm ops "$@"; }   # one-off administration, no shared PID namespace
ops admin --config /etc/somework/somework.toml render-nats-conf \
  --out-dir /etc/nats --tls-cert /certs/nats.pem --tls-key /certs/nats.key       # 5GB file / 256MB memory by default
docker compose up -d nats
ops admin --config /etc/somework/somework.toml bootstrap --key-out /data/root.key.json
docker compose up -d domain proxy
```

* `render-nats-conf` bounds JetStream storage (`--max-file-store`, `--max-memory-store`) and enables TLS. Retention by age
  is in the `[nats]` section of `somework.toml`.
* The bootstrap key is the administrator credential. Move it off the host and delete it from the volume once stored.
* `master_key` is base64url of 32 random bytes (`openssl rand -base64 32 | tr '+/' '-_' | tr -d '='`). Back it up
  separately: the broker credentials of every agent derive from it, and `somework restore` needs it
  (`SOMEWORK_MASTER_KEY=…`) because backups do not contain it by default.
* Enrolling an agent rewrites `users.conf`; a watcher that runs inside the `nats` container (next to the broker, so it always restarts with it)
  notices the change and signals the broker. An earlier design used a second container in the broker's PID namespace; it did not come back
  after a broker restart, and new agents could not log in until someone sent the broker a SIGHUP.
* Do not enable `[ui] dev_token_login`. Leave `[ui]` out unless an OIDC login is configured.

## 4. Agents

Generate each agent's identity on its own host so the private key never travels (`somework-sidecar keygen --id agent/x --key-out …`
prints only the public key). On VM105 register that public key and publish the agent's capability card (an advertisement
only; it grants nothing):

```bash
ops admin --config /etc/somework/somework.toml enroll-agent --id agent/pilot-reviewer --public-key '<publicKey>'
ops admin --config /etc/somework/somework.toml register-card --card /cards/pilot-reviewer.json --approve   # card JSON in ./cards
```

Add `--publish 'github.*'` to `enroll-agent` to let an agent publish events under those topics.

## Inbox wake-ups

Agents receive a wake-up on their inbox subject (`somework.inbox.<agent>`) when a message or event addresses them, and read the
canonical messages over HTTP (`GET /v1/inbox?unread=true`). A lost, delayed or purged notification can only add latency:
the kit sweeps its unread inbox periodically and rebuilds the NATS connection with jittered backoff.

* After losing the JetStream volume nothing needs to be re-enqueued; the next sweep finds every unread message in SQLite.

## Key rotation and the kill switch

An agent has exactly one registered public key. Rotation is a planned window, not zero-downtime:

1. Stop the agent.
2. On the agent host, generate a new key file next to the old one (`keygen --key-out /keys/worker-2.key.json`).
3. On VM105: `admin rotate-agent-key --id agent/pilot-reviewer --public-key '<new publicKey>'`. The old key stops
   authenticating immediately.
4. Point the agent at the new key file and start it. Delete the old key file.

Lost or leaked key: `admin set-agent-status --id agent/pilot-reviewer --status disabled` blocks authentication at once;
`--status active` re-enables.

## Backup and restore

`somework backup --config … --to DIR` writes a consistent online backup of the database, artifacts and key material
(`somework restore` verifies it). Back up the SQLite volume and the objects together, and the JetStream volume only as an
optimisation: nothing in JetStream is authoritative. Test a restore before relying on it.

## What this does not protect against

* **Full trust inside the domain.** Every enrolled principal is trusted to message, subscribe and read artifacts within its
  classification clearance; capabilities advertise what an agent offers and do not gate anything.
* **Shared kernel.** Agents on the same Docker host share its kernel. Do not mount other agents' auth, sessions or
  workspaces, any Mac key, or the Docker socket into an agent container.
* **Single node, no HA.** One domain, one broker. Plan for downtime when either restarts.
* **No log redaction layer.** Keep credentials and message bodies out of operational logs; ship logs to the private Grafana
  only after checking what agents print to stderr.

## Drain: a deploy does not wait for a gap in a busy agent

A deployment restarts the agent, which ends the jobs it runs. Until now it waited for a moment with no running job, and a busy agent
never had one. Now it first puts the agent in drain mode: a file `drain` in the agent's state directory. The agent then starts no new
job (jobs and events that would start work are refused or dropped with the reason `draining`), keeps answering chat, keeps saying it is
ready, and lets the jobs it runs finish; `/status` shows `draining: true` and the metric `somework_draining` is 1. The deployment waits
until `somework_jobs{state="running"}` is 0, replaces the agent, and removes the file. Details of the agent's side are in
`packages/agent-kit/README.md` ("Drain").

* **Windows machines** (`deploy/windows/deploy-from-ci.ps1`): the file is `<PI_STATE_DIR of agent.env>\drain`. The script drains, waits up to
  25 minutes for the running jobs (it stops with exit status 1 and a message when they are still there, and leaves nothing drained),
  stops the agent, removes the file, installs and starts the new code. The file is also removed by `Fail`, by the `trap` and on success, so
  no way out of the script leaves the agent drained. Without `PI_STATE_DIR` in `agent.env` it only waits, as before.
* **Linux stacks** (`deploy/agents/roll-agent.sh`): the state is the named volume `state` of the stack, mounted at `/state` in the compose
  service `agent`. `DRAIN_SERVICE=agent` (set by `deploy-from-ci.sh` for the five agent stacks, not for the event hub, which is no agent) makes
  the script run `docker compose exec -T agent touch /state/drain` (`DRAIN_STATE_DIR` changes the path), wait for the running jobs
  (`IDLE_SECONDS`, 600 by default, then it rolls anyway as before: the agent takes unfinished jobs up again), run `docker compose up -d`
  and remove the file with `docker compose exec -T agent rm -f /state/drain` as soon as the new container runs. The volume survives the
  recreate, so the new agent starts drained for those seconds. The removal is tried again, falls back to a throw-away `docker compose run`
  and is done by an `EXIT` trap (also on `INT` and `TERM`); when even that fails the script says so, with the file to remove by hand. If
  the agent container does not run, the script says it could not drain and only waits.
* **A file nobody removed.** An agent ignores a drain file that was not touched for three hours, so a deployment killed in the middle (an
  SSH session that dropped, a power cut) does not leave an agent drained for ever. To drain by hand: `touch` the file; to end it: remove it.
* There is no HTTP switch: the health ports have no authentication.
* The first deployment after this change drains agents whose old image does not know about the file; they simply behave as before
  (the wait for the running jobs). The agents and the scripts on the hosts are independent: install the new `deploy-from-ci.sh`,
  `roll-agent.sh` (agents VM, `~/somework-pilot/bin`) and `deploy-from-ci.ps1` (`C:\somework\bin`) by hand, as the key that runs them is not
  allowed to replace them.

## Smoke test

`scripts/smoke-cluster.sh INVENTORY [--version TAG | --sha COMMIT] [--wait SECONDS]` checks a deployed cluster and lists every check that
failed (exit status 1; 2 for a bad call or inventory). The addresses are not in the repository: the inventory is a file, one line per
thing to check, `#` starts a comment:

```
agent      pi-agent     http://10.10.10.11:8081
agent      reviewer     http://10.10.10.11:8082
agent      qa           http://10.10.10.44:8082  version=skip
manager    manager      http://10.10.10.11:7080
hub        events-hub   http://10.10.10.11:8090/healthz
operations operations   https://operations.internal:9444  token_file=/run/secrets/ops-smoke-token  ca_file=/run/secrets/ca.pem
```

* `agent`: `GET URL/ready` answers 200 with `"ready": true`, and `GET URL/profile` reports the version that was asked for with `--version`
  (the image tag, `ci-` and seven characters of the commit; `--sha` takes the full commit and derives it the way `deploy-from-ci.sh` tags the
  images). Without `--version` or `--sha` the version is shown and not compared. The Windows agents have no `AGENT_VERSION` and report
  `unknown`: give them `version=skip`.
* `manager`: `GET URL/status` answers 200 with a JSON object (the Manager's health port, 7080 by default).
* `hub`: the URL answers 200 (the event hub's `/healthz`).
* `operations`: `GET URL/fleet/api/ops/me` with the service token in the file answers 200 and describes the caller. The token goes to curl in
  a header file that only the script's user can read, never on a command line. `ca_file` is the CA that signed Operations' certificate.
  Use the token of a viewer; nothing here writes.
* A failing check is tried again for `--wait` seconds (default 30) before it counts, so a service that is still starting does not fail the run.
  Each failure is printed where it happens and again in a list at the end, with the address and why.

Where it runs:

* **On the agents VM, after every deployment**, when `~/somework-pilot/smoke.inventory` exists: `deploy-from-ci.sh` runs the script from the
  repository it just unpacked, with `--version ci-<short sha>`, after the last stack was rolled. A failure makes the deployment exit with
  status 5 and the line "deployed ci-..., but the smoke test failed"; nothing is rolled back. Without the file it says so and goes on.
  The VM can reach its own health ports, so this is the inventory with the agents, the hub and the Manager (and Operations when its token is on
  that host).
* **By hand from Woodpecker**: `.woodpecker/smoke.yaml` (manual events only) writes the secret `smoke_inventory` to a file and `smoke_ops_token` to
  `/tmp/ops.token` (so the inventory's `token_file=/tmp/ops.token`); `SMOKE_VERSION`, a variable of the manual run, is passed as `--version`. The
  runner has to be allowed to reach the addresses: the agents' health ports are open to the dashboard host and the agents VM only
  (`agent-health-firewall.sh`), so as it stands this works for the addresses the runner can reach (Operations, the Windows machines if they are
  bound to a reachable address) and not for the agents' ports; nothing in the repository changes that.
* **From a laptop**: `scripts/smoke-cluster.sh ~/smoke.inventory --sha $(git rev-parse origin/main)` when the addresses are reachable.

## What changed in how images are built and deployed

| What | Before | Now |
| --- | --- | --- |
| Operations image (`dashboard/Dockerfile`) | one `cargo build` recompiled every dependency whenever a source file changed (about 45 minutes on 2 CPUs) | the dependencies are a Docker layer built from the manifests and `Cargo.lock`; a source change compiles only the four workspace crates |
| Operations image, UI bundle | `dx bundle` and the copy were manual steps in the README | `scripts/build-ops-image.sh TAG [--ship HOST]` builds the bundle when it is missing or stale, builds `agent-cluster-fleet:TAG` and can send it with `docker save \| gzip \| ssh HOST docker load` |
| Deploying to a busy agent | waited for a gap that a busy agent never had, then rolled anyway or failed | the agent drains (no new jobs), the running jobs finish, then it is replaced; the drain is removed on every way out |
| After a deployment | only each agent's `/ready` | `scripts/smoke-cluster.sh`: `/ready`, version on `/profile`, Manager, hub and Operations; every failure listed |

Commands:

```bash
# build and ship the Operations image (from the repository root; builds the UI bundle first when it is stale)
scripts/build-ops-image.sh 0.2.1-operations --ship js@services-vm

# drain by hand, e.g. before maintenance on a Linux stack, and end it
docker compose exec -T agent touch /state/drain
docker compose exec -T agent rm -f /state/drain
#   Windows: New-Item -ItemType File C:\somework\state\drain ; Remove-Item C:\somework\state\drain
curl -s http://10.10.10.11:8082/status | grep -o '"draining":[a-z]*'

# smoke test after a deployment
scripts/smoke-cluster.sh ~/smoke.inventory --sha "$(git rev-parse HEAD)"

# tests of the scripts
node --test scripts/*.test.ts
```

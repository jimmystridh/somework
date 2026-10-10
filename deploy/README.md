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

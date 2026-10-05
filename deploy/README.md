# Pilot deployment: domain + NATS on VM105, one worker on VM102

A trusted, single-node pilot. It is **not** a hardened multi-tenant platform: read "What this does not protect against".

```
VM105 (private services)                                    VM102 (agent Docker host)
┌──────────────────────────────────────────┐               ┌──────────────────────────┐
│ proxy (Caddy, TLS) :8443 ─► domain :8080 │ ◄── HTTPS ─── │ worker container         │
│ nats + JetStream   :4222 (TLS only)      │ ◄── NATS/TLS ─│  sidecar → executor      │
│ SQLite + objects (volume), JetStream vol │               │  own key, own workspace  │
└──────────────────────────────────────────┘               └──────────────────────────┘
```

The worker only makes outbound connections. SQLite and the domain stay the authority for tasks, leases, fencing and
permissions; NATS only wakes the worker. If NATS is lost, the worker keeps claiming work over HTTP (see "Wake transport").

## What was verified, and what was not

Automated tests (developer machine):

* composite NATS + HTTP wake, outage, lost notification, deleted consumer, exactly-once execution (`nats_wake_resilience`);
* TLS to NATS and to an HTTPS endpoint: wrong CA, wrong hostname, platform-only trust and plaintext are rejected
  (`sidecar_tls`, `nats_tls_pilot`); the domain and a worker exchange wake-ups over a TLS-only broker;
* `render-nats-conf` output is accepted by the real `nats-server` and enforces TLS and bounded storage;
* certificates from `make-private-ca.sh` are accepted by the sidecar;
* SIGTERM, executor environment and the key lifecycle (`sidecar_deploy`); per-principal broker permissions (`nats_security`),
  lease/fencing, restore (`dr_restore`); both compose files pass `docker compose config`.

Run on the real pilot hosts on 2026-10-05 (images built on VM102, domain stack on VM105, worker on VM102):

| Check | Result |
|---|---|
| Image builds (`server`, `worker-demo`) on VM102 | built first time, about 5 minutes on 2 CPUs |
| TLS through Caddy from VM102 | pilot CA trusted; platform trust, plain HTTP to the TLS port and the internal :8080 are refused/unreachable |
| Worker over TLS NATS with `wake = "nats"`, `tls.required` | connected first attempt; end-to-end task in 0.4 s |
| Broker down: domain stays up, task still completes | 8.3 s over HTTP instead of 0.4 s; domain unaffected |
| Broker back | next task 0.4 s again, no manual action |
| `users.conf` change reloads the broker (`nats-reloader`) | broker logs `Reloaded: authorization users` |
| `docker stop` on the worker | exit code 0 in 0.7 s, runtime ended |
| Key rotation | old key: `401 signature verification failed`, backoff; new key works |
| Hardening as running | non-root, read-only rootfs, caps dropped (proxy: `NET_BIND_SERVICE` only), no `docker.sock` in any container |
| Backup and restore | restore verifies checksums and needs `SOMEWORK_MASTER_KEY` |

Bugs found only by running it on the hosts (all fixed here): `pid: service:nats` made NATS a hard dependency of the domain
(the namespace's init exiting killed the domain, exit 137); `master_key` must be base64url of 32 bytes, not hex; the caddy
image cannot exec with every capability dropped; `docker compose run domain` could not start before the broker existed.

Not verified: behaviour under memory pressure beyond the limits above, the Grafana log shipping, an executor other than the
example reviewer, and the quiet-machine load profile.

## 1. Build the images (any machine with Docker)

```bash
docker build -f deploy/Dockerfile --target server -t somework-server:pilot-1 .
docker build -f deploy/Dockerfile --target worker -t somework-worker:pilot-1 .
```

Base images are pinned by digest in `deploy/Dockerfile` and the compose files. Update them deliberately.
The worker image contains only the sidecar. Add your executor by deriving from it or by mounting a read-only directory,
then name it in `worker.toml`. `--target worker-demo` adds Python and the example reviewer agent for smoke tests only.

## 2. Certificates (once, on a trusted machine)

```bash
deploy/scripts/make-private-ca.sh ./pki \
  domain=somework.internal,10.0.0.5 \
  nats=nats,nats.internal,10.0.0.5
```

* `domain` is the proxy certificate; its names must include the host in `public_url` and in the workers' `SOMEWORK_DOMAIN_URL`.
* `nats` must include `nats` (the domain reaches the broker by compose service name) and the name or IP the workers use
  (`[nats] client_url`).
* Copy `ca.pem` to both hosts and to every worker. Copy each server's `.pem`/`.key` only to that server, into
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
* Enrolling an agent rewrites `users.conf`; the `nats-reloader` service notices the change and signals the broker (it shares
  the broker's PID namespace, never the domain's: a shared namespace dies with its init process, so sharing it with the
  domain took the domain down whenever the broker stopped).
* Do not enable `[ui] dev_token_login`. Leave `[ui]` out unless an OIDC login is configured.

## 4. VM102: the worker

On VM102, generate the identity **on the worker host** so the private key never travels:

```bash
sudo install -d -o 10001 -g 10001 -m 0700 /srv/somework-worker/keys
docker run --rm -u 10001:10001 -v /srv/somework-worker/keys:/keys --entrypoint somework-sidecar \
  somework-worker:pilot-1 keygen --id agent/pilot-reviewer --key-out /keys/worker.key.json
```

It prints the public key (and nothing secret). On VM105, register only that public key, with the least privilege the
worker needs, and publish its capability card:

```bash
ops admin --config /etc/somework/somework.toml enroll-agent \
  --id agent/pilot-reviewer --public-key '<publicKey>' --side-effects read
ops admin --config /etc/somework/somework.toml register-card --card /cards/pilot-reviewer.json --approve   # card JSON in ./cards
```

Then on VM102:

```bash
cd deploy/vm102
cp worker.toml.example config/worker.toml      # set the executor command
cp /path/to/ca.pem config/ca.pem
cp .env.example .env                           # SOMEWORK_VERSION, SOMEWORK_DOMAIN_URL, WORKER_KEY_DIR
docker compose up -d
```

Check the worker's last-seen time with `GET /v1/runtimes` (administrator credential), or in the **Runtimes** view if you
enabled the UI. The worker image has no health probe; alert on a stale last-seen instead.

## Wake transport

`wake = "nats"` (the pilot setting): low-latency wake-ups over NATS, plus every 25 s (±20 %) an HTTP lookup of queued
tasks. A lost, delayed or purged notification can only add latency. If the broker fails, the worker continues over HTTP
(from "now") and rebuilds the NATS connection with jittered exponential backoff (1 s up to 30 s).

* Messages and task events are not reconciled over HTTP while NATS is the transport; they rely on JetStream redelivery.
  Anything that arrives during an outage is delivered when the broker is back.
* Roll back to HTTP-only at any time: set `wake = "poll"` in `worker.toml` and restart the worker.
* After losing the JetStream volume: restore it, or run `somework admin republish-queued` to re-enqueue notifications for
  every queued task. The worker's HTTP lookup recovers queued tasks in the meantime.

## Key rotation and the kill switch

An agent has exactly one registered public key. Rotation is a planned window, not zero-downtime:

1. Stop the worker (`docker compose stop worker`; it exits after in-flight work, up to 10 s).
2. On VM102, generate a new key file next to the old one (`keygen --key-out /keys/worker-2.key.json`).
3. On VM105: `admin rotate-agent-key --id agent/pilot-reviewer --public-key '<new publicKey>'`. The old key stops
   authenticating immediately.
4. Point `SOMEWORK_KEY_FILE` at the new file and start the worker. Delete the old key file.

Lost or leaked key: `admin set-agent-status --id agent/pilot-reviewer --status disabled` blocks authentication at once;
`--status active` re-enables.

## Backup and restore

`somework backup --config … --to DIR` writes a consistent online backup of the database, artifacts and key material
(`somework restore` verifies it). Back up the SQLite volume and the objects together, and the JetStream volume only as an
optimisation: JetStream can be rebuilt from SQLite (see above). Test a restore before relying on it.

## What this does not protect against

* **The executor can read the worker's key.** It runs as the sidecar's user on the sidecar's filesystem. The sidecar
  strips its environment (only `PATH`, `LANG`, `LC_ALL`, `LC_CTYPE`, `TZ`, `TMPDIR` and what you list in `env_allow`
  reach it), which does not stop file access or `/proc`. Run only trusted, allowlisted, read-only or idempotent executors,
  concurrency 1. Untrusted or arbitrary task execution needs stronger isolation first (a separate container or user per
  executor, with the key unreachable).
* **Shared kernel.** The worker shares VM102's kernel with other agents (Pi). Do not mount Pi's auth, sessions or
  workspace, any Mac key, or the Docker socket into it. The container is non-root, unprivileged, read-only, drops all
  capabilities and is resource-limited.
* **No exactly-once effects.** Fencing stops a stale worker from changing the domain's state; it does not undo or dedupe
  effects the executor already caused elsewhere.
* **Single node, no HA.** One domain, one broker. Plan for downtime when either restarts.
* **No log redaction layer.** Keep credentials and task bodies out of operational logs; ship logs to the private Grafana
  only after checking what the executor prints to stderr.

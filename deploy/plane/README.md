# Plane v1.4.2 — implemented remediation, NOT deployed

## Current continuation — 2026-10-14, still blocked

- Resumed from `a98e272`. Actual Services pulls exposed five application
  digests assigned to the wrong repositories. Fixed in `3177740`;
  `images.json` records the registry identities. All six distinct Plane images
  now successfully pulled by digest on Services. These are image availability
  checks, not application readiness or vulnerability scans. Twelve local Plane
  tests (including the new identity regression) and role boundaries pass.
- Woodpecker **#111, #112 and #113** have a confirmed pre-step error:
  `secret "github_token" not found`. Evidence: read-only query of only
  `number,status,errors` in the Services Woodpecker database. No secret columns
  were read. Repair credential provisioning through the supported secret process;
  do not remove checks to manufacture green CI. #113 is for `3177740`.
- Current PR review cannot be verified: unauthenticated GitHub API returns 404;
  Agents' installed `gh` has no authenticated session. Services' noninteractive
  `git ls-remote` for the private org repository fails authentication. No host
  checkout exists. Owner/reviewer must supply review evidence and a supported
  means of staging the reviewed exact commit; no new general-purpose credential
  was invented or extracted from running services. **Reviewer agent** can help
  review PR #9, especially image identities, storage and ingress trust.
- Created only an empty private `/srv/plane` on Services (0700, js:js).
  `plane.env` and `minio.license` remain absent. No AIStor license is assumed.
- Submitted a fresh host approval request for a NEW dedicated ingress key.
  Agents now has `/etc/plane-gateway` (0700, js:js),
  `plane_ed25519` (0600) and its public file (0644). No values were printed.
  Preserve and reuse this key; do NOT run generation again or overwrite it.
  No account/key enrollment, known-host pin, forwarding/gateway unit or Serve
  route is installed. Owner login `jimmystridh@github` remains unconfirmed.
- Backend image source inspection in two read-only, network-disabled, bounded
  diagnostic containers confirmed Plane uses boto3 presigned POST and GET,
  HeadObject, CopyObject and upload_fileobj. Startup calls create_bucket;
  update_bucket contains bucket-policy operations but is not called by the
  inspected API/migrator entrypoints. These diagnostics exited successfully,
  have no declared image volumes, and are retained as
  `plane-source-check-3177740` / `plane-storage-source-3177740`.
- Existing Services stacks remained running; four have healthy checks and Caddy
  has no check. Later sample: 5,012 MiB available, 47 GiB disk free after pulls.
  Agents stacks stayed running and Serve reported no config. No audio work,
  existing route, container, data volume or firewall was modified or deleted.
  Deployment script has NOT run: review, staging, storage and ingress gates are
  not met. No migrations, live S3 transfers or private reachability are verified.

### License-free storage investigation (NOT a deployed replacement)

Garage's authoritative forge lists **v2.4.1**, published 2026-09-08, with active
maintenance and a security reporting policy. Its source LICENSE is AGPL-3.0;
no proprietary activation license is required. Services' manifest inspection of
`dxflrs/garage:v2.4.1` reports linux/amd64 manifest
`sha256:0d7c74fc8ca6fef68a5a941c0e7558c8b1e92ba3588fa7505400e1350456c796`.
This is a candidate identity, not a pulled/runtime-tested or security-approved
storage implementation. No replacement was enabled and no license terms were
accepted on the owner's behalf.

Authoritative evidence:
- https://git.deuxfleurs.fr/Deuxfleurs/garage/releases/tag/v2.4.1
- https://git.deuxfleurs.fr/Deuxfleurs/garage/raw/tag/v2.4.1/SECURITY.md
- https://git.deuxfleurs.fr/Deuxfleurs/garage/raw/tag/v2.4.1/LICENSE
- https://garagehq.deuxfleurs.fr/documentation/reference-manual/s3-compatibility/

Garage documents SigV4, path-style, presigned URLs, POST uploads, multipart,
copy/head/delete and CORS, but **not S3 ACL/bucket-policy APIs or versioning**.
It has its own per-key/per-bucket permissions. A reviewed candidate must retain
private buckets, explicitly set a matching S3 region, provision restricted keys
without printing them, protect its RPC/admin listeners, preserve Plane volume
ownership and validate the exact proxy Host/signature behavior. The existing
PUT/GET storage fixture alone is insufficient: add actual boto3 presigned POST,
GET with content-disposition, unsigned/wrong-key denial and restart persistence,
then test the actual Plane path. No blanket security/compatibility claim is made.
If no legitimate AIStor license is supplied, the next storage step is this
reviewed/tested replacement, NOT the rejected old CE build.

## Historical checkpoint at a98e272

The remainder records the earlier job; statements about absent keys/paths below
refer to that historical checkpoint, not the continuation above.

Continuation of `cluster/job-e5ad5522b337` (`12612aa`, PR #9), job
`cluster/job-b18abe24b1f1`, 2026-10-14. Historical checkpoints remain in Git;
the obsolete 1.8 GiB / proposed 12 GiB blocker is **not** a launch requirement.

## What changed and what was verified

- Replaced the inaccessible MinIO CE image with **vendor-supported AIStor**,
  `RELEASE.2026-09-19T17-05-25Z`, pinned to its linux/amd64 manifest digest.
  Services successfully pulled that exact digest. Isolated, network-disabled
  `minio --version` and `server --help` checks verify its version, platform and
  license flag. The image has `curl` for the ready probe. See
  `storage/provenance.json`; image-label revision and binary commit differ and
  are both recorded, not falsely described as reproducible source provenance.
- The initial reproducible CE build candidate was **rejected for security**.
  The October 2025 tag resolves to upstream `9e49d5e…`, its archive hash matches
  independently on sandbox and Services, and the session-policy fix is an
  ancestor. But upstream is now archived/unmaintained and newer advisories
  affect CE, including unauthenticated object writes. Fixing GHSA-jjjj alone
  is NOT evidence that CE is secure. `storage/security-evidence.json` records
  authoritative advisory IDs and vendor fix targets. No fork or old binary used.
- Implemented an owner-only HTTP/WebSocket gateway and restricted SSH loopback
  forwarding units for Agents. Tests verify HTTP streaming, identity rejection,
  duplicate-header rejection and bidirectional WebSocket relay. These are tested
  code, **not installed ingress**.
- Added exclusive host-local CSPRNG secret generation, staged deployment with
  prerequisite-health/migration gates, a local deployment lock, and an isolated
  S3 write/read/auth/restart test fixture. No production secret was generated.
- Actual Compose merge, required-setting failures, volumes, pins, memory limits,
  deployment preconditions, generator privacy and gateway tests pass.
  Licensed object-server startup/S3 behavior, migrations and Plane are **not yet
  runtime verified**. Do not describe config/unit tests as a working deployment.

### Immediate next actions (not an imaginary coordinator gate)

1. Owner/repository reviewer reviews the updated PR #9, including the storage
   license choice, ingress trust boundary, component limits and deployment script.
   The private GitHub PR API returns 404 to this sandbox; Services' unauthenticated
   Git access fails. No review approval/merge or deployable host checkout is
   established. Provide supported access to the **reviewed exact commit**, not
   new unreviewed general-purpose deployment credentials.
2. The owner obtains an **AIStor Free Tier license** from
   [vendor pricing](https://min.io/pricing), accepts the MinIO Software License,
   and installs it host-locally at `/srv/plane/minio.license` via the approved
   secret-file process (never chat/Git/config output). The vendor's
   [container installation guide](https://docs.min.io/enterprise/aistor-object-store/installation/container/install/)
   states the free license permits a single compute instance and provides no
   paid support. Do not silently accept terms or invent a license. It is
   proprietary vendor software, not AGPL CE. Review current advisories and image
   scans again before launch; no blanket vulnerability-free claim is made.
3. Through `host_exec` approvals, install the restricted gateway key/account,
   verified host-key pin, units and Serve route; generate Plane's new secrets.
   No enrollment, rename, Funnel or service private/public port binding is needed.
4. Run the licensed isolated storage test and restart check, then the reviewed
   repository deployment and the live verification checklist below.

## Approval checkpoint and host impact

The tool refused the initial long CE build-file transfer because it exceeded
its 600-character destructive-command approval limit, explicitly asking for
smaller commands. The first two readable-sized writes ran, creating only
`/home/js/plane-build-job-b18abe24b1f1/Dockerfile` (partial builder/source-download
instructions). The third append timed out: **nobody answered within 30 minutes**.
That step stopped; it was not retried, encoded, rerouted or executed elsewhere.
CE was subsequently disqualified by the expanded advisory review. Do NOT resume
that partial build. Its removal requires a separate owner-approved cleanup.

AIStor verification created three job-named, network-disabled, exited diagnostic
containers (`plane-aistor-{version,tools,help}-job-b18abe24b1f1`, including the
initial tools check whose absent `grep` caused exit 127). The digest is locally
cached. No Plane server, production volumes, secrets, Serve route or firewall
change was created. The vendor image declares `/data`: those three diagnostic containers each
created an anonymous `/data` volume (not Plane objects). Inspection ties the
three volumes to these job-owned containers. Preserve them until owner-approved
cleanup. Both deployment/test overlays mount unused `/data` as bounded tmpfs
to prevent anonymous-volume accumulation on future recreations.
Diagnostic-container/image/volume cleanup is not automatic.
Existing SomeWork, NATS, fleet, Woodpecker and Caddy remain running; four are
healthy and Caddy has no reported healthcheck. No stacks/checkouts/volumes were
stopped, deleted or pruned; no hypervisor or budget changes were made.

## Capacity, ownership and locks

Services readback: 2 CPUs, **5,920 MiB RAM**, 5,072 MiB available in the later
sample, no swap, ~51 GiB free before image pull. Existing containers consumed
~323 MiB at the earlier sample; their configured limits total 1,548 MiB.
Upstream v1.4.2 recommends 2 vCPU/4 GB for Plane alone. This host can reasonably
attempt a measured small-workload rollout; it cannot guarantee every service's
maximum simultaneously. No audio reservation is assumed free or invented.

Initial Plane caps (MiB): web/space/admin/live 256 each, API/worker 768 each,
beat 256, PostgreSQL 512, Valkey 128, RabbitMQ 512, AIStor 512, proxy 128:
**4,608 MiB steady upper bounds**, not measured usage. Migrator 768 runs before
application workers, then exits. Frontends/live are single-process initial caps;
Valkey is a small dedicated cache. No database/MQ/storage component was removed,
no upstream command or concurrency weakened. Backend/storage caps were retained.
OOM/restarts under real workload require reevaluation, not claims of capacity.
The deploy script gates on measured available memory before and between phases;
if pressure appears, stop the next phase, keep ingress unavailable and reassess.
There is no entitlement to resize, prune or steal another service's headroom.

The owner's accessible pre-job service records report zero running/waiting jobs
and no held resources. Audio `job-a70b97518574` is completed/paused, with saved
org `a353f71` / SomeWork `2f56146` and Manager work preserved. No available Cluster
Product Manager is established; absence is not an endless coordinator blocker.
This background job has no job-control/messaging tools to independently audit
all reservations. These limits are a rollout estimate, **not** a reservation.

`deploy.sh` uses the repository's `flock` pattern at
`$HOME/somework-pilot/plane/lock` on Services. This is NEW protection for operators
using this script, not evidence that other jobs already share/hold that lock.
Agents' existing kit CI lock is separate and unchanged. Check real active-job
records, ports, volumes and memory again immediately before deployment.

## Provenance and persistent configuration

`upstream/compose.yaml` remains byte-for-byte makeplane/plane v1.4.2, commit
`5f7d92784c403f76284f0f16718f320221dc7fec`, SHA-256
`ce2dc6829df5a31c482f8a29ad339ef4a26a9cc213e201ad6823d5e0f93f832b`;
upstream AGPL license is included. All application components and persistent
volume targets remain. AIStor retains the `plane-minio` DNS name, S3 endpoint,
credentials and `plane_uploads` volume, replacing the storage implementation only.
License is a read-only bind with `create_host_path: false`; a missing file cannot
silently become a directory. API waits for storage ready in addition to DB/MQ/cache.

**Never run upstream alone.** Compose >=2.24.4 is required for `!override`.
Merge the overlay; only `127.0.0.1:8090:80` is published. No API/DB/MQ/cache/object
store/console port is published. Always use `config --quiet` on a host, never
expanded config, process environment or credentials in output.

The approved generator is `generate-secrets.mjs PRIVATE_DIRECTORY VERIFIED_ORIGIN`.
It requires a private mode-0700 directory, creates `plane.env` with mode 0600
exclusively, generates six independent 256-bit values, constructs URLs locally,
and prints nothing. It refuses an existing env file/symlink instead of rotating
or overwriting it. Run through `host_exec` approval, not a sandbox-to-host secret
copy. Services has Python but no established Node executable; use the inspected
pinned Node image from `storage/test.compose.yaml`, network disabled, with an
approved host-directory mount and the correct host UID. Directory ownership and
license permissions must allow Compose/container access without broadening them.

## Tailnet-only ingress: proposed, not installed

Observed Agents node: `admin-cloud-agents.tail371505.ts.net`, Serve config `{}`,
Tailscale 1.102.4. **Do not rename it or use Funnel.** Node exists; no working Plane
URL is claimed. Port 8443 is proposed only after rechecking existing Serve/ports.
A strict-key SSH reachability probe to Services failed because Agents has no
verified Services host key. Password/key authentication and persistent forwarding
are therefore not established; never use `StrictHostKeyChecking=no` to proceed.

Reviewed path:

```
owner tailnet client -> Agents Serve HTTPS :8443
 -> 127.0.0.1:18091 owner-identity gateway
 -> 127.0.0.1:18090 dedicated SSH local forward
 -> Services 127.0.0.1:8090 Plane proxy
```

1. On Services, owner-approved creation of a dedicated `plane-forward` account
   and authorized key, plus `ingress/sshd-plane-forward.conf`. Validate `sshd -t`
   and the effective Match settings before reload. Key must be restricted to
   source `10.10.10.11`, no shell/PTY/agent forwarding, local TCP forwarding only,
   `PermitOpen 127.0.0.1:8090`, `PermitListen none`. Never grant an existing agent
   key broader access. Existing SSH configuration/authorized keys are preserved.
2. On Agents, owner-approved generation/enrollment of a NEW dedicated key at
   `/etc/plane-gateway/plane_ed25519` (directory private, key readable only by its
   unit user) and a Services host-key pin verified through the supported Services
   connection. Never blindly trust ssh-keyscan, print private key material or
   transport it in chat/Git. Install `plane-forward.service`, `plane-gateway.service`
   and `gateway.mjs` at `/opt/plane-gateway/`; Node is present at `/usr/bin/node`.
3. Confirm the owner login. Tailscale Self's observed login is `jimmystridh@github`;
   owner must confirm this is the intended authorized identity. The unit uses
   exactly that login and rejects all others, including tag/no-identity traffic.
4. With owner approval and port 8443 unassigned, add ONLY that Serve listener:
   `tailscale serve --bg --https=8443 http://127.0.0.1:18091`.
   Do not use Serve reset, change other listeners/routes, enable Funnel or enroll
   a second shared node. Record before/after Serve state.

[Tailscale Serve identity documentation](https://tailscale.com/kb/1312/serve)
explicitly says incoming identity headers are removed to prevent spoofing.
The gateway relies on that supported behavior and a trusted localhost host;
local admins/processes can forge headers directly, so this is NOT isolation
against compromised Agents. Never bind it to a private/public address. First
bootstrap is owner-only on **every** path, not only `/god-mode/`. No wider team
access until owner bootstrap and a separately reviewed access policy.
`WEB_URL` will be `https://admin-cloud-agents.tail371505.ts.net:8443` only once
this route is verified. It is presently a proposed origin, NOT a working URL.

## Licensed storage and deployment checks

After review, approved license installation and staging the exact commit:

```sh
# Services, isolated test project; license read requires owner-approved execution.
cd deploy/plane/storage
sc() { docker compose -p plane-storagecheck-job-b18abe24b1f1 \
  --env-file /dev/null -f test.compose.yaml --profile test "$@"; }
sc up -d --wait --wait-timeout 240 storage
sc run client
sc restart storage
sc up -d --wait --wait-timeout 240 storage
sc run client node /test/s3-smoke.mjs --verify
# Public test credentials only, internal network, no published ports.
# Cleanup only this test project through a separate owner-approved action.
```

Then, through `host_exec`, from the reviewed checkout, after secrets/ingress gates:
`deploy/plane/deploy.sh REVIEWED_FULL_COMMIT`. It takes a nonblocking lock, checks
quiet config and headroom, waits for dependencies, recreates the migrator and
requires exit 0 before starting API/workers/frontends. It never prints credentials,
resets ingress, deletes volumes or stops other stacks. Passing its local startup
check is NOT complete deployment verification.

From the authorized real tailnet client, normal TLS verification is required:
- `/`, `/god-mode/`, `/api/instances/`, owner first-admin creation, login/project
  creation, upload/download, presigned browser storage paths and `/live/` WebSocket.
- From a different tailnet user (or missing/tag identity), all paths/WS must be
  403; caller-supplied `Tailscale-User-Login` must NOT spoof the owner through Serve.
- From public/private-IP peers, no Plane/API/storage listener is reachable.
- Migrator exit 0, `python manage.py showmigrations --plan` inside API with no
  pending migrations; prerequisites/API healthy, no OOM/restart loops, workers/beat
  consuming jobs. Inspect logs safely, without rendering secrets.
- Recreate/restart only the repository Plane containers via approved operations;
  verify project and uploaded objects persist. No `down -v` or prune.
- Compare existing five services' health, bindings and resource use before/after;
  record MemAvailable/pressure, real workload peaks, container memory/restarts and
  actual image digests. Any failed stage is NOT a successful deployment.

Owner claims first admin at `/god-mode/`; do not create their password. Protect
uninitialized setup until then. SMTP is not configured; do not advertise email,
magic links or password reset as tested. Disable magic-link login and restrict
signup in instance settings after bootstrap.

## Backup/rollback and local tests

Persistent names remain `plane_pgdata`, `plane_uploads`, `plane_redisdata`,
`plane_rabbitmq_data`, logs/proxy volumes. Before production use, establish
owner-approved encrypted off-host DB/object/secret/license backups, retention and
RPO/RTO; test an isolated consistent restore. No schedule/restore coverage exists
from this job. Never tar a live PostgreSQL volume, delete data, or run old code
against incompatible migrated state. Preserve data on failed migrations and keep
ingress unavailable while investigating; restore requires separate approval.

```sh
COMPOSE_BIN=/path/to/compose node --test deploy/plane/*.test.mjs \
  deploy/plane/ingress/*.test.mjs deploy/plane/storage/*.test.mjs
npm run check:roles
git diff --check
```

### Push/CI verification

The PR branch was updated via `git_push` (not main). Woodpecker #111 for
`020a4d7` reports `error` in 0 seconds with no step records; this is **not green
CI**, and no cause is established by the available output. Local Plane tests and
role boundaries passed. All five kit agents remain ready at `ci-4ed7cad`; none
was rolled by this Plane PR. Final Services inspection still shows the five
existing containers running, four healthy, 5,039 MiB available and 51 GiB free;
Agents Serve remains `{}`. Three exited diagnostic containers/anonymous volumes
are retained as above. Review/check resolution remains a deployment gate.

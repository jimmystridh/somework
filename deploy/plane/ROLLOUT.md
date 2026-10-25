# Plane rollout

**Status 2026-10-25: deployed** on Services with Garage storage (single node, layout
`dc1` 20 GB) from this directory staged by `git archive` (tree-hash checked), and
reachable only through the owner-only gateway at
`https://admin-cloud-agents.tail371505.ts.net:8443` (tailnet, no Funnel). Verified:
migrations, loopback proxy, ingress chain, owner/non-owner gateway checks, and
Plane's own boto3 presigned POST/GET, head, copy, wrong-key and anonymous
rejection, and persistence across a Garage restart. Still owner steps: create the
first admin at `/god-mode/`. Layout capacity (20 GB) can be raised with
`garage layout assign` when needed. The record below is the pre-deployment
history of 2026-10-14.

## Pre-deployment history (2026-10-14)

This continuation leaves `feat/plane-garage-contract` at exact `5c59937` unchanged.
Its storage contract is useful preparation, not a deployed Plane instance. The
new script changes here also require exact-commit review before host execution.

## Evidence and actual blockers

- Main is `b924d31224397818e82de53d5beef2b54f3a426b`, CI #120 success.
  PR14/job wrapper head is `5c59937`; CI #122 failed before steps. Read-only SQL
  selecting **only** `number,status,errors` confirms missing `github_token` on
  #121/#122. Do not remove the PR checks to manufacture green CI.
- Reviewer `/state/threads/jobs.json`: `job-3ca222b12543` failed at clone with
  GitHub HTTP 403. Reviewer run index subsequently reports offline bundle
  inspection approval timed out. **No review occurred or approval exists.**
  The reviewer can help once repository access or an approved accessible review
  artifact is supplied. This job has no messaging tools; its result must carry
  that precise handoff, not fabricate reviewer approval.
- Services `GIT_TERMINAL_PROMPT=0 git ls-remote` still cannot authenticate.
  Neither Services nor Agents' established CI source has `deploy/plane`.
  A supported exact-commit checkout/staging transport remains missing. Existing
  CI deployment key is constrained to the agent deployment handler; do not
  extract/reuse it for arbitrary commands or roll the fleet to stage Plane.
- Host policy source: `MAX_CONFIRMABLE_COMMAND=600`; unknown/interpreter writes
  and secret operations require approval. The previous long file/provisioning
  refusals and timed-out public-key transfer are stopped, not retried or encoded.
  Repository scripts provide readable reviewable operations **after staging**,
  not an alternate route around a refused transfer or permission.
- Services: no `plane.env`/AIStor license, no running Plane, Garage contract
  containers stopped and retained; `plane-forward` account and restricted sshd
  settings persist. Agents: no ingress units/code or Serve configuration.
  Dedicated private key/known-host pin preserved; no key enrollment attempted.
  Existing five Services containers stayed running, four healthy; ~4,919 MiB
  available and 47 GiB disk free in the pre-work sample. No volumes removed.
- Tailscale maps Self to `jimmystridh@github` in `jimmystridh.github`. The intended
  owner mapping to `telegram/327148078` still needs explicit confirmation.

## Reviewed future Garage ordering (not executed here)

AIStor remains the default and still requires a legitimate owner-installed
license. The new explicit Garage mode is not acceptance of the single-node
no-redundancy tradeoff: the owner must decide that separately, or choose a
reviewed replicated topology. Never use `plane_uploads` as Garage metadata/data.

After review, supported staging of the exact full Git commit and approvals for
host-local secrets, use `generate-secrets.mjs /srv/plane VERIFIED_ORIGIN garage`.
The private file generation and deployment invocations reading/provisioning
secrets must go through host_exec approvals. Never paste values into arguments,
chat or Git. Preserve any existing/partial files; exclusive generation is not a
rotation or repair mechanism.

From that exact clean checkout:

1. `deploy/plane/deploy.sh REVIEWED_FULL_COMMIT garage storage` starts **only**
   Garage, without health-waiting for an uninitialized layout. It cannot run
   migrations, DB/app workers or ingress. Private configuration and measured
   headroom are checked first. The literal explicit Garage mode is required.
2. Via approved operations, inspect `/garage status`/`layout show`, choose an
   explicit zone/capacity from real disk headroom, assign the observed node ID,
   and apply the observed next layout version. No automated capacity guessing,
   existing-layout replacement, secret output, volume conversion or deletion.
   Resolve the single-node durability decision before this step.
3. `deploy/plane/deploy.sh REVIEWED_FULL_COMMIT garage` health-waits for the
   initialized prerequisites, provisions the private uploads bucket and strictly
   read/write-only key, recreates migrator and requires exit 0, starts healthy API,
   then other application containers and finally loopback proxy. It fails closed
   on preflight/layout/provision/migration errors. The helper's real new-key
   JSON-API path is STILL runtime-unverified; unit/mocked flow tests are not that
   verification. Its earlier refused live execution has not been retried here.
4. Inspect pending migrations, loopback responses, workers and resource/restart
   state. Only then enroll the preserved dedicated ingress public key and install
   the exact reviewed units/gateway using an approved supported transfer. Do not
   retry the stopped transfer server. Obtain intended-owner confirmation and
   approval for **only** Serve HTTPS :8443; preserve every existing route and never
   use Funnel, reset, node rename or broad credential/key reuse.
5. Verify real private TLS, owner/non-owner rejection, first-admin bootstrap by
   the owner, actual Plane upload/download/presigned paths, live WebSocket and
   restart persistence. Keep the private URL unavailable on failed intermediate
   gates. Application bootstrap/test credentials require the approved secret
   process; don't invent the owner's password. Follow the full README checklist.

No stage-only exit, branch push, test result or CI result is task completion.
The task is blocked pending concrete review/access/secret/identity decisions;
it should resume on those decisions/events without a new deployment request.
PR14 is watched; an event watch is not proof that any host action executed.

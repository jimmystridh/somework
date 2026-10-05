# Deploying the Pi agent on the agent Docker host (VM102)

Three containers in one compose project (`deploy/compose.yaml`): `agent` (harness), `sandbox` (tools), `egress` (allowlist proxy).
Prerequisites: the pilot domain from `deploy/README.md` at the repository root (TLS proxy, private CA) and Docker on the host.

## 1. Identities (on the domain host)
```bash
# the agent: generate its key ON VM102 so it never travels, register only the public key
docker run --rm -u 10001:10001 -v $PWD/keys:/keys --entrypoint somework-sidecar somework-worker:<tag> keygen --id agent/pi-agent --key-out /keys/agent.key.json
ops admin --config /etc/somework/somework.toml enroll-agent --id agent/pi-agent --public-key '<publicKey>' --side-effects write
ops admin --config /etc/somework/somework.toml register-card --card /cards/pi-agent.json --approve      # adapters/pi/card.json
# a requester
ops admin --config /etc/somework/somework.toml enroll-agent --id agent/pi-requester --public-key '<key>' --side-effects write --may-invoke 'code.*'
```
`--side-effects write` is required on both: registering a `write` capability, or submitting a task for one, is refused otherwise.

## 2. Files on the host (`~/somework-pilot/pi-agent/`)
`keys/agent.key.json` (uid 10001, dir 0700) · `config/ca.pem` · `secrets/sandbox-token` (random, mode 0440, group 10010: shared by agent
and sandbox) · `secrets/pi/auth.json` (the model credential, uid 10001, directory writable because an OAuth refresh rewrites it) ·
`.env` from `.env.example`.

**Model credential.** Copy only the provider you use. The Codex credential is an OAuth session: if another Pi installation holds the
same refresh token, whichever refreshes first may invalidate the others. Give this service its own login or an API key before relying
on it past the access token's expiry.

`auth.json` may hold several providers (`openai-codex`, `opencode-go` as `{"type":"api_key","key":...}`, `antigravity` as the OAuth entry
Pi wrote on a workstation). Copy a provider's entry only when it is meant to be used: `PI_PROVIDER`/`PI_MODEL` pick the default and
`PI_ALLOWED_MODELS` (comma separated `provider/model-id`) lists what a job may request with `input.model`. Antigravity and OpenCode send
the repository content to Google (a personal account's login) and to third-party model hosts respectively: keep them out of the default
and off any repository whose owners have not agreed. Re-register `card.json` after upgrading (`input.model` is a new optional field).

## 3. Build and start
```bash
docker build -f adapters/pi/Dockerfile --target agent   -t somework-pi-agent:<tag>   .     # from the repository root
docker build -f adapters/pi/Dockerfile --target sandbox -t somework-pi-sandbox:<tag> .
docker build -f adapters/pi/Dockerfile --target egress  -t somework-pi-egress:<tag>  .
docker compose --profile init run --rm -T init-volumes </dev/null
docker compose up -d && ./verify-sandbox.sh .
```
`verify-sandbox.sh` proves, from inside the sandbox: non-root, read-only root, no capabilities, no credentials or service variables
reach commands, no route out without the proxy, the proxy refuses an off-list host / a private address / cloud metadata, and an
allowlisted host works. Edit `EGRESS_ALLOW` (compose `.env`) to widen the list.

## 4. Smoke test without credentials
`PI_PROVIDER=faux PI_FAUX_PLAN='["write:smoke.txt:hello","final:ok"]'` in `.env`, a bare repository inside the sandbox volume as the
remote, then `node adapters/pi/examples/request.ts ... --repo /workspace/remotes/demo.git`.

## 5. Drills (run on 2026-10-05, all passed)
| Drill | Result |
|---|---|
| `docker kill` (SIGKILL) the agent mid-run, then start it | task completed, attempt 2, exactly one commit |
| `docker stop` mid-run | stop took 0.9 s, exit code 0, run resumed and completed with one commit |
| sandbox containment (`verify-sandbox.sh`) | 13/13 checks |
| real model (Codex `gpt-5.5`): create a file | exact content, 1,424 tokens, about $0.008 |
| real model asked to run `sudo whoami` | approval requested, denied, no changes |
| Alloy | tails agent, sandbox and egress logs through the existing redacting pipeline |

Found on the way (fixed): a per-command `cwd` was overridden by the environment's default; the process lingered until an in-flight tool
call finished (now exits at once after committing state); `docker compose run` swallows a script's stdin (use `-T </dev/null`).

## 6. Observability
Logs are JSON with identifiers and counts only (prompts, commands, file contents, tokens and long strings are redacted by field name)
and reach the central Loki through the host's Alloy (container logs, `event` and `level` become labels). No Prometheus is needed:
the dashboard and alerts are derived from the log events `job_finished` (status, token counts, cost, duration), `job_failed`,
`job_refused` and `approval_requested`.

* `loki/grafana-dashboard.json`: import into Grafana (pick the Loki data source). Tokens and cost count when a job finishes.
* `loki/alerts.yaml`: Loki ruler rules (failures, token burn, budget refusals, approval floods, long jobs). Not loaded yet: load them
  into the ruler of the central Loki. The agent logs only on activity, so liveness is the container health check (`/ready`).
* `prometheus/`: optional, only if a Prometheus appears later (`/metrics` on `127.0.0.1:8081`, `somework_pi_*`; scrape config,
  alert rules, dashboard).

## 7. Scaling by shards (when one service is the bottleneck)
Fixed 64 logical shards: `shardOf(agentKey)`. Give each agent id explicit ranges in a table (`SHARD_TABLE_FILE`,
`{"shardCount":64,"owners":{"agent/pi-a":[[0,31]],"agent/pi-b":[[32,63]]}}`); every shard must have exactly one owner. Requesters set
`targetAgentId` with `routeTask(table, key)`; a service refuses (`wrong_shard`) a key it does not own. One SQLite per service: never run
replicas against one file. Moving a range moves only the keys of those shards.

## Limits
* The credential is in the harness process: anything that runs there could read it. Only audited tool code runs in the harness;
  repository code runs only in the sandbox.
* Same-host kernel sharing with other agents on VM102 (non-root, read-only, no capabilities, no socket, limits).
* Pull request creation needs a repository-scoped token mounted at `secrets/git-token` (fine-grained PAT, one repository, Contents and
  Pull requests write, uid 10001, 0400; the compose file mounts it, so the file must exist, empty-config runs use `GIT_TOKEN_FILE` unset).
  Pull requests are opened as drafts (`GIT_PR_DRAFT=1`, the default here). Without a token the branch is pushed and no pull request is opened.
* The agent reaches the broker (`tls://<domain host>:4222`, the private CA, name or IP in the certificate) for wake-ups; if that is blocked it falls back to short HTTP lookups every 2 s. The live chunk stream of the sidecar is not implemented.

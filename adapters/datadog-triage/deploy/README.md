# Deploying the Datadog triage agent on the agent Docker host

Two containers in their own compose project (`deploy/compose.yaml`, project `somework-datadog-triage`): `agent` (the harness, this role's image; it holds every credential and runs the Datadog tools) and `sandbox` (where the model's bash, python3 and jq run). There is **no egress proxy**: the sandbox sits alone on an internal network with no route out. Nothing is deployed by this repository: these are the steps, in order. What the role does is in `../README.md`.

* **Own everything.** Own SomeWork identity (`agent/datadog-triage`), own model login, own Datadog keys, own sandbox volume and token, own state volume, own health port (`127.0.0.1:8084`; 8081 is the developer agent, 8082 the reviewer, 8083 the Aikido fixer).
* **Read only, everywhere.** The identity is enrolled `--side-effects read`; the Datadog application key has read scopes only; the agent has no repository and no git token; the sandbox has no credentials and no network.
* **The harness reaches three places** over `outside`: the SomeWork domain, the model API, and `api.<DD_SITE>` (`api.datadoghq.eu`). If the host has an egress firewall, allow exactly those and nothing else for this project.

Prerequisites: the domain with its TLS proxy and private CA (root `deploy/README.md`), the event hub with the `datadog` source live and a Datadog webhook pointing at it (`packages/events-hub/README.md`), the manager enrolled (it receives this agent's notices and forwards them to the owner), Docker on the host, and the developer role's sandbox image (`somework-pi-sandbox:<tag>`), which this role's sandbox is built on.

## 1. Identity and card (on the domain host)
```bash
# on the agent host: generate the key there so it never travels; only the public key is registered
mkdir -p keys && chmod 700 keys && chown 10001:10001 keys
docker run --rm -u 10001:10001 -v $PWD/keys:/keys --entrypoint somework-sidecar somework-worker:<tag> keygen --id agent/datadog-triage --key-out /keys/agent.key.json

# on the domain host (`ops` as in the root deploy README)
ops admin --config /etc/somework/somework.toml enroll-agent --id agent/datadog-triage --public-key '<publicKey>' --side-effects read --may-invoke 'ops.triage'
cp card.json cards/datadog-triage.json                             # adapters/datadog-triage/card.json, copied to the host's ./cards directory
ops admin --config /etc/somework/somework.toml register-card --card /cards/datadog-triage.json --approve
```
`--side-effects read` because the capability changes nothing. **`--may-invoke 'ops.triage'` is deliberate**: the shipped handler submits the triage task to this same agent, and an agent may only submit what it is allowed to invoke. Nothing else may invoke it unless its own enrolment says so (the manager needs `--may-invoke 'ops.triage'` to start a triage by hand; `examples/request.ts` needs the same for its requester key).

**The NATS broker reloads itself** (a watcher inside the broker's container, see the root deploy README). On a deployment from before 2026-10-06 that still has the separate `nats-reloader` container, send `SIGHUP` by hand: Right after `enroll-agent`, send `SIGHUP` to the broker process (`docker kill -s HUP somework-domain-nats-1` on the domain host). Its reloader prints "reloaded" but does not load the new user; without this the agent polls over HTTP only. Check `GET /v1/connection` as the agent first.

## 2. The rule (so events reach the agent)
`rules/datadog-triage.yaml` is an agent subscription: owner `agent/datadog-triage`, selector `datadog.monitor.*`, wake. The rules pipeline refuses a rule whose owner is not enrolled, so the file only goes into `rules/` after step 1 (on the pilot it was added on 2026-10-06, after the enrolment). `profile.test.ts` validates it against the cards with `--strict`. The existing rule `alert-datadog-to-manager` stays: the manager still hears about each alert.

**Events flow as soon as the rule is applied**, and every eligible alert then costs model tokens (150 000 at most per triage, `DD_DAILY_CAP` triages a day). Start the agent before applying the rule if you want a quiet window, or pause the rule with the manager's `/pause datadog-triage`.

**The webhook template.** The hub's mapping reads the keys `id` (or `alert_id`), `title`, `transition`, `status`, `link`, `date`, `priority` and `tags` of the Datadog webhook payload (`packages/events-hub/mappings/datadog.jsonata`). Priority filtering (`DD_MIN_PRIORITY`) and the tag filter need `priority` and `tags` in the template; without them every alert passes the priority filter and a tag filter drops everything.

## 3. Files on the host (`./`, the compose directory)
| Path | What |
|---|---|
| `keys/agent.key.json` | the identity key (uid 10001, directory 0700) |
| `config/ca.pem` | the private CA |
| `secrets/sandbox-token` | random, mode 0440, group 10010: shared by agent and sandbox of THIS project |
| `secrets/pi/auth.json` | the model login (below), uid 10001; the directory must be writable because an OAuth refresh rewrites the file |
| `secrets/datadog-keys.json` | the Datadog API key and application key (below), mode 0400, uid 10001 |
| `.env` | from `.env.example` |

**The model login is this role's own.** Do the device-code login for this agent separately and never copy another agent's `auth.json` (an OAuth refresh token is rewritten on use, so two services holding the same one invalidate each other). The owner approves the code at the provider's device page.
```bash
mkdir login && cd login                                   # a scratch directory: the login writes ./auth.json
node <repo>/node_modules/@earendil-works/pi-ai/dist/cli.js login openai-codex   # choose the device-code option, approve the code in a browser
sudo install -d -o 10001 -g 10001 -m 0700 ../secrets/pi
sudo install -o 10001 -g 10001 -m 0600 auth.json ../secrets/pi/auth.json
cd .. && rm -r login                                      # no copy stays on the workstation
```

**The Datadog keys** (Datadog EU: `https://app.datadoghq.eu`; the API host is `api.datadoghq.eu`; set `DD_SITE` for another site). Datadog needs two keys:

1. **API key**: *Organization Settings → API Keys → New Key*, name it `somework-datadog-triage`. It identifies the organisation.
2. **Application key**: *Organization Settings → Application Keys → New Key*, name it `somework-datadog-triage`. It carries the permissions, so make it as small as possible: create it as a **service account's** key where your plan has service accounts (*Organization Settings → Service Accounts*, a role with read access only), or as the owner's own key otherwise, and give it **scopes** (the key's *Edit scopes*) instead of the owner's full rights. The role calls exactly these endpoints, all reads:

   | Scope | Used for | Endpoints |
   |---|---|---|
   | `monitors_read` | `monitor_get`, `monitor_search` | `GET /api/v1/monitor/{id}`, `GET /api/v1/monitor/search` |
   | `logs_read_data` | `logs_search` | `POST /api/v2/logs/events/search` (a search, it changes nothing) |
   | `timeseries_query` | `metrics_query` | `GET /api/v1/query` |
   | `events_read` | `events_search` | `POST /api/v2/events/search` (a search) |
   | `incident_read` | `incidents_list` | `GET /api/v2/incidents` (optional: without it the tool says incidents are unavailable and the triage goes on) |

   No write scope is needed or wanted: the agent never changes anything in Datadog. The scope names are the ones the brief for this role names; check them against the scope list the application key page shows (a log search that answers 403 means the key lacks `logs_read_data`, or the logs permission of the role behind the key).

File format, written on the host and never in a chat or a repository:
```json
{ "apiKey": "<32 hex characters>", "appKey": "<40 hex characters>" }
```
```bash
sudo install -o 10001 -g 10001 -m 0400 datadog-keys.json secrets/datadog-keys.json && shred -u datadog-keys.json
```
The harness reads it before every request, so replacing the file rotates the keys without a restart; the sandbox never mounts it. Keep a copy of the pair in the password manager. A key that was ever pasted into a chat or a repository is burnt: create a new one and delete the old one in Datadog.

## 4. Build and start
```bash
# from the repository root (the build context): the developer role's sandbox if the host does not have it, then this role's two images
docker build -f adapters/pi/Dockerfile --target sandbox -t somework-pi-sandbox:<tag> .
docker build -f adapters/datadog-triage/Dockerfile --target agent -t somework-datadog-triage:<tag> .
docker build -f adapters/datadog-triage/Dockerfile --target sandbox --build-arg SANDBOX_BASE=somework-pi-sandbox:<tag> -t somework-datadog-triage-sandbox:<tag> .

cd adapters/datadog-triage/deploy      # or wherever compose.yaml and .env live on the host
docker compose --profile init run --rm -T init-volumes </dev/null
docker compose up -d
docker compose ps && docker compose logs agent --tail 20      # expect datadog_handler_seeded and service_started {"role":"datadog-triage", ...}
curl -s http://127.0.0.1:8084/ready                            # includes the sandbox and datadog_credentials
curl -s http://127.0.0.1:8084/status                           # handlers: [{name: "datadog", enabled: true, ...}], tokenPools
```
The images use the same tag for `DATADOG_VERSION` in `.env`. The agent image is built from the npm workspace's one lockfile with only its own, the agent kit's and the SDK's manifests; the build fails if the service cannot import every module it runs or the handler template does not render and parse. The sandbox target adds `python3` and `jq` to the developer sandbox and fails the build if python3 cannot import its standard library. When building on the host, sync `package.json package-lock.json .npmrc sdk packages adapters/datadog-triage adapters/pi` (without `node_modules`) to the build directory first. The shared developer images are not changed by this role.

Check the sandbox has no way out (it should fail to resolve or connect):
```bash
docker compose exec -T sandbox python3 -c "import urllib.request; urllib.request.urlopen('https://api.datadoghq.eu', timeout=5)"   # expect an error
```
Add `8084` to `HEALTH_PORTS` in `/etc/default/agent-health-firewall` and restart `agent-health-firewall.service` when `HEALTH_BIND` is the host's private address: Docker bypasses ufw and the health port would otherwise be readable from the private network.

## 5. Smoke test
1. **Without Datadog or a model.** `PI_PROVIDER=faux` with the plan in `.env.example`, `DD_ALLOW_BASE_OVERRIDE=1` and `DD_API_BASE` pointing at a stand-in for the monitor read, then a task by hand (needs a requester with `--may-invoke ops.triage`):
   ```bash
   node adapters/datadog-triage/examples/request.ts --url "$SOMEWORK_URL" --key requester.key.json --ca ca.pem --monitor <id>
   ```
   Expect `succeeded` with the scripted diagnosis, one notice to the manager, and no files left in the workspace volume.
2. **Real Datadog, real model, one real alert.** Pick a monitor that is in the Alert state or has been recently. Run the same command. Expect `outcome: diagnosed` or `inconclusive`, a `monitorUrl`, evidence with `refs`, and one message to the owner that ends with the monitor link. Check in Datadog's audit trail (*Organization Settings → Audit*) that nothing but reads came from the key; the logs show `datadog_saved` lines when the model used save mode.
3. **The event path.** Wait for (or publish, through a throwaway producer limited to `datadog.*`) a `datadog.monitor.alert` event with a numeric `monitorId`: `GET /v1/rules/datadog-triage` shows it firing (agent subscription), the agent log shows `handler_decision` with action `submit`, an `ops.triage` task appears with origin kind `event`. Send the same event again: the second is dropped (`already handled`); a `datadog.monitor.recovered` event is dropped (`the monitor recovered`); an event with no numeric id ends `deliver` and creates no task.
4. **The guards.** A monitor of priority P4 or P5 ends `skipped` without a model call and without a notice; a second triage of the same monitor within the cool-down ends `skipped`; a monitor id that does not exist fails `invalid_input`.
5. **The sandbox.** Ask the agent in chat to triage a monitor (`please triage monitor <id>`) and watch the progress: the model's `curl` or `pip` calls are refused with the policy's reason, a `python3` aggregation over `data/logs_search-1.json` works.

## 6. Operate
* Health: `127.0.0.1:8084/ready` and `/status` (handlers and token pools; the fleet dashboard can read the same when `HEALTH_BIND` is set to the host's private address and the services VM may reach port 8084).
* Pause the event path without stopping the agent: the manager's `/pause datadog-triage` (the rule), or `/kill agent/datadog-triage datadog` (the handler). Both fail open: events are recorded for a person.
* Change a threshold: edit `.env` and restart with `DD_RESEED_HANDLER=1` once (a new version of the handler is saved; the earlier ones stay in the state volume under `handlers/.versions/datadog/`).
* The host-side counters are in the state volume (`datadog-triage.json`). Deleting a monitor's entry lets a person re-run it; deleting the file resets every limit.
* Rotate the Datadog keys: replace `secrets/datadog-keys.json`; no restart is needed. Rotate the model login by repeating the device-code login.
* Raise or lower the cost: `DD_TRIAGE_BUDGET_TOKENS` (hard cap 300 000), `DD_DAILY_CAP`, `DD_COOLDOWN_MINUTES`, `DAILY_TOKEN_LIMIT` and `EVENTS_TOKEN_SHARE` (the events pool this agent's event-driven runs draw from).

## 7. Roll back
```bash
docker compose down                                   # stops the agent; the domain keeps it enrolled but idle, events wait in its inbox
ops admin --config /etc/somework/somework.toml set-agent-status --id agent/datadog-triage --status disabled   # the kill switch for the identity
# a disabled agent stays in the catalog: also re-register its card with "capabilities": [] so nothing is routed to it
```
Remove the rule (delete `rules/datadog-triage.yaml`; the pipeline's `apply` deletes it) so no more events wake it; `alert-datadog-to-manager` is untouched. To remove it for good: delete the `state` and `workspace` volumes and the `keys` directory, delete the application key and the API key in Datadog.

## Limits
* The harness holds the credentials, so only audited code runs in the harness; the model's commands run only in the sandbox, which has nothing to steal and no network.
* The command policy is a screen, not a proof: a python script in `scratch/` is screened when it is written with the `write` tool, not when it is run, and a cleverer way around a regex is conceivable. What makes that harmless is the sandbox itself (no credentials, no route out, a read-only root, memory and process limits) and the fact that nothing it produces is trusted: only the model's final answer leaves, through the service's own checks.
* The service can check that a finding cites a real tool call, not that the finding is true. Findings the model could not source are labelled `inference` in the result.
* Datadog's own text (monitor names and messages, log lines, event titles) is untrusted. It is framed and stripped before the model sees it, and the notice built from the model's answer removes links and secrets; the monitor name in the notice is Datadog's text, clipped to 100 characters.
* A log search returns what the application key's role may see. Logs can hold personal data; the service strips mail addresses and secret-like strings from what the model sees and saves, nothing else.

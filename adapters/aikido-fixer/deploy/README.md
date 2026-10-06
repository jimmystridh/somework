# Deploying the Aikido fixer on the agent Docker host

Three containers in their own compose project (`deploy/compose.yaml`, project `somework-aikido-fixer`): `agent` (the harness, this role's image), `sandbox` (where the model works on a clone) and `egress` (the sandbox's only way out). Nothing is deployed by this repository: these are the steps, in order. What the role does is in `../README.md`.

* **Own everything.** Own SomeWork identity (`agent/aikido-fixer`), own model login, own code-host token, own Aikido client, own sandbox volume and token, own state volume, own health port (`127.0.0.1:8083`; 8081 is the developer agent, 8082 the reviewer). Only the images of the sandbox daemon and the egress proxy are the developer role's, because both are role-agnostic.
* **One repository.** The token, the allow-list in the settings and the mirror all name the same single repository.
* **Real pull requests by default.** `GIT_PR_DRAFT=0` (the default) opens real pull requests, `GIT_PR_DRAFT=1` opens drafts. The service refuses to start without a git token or with `PI_CONCURRENCY` above 1. Either way the envelope is the same: only `agent/*` branches, never the default branch, never a force push, nothing is merged or approved by this agent.

Prerequisites: the domain with its TLS proxy and private CA (root `deploy/README.md`), the event hub with the `aikido` source live (`packages/events-hub/README.md`), the manager enrolled (it receives this agent's notices), Docker on the host, and the developer role's sandbox and egress images (`somework-pi-sandbox:<tag>`, `somework-pi-egress:<tag>`).

## 1. Identity and card (on the domain host)
```bash
# on the agent host: generate the key there so it never travels; only the public key is registered
mkdir -p keys && chmod 700 keys && chown 10001:10001 keys
docker run --rm -u 10001:10001 -v $PWD/keys:/keys --entrypoint somework-sidecar somework-worker:<tag> keygen --id agent/aikido-fixer --key-out /keys/agent.key.json

# on the domain host (`ops` as in the root deploy README)
ops admin --config /etc/somework/somework.toml enroll-agent --id agent/aikido-fixer --public-key '<publicKey>' --side-effects write --may-invoke 'code.fix'
cp card.json cards/aikido-fixer.json                               # adapters/aikido-fixer/card.json, copied to the host's ./cards directory
ops admin --config /etc/somework/somework.toml register-card --card /cards/aikido-fixer.json --approve
```
`--side-effects write` because the capability writes (a branch and a pull request). **`--may-invoke 'code.fix'` is deliberate**: the shipped handler submits the fix task to this same agent, and an agent may only submit what it is allowed to invoke. Nothing else may invoke it unless its own enrolment says so (the manager needs `--may-invoke 'code.*'` or `code.fix` to start a fix by hand, `examples/request.ts` needs the same for its requester key).

## 2. The rule (so events reach the agent)
`rules/aikido-fixer.yaml` in the repository root is an agent subscription: owner `agent/aikido-fixer`, selector `aikido.*`, wake. It is applied the way every rule is (merge it; the pipeline runs `somework-rules apply`, or run `somework-rules apply` yourself). The owner must be enrolled first (step 1). Without the rule the agent still takes tasks submitted by hand.

## 3. Files on the host (`./`, the compose directory)
| Path | What |
|---|---|
| `keys/agent.key.json` | the identity key (uid 10001, directory 0700) |
| `config/ca.pem` | the private CA |
| `config/checks.json` | named check profiles of the repository (see `checks.example.json`); `{}` when there is none |
| `secrets/sandbox-token` | random, mode 0440, group 10010: shared by agent and sandbox of THIS project |
| `secrets/pi/auth.json` | the model login (below), uid 10001; the directory must be writable because an OAuth refresh rewrites the file |
| `secrets/git-token` | the code-host token (below) |
| `secrets/aikido-client.json` | the Aikido client pair (below), mode 0440 |
| `.env` | from `.env.example` |

**The model login is this role's own.** Do the device-code login for this agent separately and never copy another agent's `auth.json` (an OAuth refresh token is rewritten on use, so two services holding the same one invalidate each other). The owner approves the code at the provider's device page.
```bash
mkdir login && cd login                                   # a scratch directory: the login writes ./auth.json
node <repo>/node_modules/@earendil-works/pi-ai/dist/cli.js login openai-codex   # choose the device-code option, approve the code in a browser
sudo install -d -o 10001 -g 10001 -m 0700 ../secrets/pi
sudo install -o 10001 -g 10001 -m 0600 auth.json ../secrets/pi/auth.json
cd .. && rm -r login                                      # no copy stays on the workstation
```

**The code-host token** is a fine-grained token limited to the **one repository**, with *Contents: read and write* and *Pull requests: read and write* (Metadata: read comes with it), **expiry 90 days** (note the date; rotating it is a calendar item). Creating it needs the owner's passkey check; post the token form from inside the page so the value comes back in the response (the page detaches when the form is submitted). Put it in `secrets/git-token` (mode 0440, uid 10001) and keep a copy in the password manager. It is sent only to `GIT_TOKEN_HOSTS` (default `github.com`) by the git credential helper and the pull request client, and scrubbed from logs, artifacts and results. Recommended on the repository: protect the default branch (nobody, this agent included, pushes to it directly) and require a review before merging; the agent only ever pushes `agent/aikido-<issue>-<sha>`.

**The Aikido client** is an OAuth2 client (client id and secret) created in the Aikido workspace for this agent, with **read access to issues only**. The role calls exactly two endpoints, both `GET`: `/issues/groups/{id}` and `/issues/{id}` of the regional public API (`https://app.aikido.dev/api/public/v1`, `app.us.aikido.dev` or `app.me.aikido.dev` per `AIKIDO_REGION`), after a client-credentials token request to `https://app.aikido.dev/api/oauth/token`. No write scope is needed or wanted: the agent never changes anything in Aikido. File format:
```json
{ "clientId": "AIK_CLIENT_...", "clientSecret": "..." }
```
Mode 0440, owned by uid 10001 (`install -o 10001 -g 10001 -m 0440`). The harness reads it; the sandbox never mounts it. The access token is kept in memory only. Keep a copy of the pair in the password manager. A secret that was ever pasted into a chat or a repository is burnt: create a new client.

## 4. Build and start
```bash
# from the repository root (the build context): this role's image, and the developer role's sandbox and egress if the host does not have them
docker build -f adapters/aikido-fixer/Dockerfile --target agent -t somework-aikido-fixer:<tag> .
docker build -f adapters/pi/Dockerfile --target sandbox -t somework-pi-sandbox:<tag> .
docker build -f adapters/pi/Dockerfile --target egress -t somework-pi-egress:<tag> .

cd adapters/aikido-fixer/deploy        # or wherever compose.yaml and .env live on the host
docker compose --profile init run --rm -T init-volumes </dev/null
docker compose up -d
docker compose ps && docker compose logs agent --tail 20      # expect aikido_handler_seeded, mirror_refreshed and service_started {"role":"aikido-fixer", ...}
curl -s http://127.0.0.1:8083/ready
curl -s http://127.0.0.1:8083/status                           # handlers: [{name: "aikido", enabled: true, ...}], tokenPools
```
The image is built from the npm workspace's one lockfile with only its own, the agent kit's and the SDK's manifests; the build fails if the service cannot import every module it runs or the handler template does not render and parse. When building on the host, sync `package.json package-lock.json .npmrc sdk packages adapters/aikido-fixer` (without `node_modules`) to the build directory first.

The egress proxy admits `EGRESS_ALLOW` (default: the code host, its content hosts and the npm, yarn and NuGet registries). Add the registries the repository's code needs, nothing broader. The model API and Aikido are reached by the harness over `outside`, never by the sandbox.

## 5. Smoke test
1. **Without credentials.** `PI_PROVIDER=faux` with `PI_FAUX_PLAN='["final:NO_FIX: smoke test"]'`, then a task by hand (needs a requester with `--may-invoke code.fix` and a real Aikido issue id, or `AIKIDO_ALLOW_BASE_OVERRIDE=1` with `AIKIDO_API_BASE` and `AIKIDO_OAUTH_URL` pointing at a stand-in):
   ```bash
   node adapters/aikido-fixer/examples/request.ts --url "$SOMEWORK_URL" --key requester.key.json --ca ca.pem --issue <id> --repo <repository url>
   ```
   Expect `succeeded` with `outcome: no_fix`, no new branch (`git ls-remote`), and `mirror_refreshed` in the log.
2. **Real model on one real low-risk issue.** Expect `outcome: pr_opened`, a pull request (a draft when `GIT_PR_DRAFT=1`) from `agent/aikido-<issue>-<sha8>` whose body cites the issue, lists the files and says it was generated by an agent and must be reviewed before merge, and a commit `fix(security): … (Aikido #<id>)`. Check that nothing was pushed to the default branch and that the check profile (if any) ran.
3. **The event path.** Publish or wait for an `aikido.*` event for an eligible issue: `GET /v1/rules/aikido-fixer` shows it firing (agent subscription), the agent log shows `handler_decision` with action `submit`, a `code.fix` task appears with origin kind `event`. Send the same event again: the second is dropped (`already handled`).
4. **The guards.** An issue below `AIKIDO_MIN_SEVERITY` ends `skipped` without a model call; a request for another repository fails `invalid_input`.

## 6. Operate
* Health: `127.0.0.1:8083/ready` and `/status` (handlers and token pools; the fleet dashboard can read the same when `HEALTH_BIND` is set to the host's private address and the services VM may reach port 8083).
* Pause the event path without stopping the agent: the manager's `/pause aikido-fixer` (the rule), or `/kill agent/aikido-fixer aikido` (the handler). Both fail open: events are recorded for a person.
* Change a threshold: edit `.env` and restart with `AIKIDO_RESEED_HANDLER=1` once (a new version of the handler is saved; the earlier ones stay in the state volume under `handlers/.versions/aikido/`).
* The host-side counters are in the state volume (`aikido-attempts.json`). Deleting a line lets a person re-run an issue; deleting the file resets every limit.

## 7. Roll back
```bash
docker compose down                                   # stops the agent; the domain keeps it enrolled but idle, events wait in its inbox
ops admin --config /etc/somework/somework.toml set-agent-status --id agent/aikido-fixer --status disabled   # the kill switch for the identity
# a disabled agent stays in the catalog: also re-register its card with "capabilities": [] so nothing is routed to it
```
Remove the rule (delete `rules/aikido-fixer.yaml`; the pipeline's `apply` deletes it) so no more events wake it. Branches and pull requests it opened stay; close them like any other. To remove it for good: delete the `state` and `workspace` volumes and the `keys` directory, revoke the code-host token and the Aikido client.

## Limits
* The harness holds the credentials, so only audited code runs in the harness; repository code runs only in the sandbox.
* The sandbox is a container, not a virtual machine: a fix may run install scripts and tests of the repository as a non-root user with no credentials and a narrow proxy, which is the same boundary as the developer role.
* `agent/aikido-<issue>-<sha8>`, `-2` ... `-5` are the only branch names an issue can use for one base commit; a sixth different attempt fails `branch_exhausted`. Delete stale branches on the remote when a person has dealt with them.
* The model's own counters in the sandbox can be reset by the model's tools; the host-side ledger cannot, which is why both exist.
* Aikido's webhook payload is not known precisely yet; until the `aikido` mapping is refined from a real delivery, events without a numeric issue id are only recorded.

## First rollout (2026-10-06): what the runbook did not say
* **The broker needs a manual reload after enrolment.** Right after `enroll-agent`, send `SIGHUP` to the NATS broker process (`docker kill -s HUP somework-domain-nats-1` on the domain host). Its reloader prints "reloaded" but does not load the new user; without this the agent polls over HTTP only. Check `GET /v1/connection` as the agent first.
* **Add the health port to the published-port policy.** The health port is published on the VM address, and Docker bypasses ufw: add `8083` to `HEALTH_PORTS` in `/etc/default/agent-health-firewall` and restart `agent-health-firewall.service`, otherwise the whole private network can read it.
* **The first start clones the mirror.** About 170 MB and two minutes for the target repository through the proxy; `mirror_refreshed` appears in the log when it is done and a task started before that waits for it.
* **Events flow as soon as the rule is applied.** The rule (`rules/aikido-fixer.yaml`) is applied by CI on a push to the default branch. From then on every eligible `aikido.*` event starts a real fix attempt (model tokens, mirror clone, possibly a pull request). Start the agent before the rule is applied if you want a quiet window, or pause the rule with the manager's `/pause aikido-fixer`.
* **Aikido's own statuses.** The list endpoint says `PullRequestOpen`/`Todo`/`New`, the detail's `group_status` says `pull_request_open`; the role reads the detail, so an issue that already has an Aikido pull request ends `skipped` with no model call (checked on a live issue).
* **Credentials used on the pilot.** The Aikido client is the one the owner's `aikido` CLI uses for the `admin` workspace (stored in the macOS keychain, service `aikido-cli`), copied to `secrets/aikido-client.json` (0440, uid 10001). It can read issues but not list workspaces.
* **Safe dry check without a model.** Publish an `aikido.issue.created` event with `data.issueId` of an issue that already has a pull request (through a throwaway producer limited to `aikido.*`): expect `handler_decision submit`, a `code.fix` task with `origin.kind = event`, outcome `skipped`, 0 tokens. An event with no `issueId` ends `deliver` and creates no task.

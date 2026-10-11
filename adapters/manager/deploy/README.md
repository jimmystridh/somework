# Rolling out the Manager on VM102 (replacing `pi-telegram.service`)

Nothing here has been deployed. The old bridge (`~/agent-cluster-pi/telegram-bridge.mjs`, `pi-telegram.service`) stays untouched so
that rollback is one command. The new unit `Conflicts=` with it, because both start the container named `pi-demo`.

The Manager reuses the paired Telegram owner, the bot token and the Pi session of the old bridge (`~/.config/agent-cluster-telegram/`:
`bot-token`, `state.json`). The state file gains keys (`chats`, `chatApprovals`, `eventCursor`, `jobSubscription`); the old bridge ignores them, and the Manager ignores the `tasks` and `reactionApprovals` keys an older build left there.

## 1. Identity on the domain
No capability card: the Manager is a conversation partner, it offers nothing to the catalog. Other agents can message it by id; add a card
later only if it should show up there.

Generate the key on VM102 so it never travels (outside `~/.pi/agent`, which is mounted into the Pi container):
```bash
mkdir -p ~/somework-manager/keys && chmod 700 ~/somework-manager/keys
docker run --rm -u "$(id -u):$(id -g)" -v ~/somework-manager/keys:/keys --entrypoint somework-sidecar somework-worker:pilot-1 \
  keygen --id agent/manager --key-out /keys/manager.key.json
```
Then on the domain host (VM105; `ops` as in the root `deploy/README.md`), with the printed public key:
```bash
ops admin --config /etc/somework/somework.toml enroll-agent --id agent/manager --public-key '<publicKey>' \
  --side-effects write --may-invoke 'code.*'
```
The `--side-effects` and `--may-invoke` flags belong to the domain builds that still have tasks; the Manager no longer submits any, so they
matter only until the domain drops them.

### Events and controls (additional permissions; apply once, by the operator)
The Manager reads rules and events with `ops.read`, pauses or resumes rules with `rules.control`, and subscribes itself to the job-finished
events of the agents (`agent.*.job.finished`, a topic subscription, which needs `message.read`). `rules.control` is the domain's narrow rule
permission: it reads rules and pauses or resumes them, and the domain refuses `PUT` and `DELETE` for it, so the Manager's key can never
create or delete a rule, even through the API. Do not grant it `rules.manage`. `PATCH` replaces the whole permission set, so list everything
the Manager needs. The Manager decides no approval in the domain: agents ask the owner in messages and the owner answers in Telegram.
```bash
ops admin ... # run the PATCH with the operator key on the domain host
PATCH /v1/admin/principals/agent/agent%2Fmanager
{"permissions": {"actions": ["catalog.read","message.send","message.read","ops.read","rules.control"],
                 "classificationMax": "internal"}}
```
Check with `GET /v1/admin/whoami` as the Manager. Without `rules.control` (the domain must be a build that knows it) `/rules`, `/pause` and
the digest report a permission error in Telegram instead of data; without `message.read` for topics the job-finished subscription fails
(logged as `job_subscription_failed`, tried again at the next start) and the owner only hears about jobs in the conversations they started.
The Manager also receives the events of the rules that wake it (`alert-grafana-to-manager`, `nightly-digest`: their
`owner` is `agent/manager`).

Optional hub and handler controls, in `manager.env`: `MANAGER_HUB_URL` (the hub's listener, for `/sources` and `/pausesource`),
`MANAGER_HUB_TOKEN_FILE` (0600; the hub's admin token, derived from the hub secret:
`node -e 'import("./packages/events-hub/src/derive.ts").then(m=>process.stdout.write(m.adminToken(require("fs").readFileSync(process.argv[1],"utf8").trim())))' <hub-secret-file>`),
`MANAGER_HUB_CA_FILE`, and `MANAGER_AGENT_HEALTH` (`agent/reviewer=http://10.10.10.11:8081,...`, the agents' health ports, for `/handlers`).
`/kill` and `/unkill` need no setting: they send the kit's control message, which an agent accepts from the sender listed in its
`EVENTS_CONTROLLERS` (default `agent/manager`).

## 2. Files on VM102
```bash
mkdir -p ~/somework-manager
# from the repository root on the workstation: the workspace skeleton (root manifest, the one lockfile, .npmrc, the other workspaces'
# manifests: `npm ci` checks the lockfile against all of them) plus the two packages the Manager runs, and the one file of the kit it reads
# (the wire contract of setup documents, `src/setup/contract.ts`; it imports nothing but node:crypto)
rsync -aR --exclude node_modules package.json package-lock.json .npmrc sdk/typescript adapters/manager \
  packages/agent-kit/package.json packages/agent-kit/src/setup/contract.ts adapters/pi/package.json  agent-host:somework-manager/
# on VM102: the distro Node there is built without TypeScript support (`process.features.typescript` is false), so install the
# official tarball next to the code and use it for npm and for the unit:
#   curl -fsSLO https://nodejs.org/dist/v22.22.1/node-v22.22.1-linux-x64.tar.xz   # verify against SHASUMS256.txt, then
#   mkdir -p ~/somework-manager/node && tar -xJf node-v22.22.1-linux-x64.tar.xz -C ~/somework-manager/node --strip-components=1
export PATH=$HOME/somework-manager/node/bin:$PATH
# first redeploy after the move to one workspace lockfile: drop the old per-package installs and lockfiles
rm -rf ~/somework-manager/sdk/typescript/{node_modules,package-lock.json} ~/somework-manager/adapters/manager/{node_modules,package-lock.json}
(cd ~/somework-manager && npm ci --omit=dev --ignore-scripts -w @somework/manager)
cp ~/somework-manager/adapters/manager/deploy/manager.env.example ~/.config/agent-cluster-telegram/manager.env
chmod 600 ~/.config/agent-cluster-telegram/manager.env        # then check the paths and the gateway address
docker network inspect agent-cluster-pi_default --format '{{range .IPAM.Config}}{{.Gateway}}{{end}}'   # MANAGER_GATEWAY_BIND/URL
cp ~/somework-manager/adapters/manager/deploy/pi-manager.service ~/.config/systemd/user/
systemctl --user daemon-reload
```
`gateway-token` is created on first start in `~/.config/agent-cluster-telegram/` (mode 0600) and passed to the container as an
environment variable; delete the file and restart to rotate it.

## 3. Switch over
```bash
systemctl --user stop pi-telegram.service
systemctl --user start pi-manager.service
journalctl --user -u pi-manager.service -f          # expect: manager_ready {"bot":...,"owner":"paired","gateway":"172.18.0.1:7079","agent":"agent/manager"}
```
Do not `enable` the new unit until it has proven itself; disable the old one at the same time (`systemctl --user disable pi-telegram.service`,
`systemctl --user enable pi-manager.service`).

Check, in this order:
1. The container reaches the gateway: `docker exec pi-demo node -e "fetch(process.env.MANAGER_GATEWAY_URL+'/healthz').then(r=>console.log(r.status))"` prints 200.
   If not, the host firewall is the usual cause (ufw denies incoming by default). The one rule needed, scoped to the Pi compose
   network and the gateway address only: `sudo ufw allow from 172.18.0.0/16 to 172.18.0.1 port 7079 proto tcp comment 'Manager gateway: Pi compose network only'`.
2. In Telegram: `/status`, `/agents` (lists the catalog), then ask "which agents can review code?" (uses `somework_catalog`: proves the extension loaded).
3. `/ask reviewer what can you do?`: the answer must arrive in Telegram. Ask an agent for something that runs as a job (for example
   `/ask qa verify ABC-123`): the result arrives in the same conversation when the job ends, and a job started by an event or another agent
   produces the one-line "finished" message. A step that needs approval produces a question with `/chatapprove <id>` and `/chatdeny <id>`.
4. `docker inspect pi-demo` must show no SomeWork key mounted; `ls ~/.pi/agent` must not contain `manager.key.json` or the gateway token.

## 4. Setup from Operations (ADR 0004)
Operations (the fleet console) sends the Manager its setup the way it sends it to every agent: a signed `chat.notice` from the service
principal `operations` with the document as an artifact. The Manager's key needs one more permission, `artifact.read` (to download the document),
next to `message.read` (it receives the message) and `message.send` (it answers with the acknowledgement; check that the domain lets it address the
service principal `operations`). Add it with the same `PATCH` as in section 1, which replaces the whole set:
`{"permissions": {"actions": ["catalog.read","message.send","message.read","artifact.read","ops.read","rules.control"], "classificationMax": "internal"}}`.
Check, once Operations sends its first document:
1. `journalctl --user -u pi-manager.service | grep setup_` shows `setup_applied {"kind":"override","revision":N}` (or `setup_rejected` with the
   reason, or `setup_ignored` for a sender other than `operations`).
2. `curl -s http://127.0.0.1:7080/profile` shows `setup.override.revision` equal to N. Operations polls this URL (`MANAGER_HEALTH_PORT`, default 7080,
   bound to `MANAGER_HEALTH_BIND`, default all interfaces; nothing secret is in it). It needs the same kind of firewall rule as the agents' health ports:
   `sudo ufw allow from <Operations host> to any port 7080 proto tcp comment 'Manager profile: Operations only'`.
3. `ls ~/.pi/agent/mcp.json ~/.pi/agent/skills/library` shows what the document put there.

The documents are kept in `~/.config/agent-cluster-telegram/setup/` (`override.json`, `limits.json`, `status.json`, mode 0600, no secret in any of
them) and are put to work again at every start. MCP secrets are environment variables of the Manager's process: add the variables an operator may
name to `manager.env` (a document that names one that is missing is rejected, and says which). They reach Pi's container by name
(`docker compose run -e NAME`); the values are never written to `mcp.json`, which holds `${NAME}` references that Pi expands. Because Pi expands them
in its own process, the model's shell in the container can read them too: give an MCP server a token that is scoped to what the Manager may do.

## Upgrading Pi to 1.1.0 (before the Manager can take MCP servers)
The Manager's setup needs Pi 1.1.0 (the first release with an MCP client; the pilot ran 0.87.1). The Pi version of the `pi-demo` container is not pinned
in this repository: it comes from the image built from `~/agent-cluster-pi` on VM102 (`compose.pi.yaml`, outside the repository). Pin it there to
`@earendil-works/pi-coding-agent@1.1.0` (the Dockerfile's install line or the compose build argument it uses) and rebuild; the repository records the
expected release in `src/pi-version.ts`.

Test the upgrade before cutting over, without touching `pi-demo` or `~/.pi/agent` (the script uses a scratch agent folder):
```bash
# on VM102, with the new Pi installed next to the old one (for example npm i --prefix ~/pi-1.1.0 @earendil-works/pi-coding-agent@1.1.0)
PI=~/pi-1.1.0/node_modules/.bin/pi ~/somework-manager/adapters/manager/deploy/verify-pi-1.1.0.sh
```
It checks `pi --version` is 1.1.0 and that `pi mcp list` connects to a harmless stdio MCP server from an `mcp.json` and lists its tool. Then:
```bash
docker compose -f ~/agent-cluster-pi/compose.pi.yaml build pi          # with the pin changed
systemctl --user restart pi-manager.service                            # the unit starts the container from the new image
```
`/status` in Telegram shows the model; the Pi session (`state.sessionPath`) carries over. Roll back by pinning 0.87.1 again; the setup files stay
valid but MCP servers and the `mcp.json` are then ignored by the old Pi.

## Rollback
```bash
systemctl --user stop pi-manager.service && systemctl --user disable pi-manager.service
systemctl --user start pi-telegram.service && systemctl --user enable pi-telegram.service
```
The old bridge works on the same `state.json`. To remove the identity: `ops admin ... set-agent-status --id agent/manager --status disabled`.

## Notes
* The gateway binds only to the compose network's gateway address, never `0.0.0.0`. Anything on that network (the Pi container, and
  whatever the model runs inside it) can reach it, which is why it needs the bearer token and why every rule lives in the gateway.
* The Pi container still has a shell and the workspace; it holds no SomeWork credential, only the gateway token. A prompt-injected model
  can do what the gateway allows, which for writes means asking the owner.

# Rolling out the Manager on VM102 (replacing `pi-telegram.service`)

Nothing here has been deployed. The old bridge (`~/agent-cluster-pi/telegram-bridge.mjs`, `pi-telegram.service`) stays untouched so
that rollback is one command. The new unit `Conflicts=` with it, because both start the container named `pi-demo`.

The Manager reuses the paired Telegram owner, the bot token and the Pi session of the old bridge (`~/.config/agent-cluster-telegram/`:
`bot-token`, `state.json`). The state file gains a `tasks` key; the old bridge ignores it.

## 1. Identity on the domain
No capability card: the Manager is a requester and a chat participant, it claims no tasks. Other agents can message it by id; add a card
later only if it should show up in the catalog.

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
`--side-effects write` lets it submit tasks for `write` capabilities (the gateway still asks the owner first). It cannot submit
`irreversible` ones. `--may-invoke` takes capability id globs; start with `code.*` and widen with `set-agent-permissions` as needed.

## 2. Files on VM102
```bash
mkdir -p ~/somework-manager/{adapters,sdk}
# from the repository root on the workstation:
rsync -a --exclude node_modules adapters/manager ~/somework-manager/adapters/    # target: agent-host:somework-manager/adapters/
rsync -a --exclude node_modules sdk/typescript   ~/somework-manager/sdk/
# on VM102 (Node 22.22 is installed):
(cd ~/somework-manager/sdk/typescript && npm ci) && (cd ~/somework-manager/adapters/manager && npm ci)
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
   If not, check the host firewall for the Pi compose network to the gateway address and port.
2. In Telegram: `/status`, `/agents` (lists the catalog), then ask "which agents can review code?" (uses `somework_catalog`: proves the extension loaded).
3. Ask it to run something read-only, then something that writes: the approval prompt must arrive and nothing may exist in the domain
   until `/approve`.
4. `docker inspect pi-demo` must show no SomeWork key mounted; `ls ~/.pi/agent` must not contain `manager.key.json` or the gateway token.

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

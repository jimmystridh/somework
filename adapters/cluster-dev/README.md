# Cluster development agent (`agent/cluster-dev`)

An agent that does the work a developer does in this cluster: reads logs and metrics, finds causes, changes the Manager's and the other agents' code, runs
the tests, pushes to the organisation repository, deploys through the CI and checks afterwards. **It asks the owner only before destructive actions;**
everything else it does on its own and reports afterwards. The decision is `docs/CLUSTER_DEV_AGENT.md`; this directory is a card, a profile, hooks, a
classifier of destructive commands, five host-side tools and the deployment files, on top of `@somework/agent-kit`.

```
owner ── Telegram ──► conversation run (model) ──► read / write / edit / bash          in the sandbox: no secrets, no way into the cluster
                              │                      │  bash: every command goes through the classifier first
                              │                      ▼
                              ├───────────► host_exec ──► ssh (its own key per host)   runs in the service
                              ├───────────► git_push  ──► the organisation repository  (never origin, never force)
                              ├───────────► ci_pipelines · ci_logs ──► Woodpecker       (read only)
                              ├───────────► deploy_status ──► /ready /status /profile of every agent
                              └───────────► the kit's observe tools: logs, metrics, alerts of the whole fleet

   destructive?  classifier says yes ──► approval gate ──► Telegram: the exact command and why ──► approve | deny (silence is a denial)
```

## What needs the owner is code, not a sentence in the prompt

`classifyCommand(command, context)` in `src/classifier/` returns `{destructive, reason?, category?, forbidden?}` for a shell command. It reads the command the way a
shell does (quotes, escapes, `$(...)`, backticks, subshells, braces, `if`/`for`/`while`/`case`, functions, here-documents, here-strings, ANSI-C strings,
variables set earlier in the line, `cd`) and judges **every command it would run**, including what runs inside `sudo`, `env`, `nohup`, `timeout`, `xargs`,
`find -exec`, `bash -c`, `eval`, `ssh host '...'`, `docker exec` and `su -c`. The prompt only describes it.

It errs towards asking: a command runs unattended only if the classifier knows the program to be harmless with the arguments given. A program it does not
know, a command name or path computed when the command runs, and text it cannot read are destructive.

| Category | Destructive (asks the owner) | Allowed unattended |
|---|---|---|
| `data` | `rm`, `mv`, `cp`, `tee`, `>`, `>>`, `dd`, `sed -i`, `tar -x`, `chmod -R` and friends **outside the agent's workspace** (everything, on a cluster machine); `find -delete`, `xargs rm`, `rsync --delete`; `mkfs`, `fdisk`, `wipefs`, LVM, `fsck`; `docker rm`, `rmi`, any `prune`, `volume rm`, `compose down -v`, `up -V`, `--remove-orphans`, `docker cp` into a container; SQL `DROP`, `DELETE`, `TRUNCATE`, `UPDATE`, `INSERT`, `ALTER`, restores, `redis-cli flush*`/`del`/`set`, Mongo `drop`/`delete*`; `curl -X POST/PUT/DELETE`, `-d`, `-F`; `journalctl --vacuum` | the same inside the workspace (and `/tmp`); `SELECT`/`SHOW`/`EXPLAIN`; `curl` and `wget` GET |
| `secrets` | any command naming key or token material (`id_rsa`, `*.pem`, `*.key`, `secrets/`, `/run/secrets`, `.env` and `.env.*` but not `.env.example`, `auth.json`, `.ssh`, `.aws`, `.kube`, `.netrc`, `/etc/shadow`, `/proc/*/environ`, `*-token`); `printenv`, `env`, `export -p`, `set`, `history`, `ps e`, `jq env`, `docker inspect` without a format that avoids `Env`, `docker compose config`; expanding `$GIT_TOKEN`-like variables; a token, key, bearer header or URL password in the command line; `curl -u`/`-H Authorization`; `op`, `pass`, `gpg`, `age`, `sops`, `vault`, `ssh-keygen`, `ssh-add`, `openssl genrsa/rand/rsa/...`, `gh auth`/`secret`, `npm login`/`config`, `git credential`; searching for key material; recursive search of `/`, `~`, `/etc` | looking at the **names** of such files (`ls`, `stat`, `test -f`, `find -name`), `.env.example`, ordinary words such as `token` in a search of source code |
| `hypervisor` | **every** command on a host named `pve-host`, `proxmox`, `pve*` or listed in `CLUSTER_DEV_HYPERVISOR_HOSTS` (by name or address), however harmless; `qm`, `pct`, `pvesm`, `pvesh`, `zfs`, `zpool`, `vzdump` anywhere; the Proxmox API (`:8006`, `/api2/`); `ssh`, `scp`, `rsync`, `docker -H` to it | nothing |
| `firewall` | `iptables`/`ip6tables`/`nft`/`ufw`/`firewall-cmd`/`netsh`/`pfctl`/`ipset` changes anywhere, `*NetFirewall*` cmdlets, any script whose name says firewall (`agent-health-firewall.sh`); the same run through `sudo`, `ssh`, `bash -c` | listing the rules (`iptables -L/-S`, `ufw status`, `nft list`, `firewall-cmd --list-*`) |
| `git` | `push --force`/`-f`/`--force-with-lease`/`+ref`/`:ref`/`--delete`/`--mirror`/`--prune`; `reset --hard`, `clean -f`, `rebase`, `commit --amend`, `filter-branch`, `checkout -- <path>`, `restore`, `branch -d/-D/-m`, `tag -d/-f`, `stash drop/clear`, `reflog expire`, `gc --prune`, `worktree remove`; any change to a repository outside the workspace or on a cluster machine | `status`, `log`, `diff`, `show`, `fetch`, `pull`, `add`, `commit`, `switch -c`, `merge`, `cherry-pick`, `branch <name>`, `tag <name>`, `stash`, `push <org remote> <ref>` |
| `download` | `curl`/`wget` piped into `sh`, `bash`, `python`, `node`, `perl`, `sudo bash`, also through `tee`, `base64 -d`, `gunzip`, `sh -c "$(curl ...)"`, `bash <(curl ...)`, `source <(curl ...)`, `eval "$(curl ...)"`, download then run the file; `npx` of an uninstalled package | `curl ... | jq`, `curl -o file` |
| `system` | `systemctl` start/stop/restart/enable/mask/daemon-reload of a unit that is not in `CLUSTER_DEV_OWN_SERVICES`, `service`, `reboot`, `shutdown`, accounts, `apt`/`dpkg` changes, `mount`, `sysctl -w`, `crontab`, `kill`/`pkill` on a machine, `ip` and `nmcli` changes, `sudo -i`, `nsenter`, `chroot`, `docker run` with `-v`, `--privileged`, `--network host` | `systemctl status`, `journalctl`, `ps`, `df`, `free`, `docker ps`, `docker logs`, `docker compose up -d`/`restart`/`ps`/`logs`/`pull`/`build`, `deploy/agents/roll-agent.sh` and `deploy-from-ci.sh`, `npm test`, `node --test`, `cargo test` |
| `unknown` | a program the classifier does not know, a computed command name, a script file on a cluster machine (other than the deploy scripts), `bash` reading a script from stdin, text it cannot parse, anything nested too deep | the developer's loop in the workspace |

Two things are deliberately **not** asked about, because they cannot sweep up secrets:
* **A contained search.** `rg`, `ag`, `ack` and `grep -r` run unattended on named project directories (absolute or under `~`, below a home directory, `/srv`,
  `/opt`, `/tmp`, `/workspace` or `/var/log`; not a home directory itself, not a hidden one, not `.`) when every pattern is specific (at least four characters
  that are not regex syntax) and does not look for secrets (token, secret, password, credential, key, auth, ...), and nothing dumps whole files (`-v`,
  `--passthru`, `--hidden`, `-u`, `-f`, a context of more than 5 lines). What such a search prints is lines that match a pattern about code, and the service
  scrubs the secrets it holds from every answer. Anything else is judged as the table says.
* **Interpreter code in the sandbox.** `python -c`, `node -e`, heredocs into an interpreter and the like are the developer's own loop in the sandbox, which holds
  no secret and has no way into the cluster. On a cluster machine the same code is judged by what it reaches (files it removes or writes, commands it runs, the
  environment). A program read from standard input that the classifier cannot see is still asked about, and so is any argument that names secret material.

`forbidden` is the one thing that is not even asked about: **`git push` anywhere but the organisation remote** (`CLUSTER_DEV_GIT_REMOTE`, default `org`, and the
repositories the deployment lists in `CLUSTER_DEV_EXTRA_REPOSITORIES`; `origin` is refused at startup as either). It wins over every other finding in the same command.

How it is enforced, in three layers that do not trust each other:
1. **The approval gate** (`profile.toolApprovals`): `bash` and `host_exec` call the classifier; a destructive command waits for a person, with the exact
   command, the category and the reason in the question. `read`, `write` and `edit` ask for files that hold secrets. Only people may answer
   (`chat.approvers: ["kind:human"]`); an agent cannot approve. Silence is a denial.
2. **The guard** (`src/approvals.ts`, a Pi `beforeTool` hook): stops what a gate can only ask about, a forbidden push and a destructive command too long
   to show the owner in full (`MAX_CONFIRMABLE_COMMAND`, 600 characters), before anybody is asked.
3. **The tool itself**: `host_exec` classifies again and reads the gate's answer for *this call id* from the runtime's memo (`approval:<call id>`); a destructive
   command runs only if that answer is `approved`, so removing the gate removes nothing: it fails closed.

## The tools (in the service, where the keys are; the model never sees one)

| Tool | What it does |
|---|---|
| `host_exec` | `ssh` to a host named in `CLUSTER_DEV_HOSTS` with its own key `<CLUSTER_DEV_SSH_KEY_DIR>/<name>`; fixed options (`BatchMode`, `IdentitiesOnly`, `IdentityAgent=none`, `StrictHostKeyChecking=yes`, `ClearAllForwardings=yes`, no agent, no X11), the command after `--`; time limit (default 120 s, at most 900), output cap (default 32 KiB, at most 256 KiB) keeping the end, scrubbed of secrets, framed as untrusted data |
| `git_push` | pushes `<branch>:refs/heads/<to>` of a checkout in the workspace to `CLUSTER_DEV_REPOSITORY`: the address is from the settings (the model cannot name another), never `+`, never a deletion, no tags, hooks off, the token handed to the credential helper of that one command through its environment |
| `ci_pipelines`, `ci_logs` | Woodpecker REST, GET only, one origin, no redirects, token from `CI_TOKEN_FILE`: recent pipelines, one pipeline's steps, the last lines of a step's log |
| `deploy_status` | `/ready`, `/status` and `/profile` of each agent in `CLUSTER_DEV_AGENT_URLS`: ready or not, the image tag and the git commit it runs from (`ci-<sha>`), a summary of the status; `expect` compares with the commit a deploy should have put there |
| observe tools | the kit's `logs_query`, `metrics_query`, `metrics_catalog`, `logs_labels`, `alerts_status`, `dashboards_search`, `llm_usage` with fleet scope (`OBSERVE_SCOPE=fleet`, the role's default) |

Secrets are taken out of every answer by `scrub` (the exact values of the key files, the CI and git tokens, token-shaped strings, `NAME=value` pairs whose
name says secret, URL passwords, authorization headers, private key blocks). Answers from outside are framed as data between random markers.

Jobs: `code.cluster` v1 (`card.json`) is the longer change as a pull request: the kit clones the one configured repository into the sandbox, the model works there,
the service pushes `cluster/<job>` and opens the pull request. It does not merge or deploy.

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `CLUSTER_DEV_REPOSITORY` | none | the one repository (https URL): jobs and `git_push` accept no other; also `CHAT_REPOSITORY_URL` and the read-only checkout |
| `CLUSTER_DEV_ASK_IN_SANDBOX` | off | `1`: the sandbox's own commands and files are judged and asked about too, as on a machine. Off: nothing in the sandbox is asked (it holds no secret and has no way into the cluster), except the one thing that is never allowed (a push anywhere but the repositories listed) |
| `CLUSTER_DEV_GIT_REMOTE` | `org` | the git remote that may be pushed to; `origin` is refused |
| `CLUSTER_DEV_EXTRA_REPOSITORIES` | none | `name=https://host/owner/repository`, comma separated: more repositories `git_push` may push to (its `repository` argument names one). Each is also an allowed remote name for the classifier; `origin` is refused. Each has its own credential, `<CLUSTER_DEV_GIT_TOKEN_DIR>/git-token-<name>`, because a fine-grained token belongs to one owner |
| `CLUSTER_DEV_GIT_TOKEN_DIR` | `/run/secrets/git` | the directory holding those credential files |
| `CLUSTER_DEV_HOSTS` | none | `name=user@address[:port]`, comma separated: the machines `host_exec` may use |
| `CLUSTER_DEV_SSH_KEY_DIR` | `/run/secrets/ssh` | one private key per host, named like the host; `CLUSTER_DEV_SSH_KNOWN_HOSTS` defaults to `<dir>/known_hosts` |
| `CLUSTER_DEV_HYPERVISOR_HOSTS` | `pve-host,proxmox,pve` | names and addresses of the hypervisor (anything on it asks) |
| `CLUSTER_DEV_OWN_SERVICES` | none | systemd units it may restart without asking (patterns with `*`) |
| `CLUSTER_DEV_SCRIPTS` | `roll-agent.sh`, `deploy-from-ci.sh` | repository scripts (path suffixes) that may run on any host |
| `CLUSTER_DEV_WORKSPACES` | `/workspace,/tmp` | the directories that are the agent's own in its sandbox |
| `CLUSTER_DEV_EXEC_TIMEOUT_SECONDS`, `CLUSTER_DEV_EXEC_MAX_BYTES` | 120, 32768 | limits of `host_exec` (hard caps 900 and 262144) |
| `CLUSTER_DEV_AGENT_URLS` | none | `name=http://address:port` health ports for `deploy_status`; `CLUSTER_DEV_AGENTS_CA_FILE` for a private CA |
| `CI_URL`, `CI_REPO`, `CI_TOKEN_FILE`, `CI_CA_FILE` | none | Woodpecker; `CI_REPO` is `owner/name` or the numeric id |
| `GIT_TOKEN_FILE` (or a GitHub App), `GRAFANA_URL`, `GRAFANA_TOKEN_FILE`, `OBSERVE_ENABLED`, `TELEGRAM_BOT_TOKEN_FILE`, `TELEGRAM_ALLOWED_USER_IDS` | | the kit's own, see `packages/agent-kit/README.md` |

The service fails at start, not at the first command, for a malformed setting, `PI_CONCURRENCY` other than 1, a host without a key file, a missing
`known_hosts`, or a CI address without a token file.

## Tests

`npm test` in this directory (`node --test`, Node type stripping, no build). `test/classifier*.test.ts` are the specification of the rules above (about 800 commands, and
every dangerous command again in 50 ways of writing it: subshells, loops, `sudo`, `ssh`, `bash -c`, here-documents, command substitution, ...); `test/gate.test.ts` runs the
real runtime with the role's policy, tools and guard and a scripted model to show that a denied command does not run, an approved one does, a forbidden one never asks, and that
a missing gate fails closed; `test/job.test.ts` runs the kit's job handler with the role's hooks against a local bare repository. No test touches a host, GitHub, Telegram,
Proxmox or any account: ssh, HTTP and the tokens are fakes. Two tests (`card.test.ts`, `process.test.ts`) start a real domain and, for the second, the service process and a sandbox
daemon on loopback; they need `SOMEWORK_BIN` (a fresh debug build of the domain, never `dist/somework`) and are skipped without it. In the process test `ssh` is not on the PATH.

## Not done here

* The Manager's Operations calls (the `operations` tool of the decision) and a Proxmox API tool.
* A Rust toolchain in the sandbox image, so `cargo test` cannot run there yet.

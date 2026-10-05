# Rolling out the Windows developer

Nothing here has been run on the machine yet. Every command is PowerShell 5.1 (the default SSH shell of Windows has **no** `&&` or `||`;
chain with `;`, or put the steps in a script file and run it with `-File`: piping a multi-line script to `powershell -Command -` over SSH
is unreliable). Paths below are the defaults of `install-service.ps1`; change them with its parameters.

## 0. What the machine needs
* Windows 10/11 x64 (or a server edition), Git for Windows, and the **official** Node.js build, 22.19 or newer, in `C:\Program Files\nodejs`
  (check: `node -p "process.version + ' ' + process.features.typescript"` must print `strip`; distro builds of Node can lack TypeScript support).
* Whatever your build and test profiles run (compilers, SDKs, feeds). Restoring packages needs a credential: do not put it in
  `profiles.json` or `agent.env`. Either build against packages that are already restored, or let your own build script find a read-only
  credential that is stored for the *service account* (a credential stored for another user is not readable by it, by design).
* Network reach from the machine to the domain, the model API, the git host and the package feeds.

## 1. Profiles and settings (on your workstation)
1. `deploy\profiles.example.json` -> `profiles.json`: replace the placeholder commands with the real build and test commands (they run
   through bash in the task workspace) and set `encoding.legacyGlobs` for the file types that must stay in the legacy encoding.
2. `deploy\agent.env.example` -> `agent.env`: the URL of the domain and the paths. No secrets in it.
3. `deploy\firewall-allow.example.txt` -> `firewall-allow.txt`: the destinations the account may reach (host names are fine).

## 2. Install (elevated, on the machine)
Copy the repository tree (or a checkout of it) and the three files to the machine, then:
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File C:\src\somework\adapters\windows-developer\deploy\install-service.ps1 `
  -SourcePath C:\src\somework -EnvFile C:\src\agent.env -ProfilesFile C:\src\profiles.json
```
It creates the local account `svc-somework` (not an administrator; denied interactive, remote-desktop and network logon; allowed batch
logon; a fresh random password every run, never written to disk, held by the Task Scheduler), the directories
`C:\somework\{agent,workspaces,state,logs,secrets}` with these permissions: code `RX`, workspaces/state/logs `M`, secrets `R` for the
account, full control for Administrators and SYSTEM only; the code with `npm ci --omit=dev --ignore-scripts` from the lockfile; and the
scheduled task `SomeWorkWindowsDeveloper` (at boot, as that account, with `run-agent.ps1` as supervisor). It does not start it unless you pass `-Start`.

## 3. Identity, model login, git token
**Identity.** Generate the key on the machine so the private key never travels (run in the secrets directory's owner context, elevated):
```powershell
node C:\somework\agent\adapters\windows-developer\deploy\keygen.ts --id agent/windows-developer --domain development --out C:\somework\secrets\agent.key.json
```
It prints the public key. On the domain host (where `ops` is the one-off admin container of the domain's runbook):
```bash
ops admin --config /etc/somework/somework.toml enroll-agent --id agent/windows-developer --public-key '<publicKey>' --side-effects write
```
Then register the card (`card.json` with its `agentId`; keep it where `ops` can read it) and approve it:
```bash
ops admin --config /etc/somework/somework.toml register-card --card /cards/windows-developer.json --approve
```
Copy the domain's CA certificate to `C:\somework\secrets\ca.pem` (the account reads it; `SOMEWORK_REQUIRE_TLS=1`).

**Model login.** The agent needs its **own** login: model refresh tokens rotate on use, so a login shared with another agent or a person
breaks one of them. Do the device-code login for this agent (`node node_modules\@earendil-works\pi-ai\dist\cli.js login openai-codex`
in the install directory, approve the code in a browser anywhere) and put the resulting `auth.json` at `C:\somework\state\auth.json`
(the account has write access there: the service rewrites it when a token refreshes). Give it only the providers it should use.

**Git token.** A fine-grained token for **one** repository with Contents and Pull requests write, in `C:\somework\secrets\git-token` (no
quotes, the trailing newline does not matter). `GIT_TOKEN_HOSTS=github.com` is the only place the service will ever send it. Draft pull
requests stay on (`GIT_PR_DRAFT=1`).

## 4. Network allow-list
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File C:\somework\agent\adapters\windows-developer\deploy\firewall.ps1 -AllowFile C:\somework\agent\firewall-allow.txt -RegisterRefreshTask
```
`-DryRun` prints the rules without installing them, `-SelfTest` checks the range arithmetic. What this is and is not: Windows Firewall
blocks beat allows, so the script computes the complement of your allowed IPv4 addresses and blocks that **for the service account only**
(plus all IPv6). It matches addresses, not names: a host behind a shared CDN address admits every site on that address. Addresses
change, so the refresh task re-resolves the names every 30 minutes (until the next run the old addresses stay allowed and new ones
blocked, so a long outage of name resolution can break a job, not weaken the rules). Other accounts are untouched. An administrator can
change the rules. If you need a tighter boundary than this, run the role in a throwaway VM or a Windows container.

## 5. Smoke test, start, verify
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File C:\somework\agent\adapters\windows-developer\deploy\smoke.ps1
```
It runs seven checks in a temporary directory (node and Git Bash, the environment commands see, refusal of paths outside the root
including a junction and the Windows-only forms, timeout with process-tree kill, a legacy-encoded file edit that must pass and its
UTF-8 rewrite that must be blocked, log redaction) and prints `PASS:`/`FAIL:` lines; exit code 1 means a failure. Then:
```powershell
Start-ScheduledTask -TaskName SomeWorkWindowsDeveloper
Get-Content C:\somework\logs\supervisor.log -Tail 5
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8081/ready | Select-Object -ExpandProperty Content
```
and submit a small `code.windows` task against a scratch repository: the SDK's `submitTask({ capability: { id: "code.windows", version: "1" }, input })` with the input described in `README.md` (`build: {name}` and `tests` optional).

## Operations
* **Logs**: `C:\somework\logs\supervisor.log`, per run `agent-<stamp>.jsonl` (the agent's JSON log, stderr) and `.out.log`; kept two weeks.
  Ship them like any other file (the Alloy/Loki setup of the Linux hosts works with `loki.source.file`).
* **Update**: copy the new tree and run `install-service.ps1` again (it keeps `agent.env` and `profiles.json` unless you pass new ones,
  rotates the account password, re-registers the task). `Stop-ScheduledTask` first if jobs are running; a running job detaches and resumes
  after the restart (the kit's behaviour).
* **Stop**: `Stop-ScheduledTask -TaskName SomeWorkWindowsDeveloper` ends the supervisor and the agent. To keep the supervisor from
  restarting it, create `C:\somework\agent\STOP` first.
* **Rotate the key**: stop the task, `keygen.ts` to a new file, `somework admin rotate-agent-key --id agent/windows-developer --public-key ...`
  on the domain host, swap the file, start.
* **Metrics** are on `127.0.0.1:8081/metrics` (`somework_pi_*`); a blocked run is counted under `unanswered`, then reported as `blocked`.

## Rollback and removal
```powershell
Stop-ScheduledTask -TaskName SomeWorkWindowsDeveloper
powershell -NoProfile -ExecutionPolicy Bypass -File C:\somework\agent\adapters\windows-developer\deploy\uninstall.ps1                          # task + firewall rules
powershell -NoProfile -ExecutionPolicy Bypass -File C:\somework\agent\adapters\windows-developer\deploy\uninstall.ps1 -RemoveUser -RemoveInstall -RemoveData   # everything
```
On the domain host: `set-agent-status --id agent/windows-developer --status disabled` removes it from the catalog's reach. Nothing
else on the machine is changed by the install except the account, its user-rights entries, the firewall rules and the two scheduled tasks.

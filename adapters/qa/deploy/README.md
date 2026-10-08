# Rolling out the QA agent

First rolled out 2026-10-06 (smoke 6/6 as the service account, a skipped-verdict task end to end, the `qa-on-ticket` reaction waiting for approval); the section "Found on the first rollout" lists what the steps below did not say. Every command is PowerShell 5.1 (the default
SSH shell of Windows has **no** `&&` or `||`; chain with `;`, or put the steps in a script file and run it with `-File`). Paths below are
the defaults of `install-service.ps1`; change them with its parameters. The account is `svc-qa`, the task `SomeWorkQa`, the health port
8082, so the QA agent and the Windows developer can live side by side on one machine, though a machine of its own is the intended setup.

## 0. What the machine needs
* Windows 10/11 x64 (or a server edition), Git for Windows, **Microsoft Edge** (it ships with Windows 10/11; Playwright drives the installed
  one, no browser is downloaded) and the **official** Node.js build, 22.19 or newer, in `C:\Program Files\nodejs`
  (check: `node -p "process.version + ' ' + process.features.typescript"` must print `strip`).
* Whatever the application under test needs to run in local mode (its runtime, its local back end or database). The application must be
  startable from a bash command (see `profiles.example.json`) and must not need an identity provider.
* Network reach from the machine to the domain, the model API, the git host, the ticket system and the application's package feeds.

## 1. Profiles and settings (on your workstation)
1. `deploy\profiles.example.json` -> `profiles.json`: the real start command, health URLs, stop command, environment and startup time of
   the application (see "Application profiles" in `../README.md`).
2. `deploy\agent.env.example` -> `agent.env`: URL of the domain, paths, `QA_TICKET_PATTERN` (narrow it), the ticket system's URL.
   No secrets in it.
3. `deploy\firewall-allow.example.txt` -> `firewall-allow.txt`: the destinations the account may reach (host names are fine). Loopback is
   always allowed. The ticket system's host must be in the list or no ticket tool can work.
4. Optional: the skill overlay (`deploy\overlay.example.md` shows the shape) as `qa.md`, and `SKILLS_ALLOW` naming the repository's QA skill.
   Keep company-specific text in the overlay on the workstation, not in this repository.

## 2. Install (elevated, on the machine)
Copy the repository tree (or a checkout of it) and the files to the machine, then:
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File C:\src\somework\adapters\qa\deploy\install-service.ps1 `
  -SourcePath C:\src\somework -EnvFile C:\src\agent.env -ProfilesFile C:\src\profiles.json -OverlayFile C:\src\qa.md
```
It creates the local account `svc-qa` (not an administrator; denied interactive, remote-desktop and network logon; allowed batch logon; a
fresh random password every run, never written to disk, held by the Task Scheduler), the directories
`C:\somework\{agent,workspaces,state,logs,secrets}` with these permissions: code `RX`, workspaces/state/logs `M`, secrets `R` for the
account, full control for Administrators and SYSTEM only; the code with `npm ci --omit=dev --ignore-scripts` from the lockfile (this
installs `playwright-core`, which has no install script and downloads nothing); and the scheduled task `SomeWorkQa` (at boot, as that
account, with `run-agent.ps1` as supervisor). It does not start it unless you pass `-Start`.

## 3. Identity, model login, git token, ticket system
**Identity.** Generate the key on the machine so the private key never travels:
```powershell
node C:\somework\agent\adapters\qa\deploy\keygen.ts --id agent/qa --domain development --out C:\somework\secrets\agent.key.json
```
It prints the public key. On the domain host (where `ops` is the one-off admin container of the domain's runbook):
```bash
ops admin --config /etc/somework/somework.toml enroll-agent --id agent/qa --public-key '<publicKey>' --side-effects write
ops admin --config /etc/somework/somework.toml register-card --card /cards/qa.json --approve
```
(`card.json` is the card; keep a copy where `ops` can read it.) The agent that is allowed to submit `qa.verify` tasks needs
`--may-invoke qa.*` (or that capability) on its own enrolment. Copy the domain's CA certificate to `C:\somework\secrets\ca.pem`.

**Model login.** The agent needs its **own** login (model refresh tokens rotate on use, so a login shared with another agent or a person
breaks one of them): device-code login for this agent (`node node_modules\@earendil-works\pi-ai\dist\cli.js login openai-codex` in the
install directory, approve the code in a browser anywhere) and put the resulting `auth.json` at `C:\somework\state\auth.json`.

**Git token.** Needed only when the repository under test is private: a fine-grained token for that repository with read access
(Contents), in `C:\somework\secrets\git-token`. `GIT_TOKEN_HOSTS` is the only place the service will send it. Without it, leave
`GIT_TOKEN_FILE` out of `agent.env`.

**Mirror and PATH.** For a large repository set `GIT_MIRROR_DIR`, `GIT_MIRROR_REPOS` and `GIT_MIRROR_REFRESH_MINUTES` (see `agent.env.example`): the kit keeps a bare mirror on the data volume and each task clones from it instead of downloading the repository again (the first refresh takes as long as one full clone). A profile's start and stop commands run in Git Bash with `WINDOWS_PATH_DIRS` as the whole `PATH`; if they call `powershell.exe`, that list must include `C:\Windows\System32\WindowsPowerShell\v1.0` (a missing entry shows up as `powershell.exe: command not found`, exit 127).

**Ticket system.** Four files in `C:\somework\secrets`, readable by the account only (the install script's ACLs do that):
* `jira-token`: a personal access token of a user that may comment, label, attach, transition and assign on the project. Use a user of
  its own for the agent, so what the agent did is attributable.
* `jira-client.pfx` and `jira-client.pfx.password`: the client certificate, when the host demands mutual TLS (an empty password file for
  a certificate without a password).
* `jira-ca.pem`: only when the host's certificate is signed by a CA the machine does not trust.

The harness reads them once at startup, uses them only inside its HTTPS client and scrubs them from everything it reports.

## 4. Network allow-list
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File C:\somework\agent\adapters\qa\deploy\firewall.ps1 -AllowFile C:\somework\agent\firewall-allow.txt -RegisterRefreshTask
```
`-DryRun` prints the rules without installing them, `-SelfTest` checks the range arithmetic. Windows Firewall blocks beat allows, so the
script computes the complement of your allowed IPv4 addresses and blocks that **for the service account only** (plus all IPv6). It matches
addresses, not names: a host behind a shared CDN address admits every site on that address. The refresh task re-resolves the names every 30
minutes. Other accounts are untouched; an administrator can change the rules. The browser has a second, independent fence: it can only
open the hosts in `QA_BROWSER_ALLOW_HOSTS`.

## 5. Smoke test, start, verify
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File C:\somework\agent\adapters\qa\deploy\smoke.ps1
```
It checks, in a temporary directory: node and Git Bash, the environment commands see, refusal of paths outside the root, an application
profile starting and stopping a tiny page, **Edge driven headless by Playwright (fill, click by ref, screenshot, a real WebM video)**, and a
whole scripted verification through the kit's handler against a fake ticket system that demands a client certificate (that last check
needs `openssl`, which Git for Windows ships in `usr\bin`; without it the verification runs without the ticket system). It prints
`PASS:`/`FAIL:`/`INFO:` lines; exit code 1 means a failure. That run is in the context of whoever runs it. Whether Edge also starts for the
service account is what matters, and nobody can log on as that account, so `install-service.ps1 -SmokeAsService` runs the same smoke test
as `svc-qa` through a throwaway task (it prints the log and the task result, and removes the tasks again). Then:
```powershell
# the task belongs to the service account, so even an administrator gets 'Access is denied' from Start-ScheduledTask / schtasks /Run:
# start it as SYSTEM (a throwaway task) or reboot
schtasks /Create /TN SomeworkStartQa /SC ONCE /ST 23:59 /RL HIGHEST /RU SYSTEM /TR "schtasks /Run /TN SomeWorkQa" /F
schtasks /Run /TN SomeworkStartQa
Get-Content C:\somework\logs\supervisor.log -Tail 5
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8082/ready | Select-Object -ExpandProperty Content
```
`/ready` includes the application profiles and, with a ticket system, a real call to it (`/myself`), so a wrong certificate or token shows
up here. Then submit a first `qa.verify` task for a ticket on a practice setup, answer the approvals it asks for, and read the result and
the ticket.

## If it does not work
* **Edge does not start as the service account** (`install-service.ps1 -SmokeAsService` shows the exact error). Headless Edge needs a
  writable user-data location for the account; set `LOCALAPPDATA` and `TEMP` for the supervisor in `run-agent.ps1` (a directory below
  `C:\somework\state` is the natural place) if the account has no usable profile.
* **The application does not become healthy.** The job completes as `blocked` with the start log's tail in `notes`; run the profile's
  start command by hand through Git Bash as the service account to see it, and raise `startupTimeoutSeconds`.
* **A ticket tool is refused as "changed while it was being verified".** The ticket was not in `JIRA_TEST_STATUS` or was assigned when the
  write came; nothing was written. Check the status spelling of the workflow.
* **Processes left behind.** The sweep stops what the account started during the job; check `Get-Process -IncludeUserName` for `svc-qa`
  between jobs.

## Found on the first rollout
* **Video recording needs Playwright's own ffmpeg**, a ~0.1 MiB download that `npm ci` does not make (the smoke test fails on the WebM check without it):
  `$env:PLAYWRIGHT_BROWSERS_PATH='C:\somework\ms-playwright'; node C:\somework\agent\node_modules\playwright-core\cli.js install ffmpeg`, give the account `RX` on that
  folder and set `PLAYWRIGHT_BROWSERS_PATH` as a machine variable (a task started afterwards sees it), then run `install-service.ps1 -SmokeAsService` again.
* **A name in the firewall allow-list resolves to one pair of addresses per lookup, and big hosts rotate them** (GitHub answers .3 and .4 alternately, Cloudflare
  hosts rotate through ranges). The refresh task only ever sees the current answer, so a clone failed with "could not connect" while the other address was current.
  List the owner's published ranges as CIDR blocks next to the names (GitHub `140.82.112.0/20`, `185.199.108.0/22`, `192.30.252.0/22`; the Cloudflare ranges the model
  hosts use). `firewall-allow.example.txt` shows the shape.
* **Git for Windows checks certificate revocation through Schannel**, and the revocation servers are outside the allow-list: set
  `git config --system http.schannelCheckRevoke false` on the machine (Node's own TLS does not check revocation).
* **`setup\grant-control.ps1` (the local test stack of the application) needs `lib.ps1` beside it**: copy `C:\somework\qa-app\lib.ps1` into `setup\` first.
* **The ticket-key gate runs after the workspace is prepared**, so even a `skipped` verdict needs a repository the account can clone (a private repository needs the git
  token; an unreachable one fails the job as `job_error` before the gate).
* **A SQL Server restore reads the backup as the SQL service account**: copy the `.BAK` files into the instance's own `Backup` folder (not a user or `C:\somework` folder).
* **The status name is the workflow's**: `JIRA_TEST_STATUS` and the `qa-on-ticket` rule both use the status the ticket enters (`Test` in the pilot project, not `Testing`).
* **A new agent's NATS login only works after the broker reloads its user list**; if the log shows "NATS wake unavailable: Authorization Violation" long after the
  start, send the broker a reload (`docker kill -s HUP <broker container>`). Until then the agent polls over HTTP and still works.

## Operations
* **Logs**: `C:\somework\logs\supervisor.log`, per run `agent-<stamp>.jsonl` (the agent's JSON log, stderr) and `.out.log`; kept two weeks.
  Evidence (videos, screenshots) of a job is in `C:\somework\workspaces\.qa\<taskId>` until the workspaces are cleaned; what matters has
  been uploaded as task artifacts.
* **Update**: copy the new tree and run `install-service.ps1` again (it keeps `agent.env` and `profiles.json` unless you pass new ones,
  rotates the account password, re-registers the task). `Stop-ScheduledTask` first if a job is running; a running job detaches and
  resumes after the restart (the kit's behaviour).
* **Stop**: `Stop-ScheduledTask -TaskName SomeWorkQa`. To keep the supervisor from restarting it, create `C:\somework\agent\STOP` first.
* **Rotate the key**: stop the task, `keygen.ts` to a new file, `somework admin rotate-agent-key --id agent/qa --public-key ...` on the
  domain host, swap the file, start. **Rotate the ticket token** by replacing `jira-token` and restarting.
* **Metrics** are on `127.0.0.1:8082/metrics` (`somework_pi_*`); a blocked run is counted under `blocked`.

## Rollback and removal
```powershell
Stop-ScheduledTask -TaskName SomeWorkQa
powershell -NoProfile -ExecutionPolicy Bypass -File C:\somework\agent\adapters\qa\deploy\uninstall.ps1                          # task + firewall rules
powershell -NoProfile -ExecutionPolicy Bypass -File C:\somework\agent\adapters\qa\deploy\uninstall.ps1 -RemoveUser -RemoveInstall -RemoveData   # everything
```
On the domain host: `set-agent-status --id agent/qa --status disabled` removes it from the catalog's reach. Nothing else on the machine
is changed by the install except the account, its user-rights entries, the firewall rules and the two scheduled tasks.

## Budgets and the machine

One browser step re-reads the whole conversation (30k to 45k tokens), so a verification of about 90 steps takes 4M tokens: the chat budget and the `qa-on-ticket` rule both say 4M tokens and 60 minutes, `managed.env` sets the cap to 5M and the day's limit to 20M. The machine has two processors and 8 GB shared by SQL Server, the back end, the web dev server and the browser, which is why a click may take seconds, why a recording of fewer than 2 KB is refused as evidence, and why `start-app.ps1` starts a silent dev server again after 40 s (it hangs at its config step on about four starts in ten; a second start works). A failed start writes its diagnosis to `C:\somework\qa-app\control\last-start-failure.txt`.

## Companies that open

The master database lists 238 test companies but only the 29 with a shard number can be opened; the back end answers 428 for the rest, and an agent that chose one by the ticket's area reported `blocked`. `qa-app/hide-unusable-companies.ps1` (run once as SYSTEM, idempotent, `-Restore` undoes it) sets the status of the others to 0, which the back end filters out of the company picker, and keeps their old status in `dbo.QA_TENANT_STATUS_BACKUP`. Run it again after the databases are restored from backups.

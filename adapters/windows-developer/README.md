# Windows developer (`code.windows`)

The developer role for changes that have to build and run on Windows. It is the Linux developer's workflow (clone, branch
`agent/<taskId>`, edit, commit, push, pull request) on a Windows machine with the Windows toolchain, plus three things the Linux role
does not need:

* **a build and tests**, chosen by *name* from profiles the machine's owner configured, run after the model finished and before
  anything is pushed;
* **an encoding guard**: legacy source files (Windows-1252, CRLF) are easily damaged by tools that read and write UTF-8, so every
  modified file is compared with its base revision and a damaged file stops the push;
* **a local, confined execution environment**, because that machine has no container runtime.

Like every role it is a card, a profile and a `main.ts` on `@somework/agent-kit` (see `packages/agent-kit/README.md`); the pieces that
only exist because this is Windows are listed below.

## The contract (`card.json`)

```
code.windows@1   sideEffects: write   budget required
input   repository {url, ref}, instruction, budget {maxTokens, maxMinutes}, agentKey?, model?
        build?: { name }            one of the configured build profiles (no other key is accepted)
        tests?: [name, ...]         configured test profiles, run after the build, skipped when it failed
output  status: completed | no_changes | blocked, summary, branch?, commits?, prUrl?, usage
        build?: {name, ok, exitCode, durationMs, logArtifact?}      tests?: [... + skipped?]
        encoding: {ok, checked, violations[{file, reasons[]}]}      blocked?: [reason, ...]
```

`status: "blocked"` is a *completed* task: the work exists in the workspace, nothing was pushed, `blocked` says why (a blocking build or
test failed, or a file's encoding or line endings were damaged). The requester decides what to do next, for example a follow-up task with
the same `agentKey` that asks the agent to fix the build.

A job can never supply a command. `build: {name: "x", command: "..."}` is rejected twice: by the card's schema (the domain refuses the
submission) and by the role (`invalid_input`).

## How a job runs

```
claim (SDK worker) -> hooks.instruction: validate build/tests against the profiles, add service notes
  -> kit handler: budget, ledger, model allowlist, clone the ref (branch, tag, SHA, pull ref) and branch in the workspace
  -> Pi run (tools via the confined local environment)                      <- the model works here
  -> hooks.beforeFinalize: encoding check, then the build, then the tests   <- before anything is committed
        blocked?  -> the task completes as status "blocked"; no commit, no push
  -> kit handler: commit, push agent/<taskId>, pull request (hooks.pullRequest adds the check results)
  -> hooks.result: upload the logs as artifacts, add build/tests/encoding/baseSha to the result
```

| File | |
|---|---|
| `card.json`, `src/profile.ts`, `src/main.ts` | the role: contract, standing orders (the system prompt tells the model about encodings and CRLF), extra approval patterns for commands that change the machine, no default skills (the deployment names the repository's own skills with `SKILLS_ALLOW`; they are loaded at the task's ref by the kit; a deployment can replace the list with `SKILLS_ALLOW`) |
| `src/settings.ts` | this role's settings: the kit's `WINDOWS_*` machine settings plus `WINDOWS_PROFILES_FILE` |
| `src/profiles.ts`, `src/checks.ts` | build/test profiles and how they run; the encoding check over the modified files; log capture and redaction |
| `src/encoding.ts` | `checkEncodingPreserved(before, after)` (pure) |
| `src/role.ts` | the hooks described above (`createRole`) |
| `src/service.ts` | the settings and the hook factory handed to the kit's `runAgentService`, on top of `windowsExecutionHooks` |
| `@somework/agent-kit/windows` | the confined local environment this role runs in, shared with the QA role: path confinement (`resolveInside`, `ConfinedExecutionEnv`), Git Bash selection and the command environment, the sweep of the account's leftover processes, `redactLog`, the `WINDOWS_*` settings. Its documentation lives in the kit |
| `deploy/` | `install-service.ps1`, `run-agent.ps1`, `firewall.ps1`, `uninstall.ps1`, `smoke.ps1` + `smoke.ts`, `keygen.ts`, `agent.env.example`, `profiles.example.json`, `firewall-allow.example.txt`, `README.md` |

## The execution environment, and how far it can be trusted

The kit's other roles run tools in a container: no credentials, no route out except an allow-list proxy. This machine has no Docker, so
the model's tools and the kit's git steps run in the agent's own process tree on the host, as a dedicated unprivileged account. That is a
**weaker boundary**, and it is documented as one:

* **Enforced by the agent** (`ConfinedExecutionEnv`, in the kit): the file tools and git steps can only name paths inside the workspace root, by name
  (no `..`, UNC, `\\?\`, drive-relative paths, alternate data streams, trailing dots, device names, 8.3 short names, `~`, `file:`) and by
  real path (a junction or symbolic link that leads outside is refused, also for files that do not exist yet). Commands start in a
  confined directory with `inheritEnv: false`: they get a fixed `PATH`, a home and temp directory *inside* the root, and nothing from the
  service's environment (no tokens, no key paths). They are time-limited and output-capped, and a timeout or cancel kills the whole
  process tree (`taskkill /T /F`).
* **Not enforced by the agent**: a command is a program running as the service account. It can open whatever that account can open, and
  it can use the network the account can use. The boundary there is the account itself: a local, non-administrator account that may not
  log on interactively, remotely or over the network, with write access to the workspace, state and log directories only, read access
  to the code and secrets directory, and a Windows Firewall rule set that blocks all its outbound IPv4 except an allow-list (see
  `deploy/firewall.ps1` for what that can and cannot do: rules match addresses, not names).
* Anything that changes the machine rather than the checkout (registry, services, scheduled tasks, accounts, firewall, installers,
  encoded or download-and-run PowerShell, shutting down) waits for a human approval, on top of the kit's default patterns.
* The git token is only sent to the hosts in `GIT_TOKEN_HOSTS`; build and test logs are scrubbed of token-like strings and of the
  service's own secrets before they become artifacts.

If this role ever handles code that must not be able to reach the machine's other data, run it in a Windows container or a throwaway VM
instead (the `ExecutionEnv` is the only thing that would change).

## Settings

The kit's own settings apply (`SOMEWORK_*`, `PI_*`, `GIT_*`, `BUDGET_*`, `SKILLS_*`, see `packages/agent-kit/src/config.ts`);
`SANDBOX_URL` and `SANDBOX_WORKSPACES` are filled in by the role. Role-specific:

| Setting | |
|---|---|
| `WINDOWS_WORKSPACE_ROOT` | required, a drive-letter path, e.g. `C:/somework/workspaces`. Workspaces, `.tmp` and `.home` live below it |
| `WINDOWS_BASH` | Git for Windows' `bash.exe`; default: `Program Files\Git\bin\bash.exe` and two other usual places |
| `WINDOWS_PATH_DIRS` | `;`-separated PATH of every command; default Git for Windows, Node.js and the system directories |
| `WINDOWS_PASS_ENV` | names copied from the service's environment into commands (what the build tools need) |
| `WINDOWS_PROFILES_FILE` | the profiles file (see `deploy/profiles.example.json`) |
| `WINDOWS_MAX_OUTPUT_BYTES` | per-command output cap (default 8 MiB) |

Profiles file: `build` and `test` map names to `{command, cwd?, timeoutMinutes (1-240), env?, blockPushOnFailure (default true)}`. Commands
run through bash in the task workspace. `env` may not contain anything that looks like a credential (the file is not a secret store: a
build script must find its own stored credential). `encoding` has `legacyGlobs` (paths whose non-ASCII text must stay in the legacy
encoding), `utf8Globs`, and `blockPush` (default true). Unknown keys are errors.

## Verified here, and what only the machine can verify

Tests (`npm test`, 39 of them here; the 44 for the shared execution environment live in the kit's `windows-*.test.ts`: confinement with
Windows semantics on any OS, the same confinement against a real directory with symbolic links, commands (environment isolation, output
cap, timeout and process-tree kill, the sweep). Here: encoding rules (including Swedish
characters in Windows-1252), profiles, settings, the key generator, an end-to-end suite through a real domain
(success with build and tests, blocking build, non-blocking failure, arbitrary command refused, unknown profile, legacy file rewritten as
UTF-8 blocked, byte-preserving edit pushed), the packaging scripts (ASCII, PowerShell 5.1 syntax lint, parsed with the real parser,
firewall range arithmetic) and the smoke test.

Not verifiable without the machine, so `deploy/smoke.ps1` checks them there: Git Bash on Windows (quoting of the kit's git commands,
`printf` byte output, CRLF), junction and 8.3 handling on NTFS, `taskkill` of a real process tree, the scheduled task and account setup,
the user-rights changes made with `secedit`, the firewall rules on the machine's Windows build, and a build profile that calls the real
build tooling.

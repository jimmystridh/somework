# Aikido fixer (`code.fix`)

An agent that listens to Aikido's events, keeps a fresh clone of one repository, tries to fix the issue Aikido reported, and opens a **draft pull request**. It never merges, never approves and never touches another branch. A thin role on `@somework/agent-kit`: this directory is a card, a profile, hooks, one read-only tool, a shipped event handler and the deployment files.

```
Aikido ──webhook──► receiver ─► hub ─► event aikido.issue.* ─► (rule aikido-fixer: wake) ─► this agent
                                                                         │ handlers/aikido.mjs decides: drop · deliver · submit
                                                                         ▼
                                                       code.fix task for this same agent (causedByEvent)
                                                                         │
   mirror refreshed ─► fresh clone at the resolved commit ─► Aikido issue read (host side) ─► eligibility ─► model works in the sandbox
                                                                         │ FIXED: / NO_FIX:
   guards (protected paths, file count, secret-like text, check profile) ─► commit (cites the issue) ─► push agent/aikido-<issue>-<sha> ─► draft PR
```

## The contract (`card.json`)

`code.fix` **v1**, side effects `write`, a budget is required.

Input: `{ issue: {id, url?, repository?}, repository: {url, ref?}, hint?, budget: {maxTokens, maxMinutes} }`. `issue.id` is the Aikido issue group id (an issue id is resolved to its group). `repository.ref` defaults to `HEAD`: the head of the default branch, resolved to a commit when the task runs. `hint` is for a person's guidance; nothing from Aikido is ever copied into it.

Output: `{ outcome, summary, aikidoIssueId, files[], prUrl?, branch?, sha?, baseSha?, tests?, usage? }`

| outcome | meaning |
|---|---|
| `pr_opened` | branch pushed and a draft pull request opened (`prUrl`, `branch`, `sha`) |
| `no_fix` | no safe fix: the agent said so (`NO_FIX:`) or changed nothing; whatever it had started was discarded |
| `skipped` | not this agent's issue: closed, ignored or snoozed, a pull request already open, below the severity threshold, a type it does not fix (a leaked secret has to be rotated), another repository, or the attempt limits were reached. Decided before a token is spent |
| `blocked` | a guard stopped the change: a protected path, too many files, secret-like text, a failing check profile, or a branch that was pushed without a pull request |

## How it works

1. **Event to task.** The rule `rules/aikido-fixer.yaml` wakes the agent for every `aikido.*` event. The shipped handler `handlers/aikido.mjs` (installed into the agent's handler directory on first start, versioned like any handler) looks only at the issue number, severity, repository name and an `aikido.dev` link, and decides: **drop** (closed or resolved, below the severity threshold, another repository, already handled), **deliver** (no usable issue id, attempts exhausted or the daily cap reached: a person should look) or **submit** one `code.fix` task to this same agent, with `causedByEvent` set by the kit. Event text is data: nothing else is copied into the task.
2. **Authoritative limits on the host.** The handler's counters live in the sandbox where the model's tools can reach them, so they are only an early filter. `prepareInput` counts every attempt again on the service host (`aikido-attempts.json` in the state volume): per issue at most `AIKIDO_MAX_ATTEMPTS_PER_ISSUE` with a cool-down, per day at most `AIKIDO_DAILY_CAP`. A task is counted once however often it is retried.
3. **Read the issue (host side).** The service holds the Aikido OAuth2 client credentials (a file only the harness reads), fetches the issue group, trims and sanitises every text field (control characters, secret-like strings, length) and decides eligibility. The model reads the issue again with the read-only tool `aikido_issue`, which takes no arguments that choose another issue; everything Aikido says is framed as untrusted data inside random markers.
4. **Fresh clone.** A persistent bare mirror of the repository (`GIT_MIRROR_DIR`, branches and tags only) is refreshed before every task and on a timer (`AIKIDO_MIRROR_REFRESH_MINUTES`, default 30); the workspace is cloned from it at the resolved commit of the default branch, then `origin` is pointed back at the real remote.
5. **Work.** The model gets `read`, `write`, `edit`, `bash` and `aikido_issue`, a conservative budget (default 300 000 tokens, 30 minutes) and orders to make the smallest change. Commands that would change the branch, the history or the code host, or that match the developer role's patterns, ask for approval; **nobody answers for this agent, so every approval request is refused**.
6. **Guards, then git.** The service stages the change and refuses it (`blocked`, nothing leaves the workspace) when it touches a protected path (workflows, pipelines, code owners, key and environment files), more than `AIKIDO_MAX_FILES` files, adds secret-like text, or fails the repository's named check profile. Otherwise it commits (`fix(security): … (Aikido #<id>)`, citing the issue), pushes `agent/aikido-<issueId>-<sha8>` (never `main`, never forced) and opens a **draft** pull request whose body says it is generated and unreviewed. A retry keeps its branch name.
7. **Clean-up.** The checkout is removed once the result is reported.

## Settings

All `AIKIDO_*` unless noted; `deploy/.env.example` and `deploy/compose.yaml` list them with defaults.

| Setting | Default | Meaning |
|---|---|---|
| `AIKIDO_REPOSITORY_URL` | required | the one repository this agent fixes |
| `AIKIDO_REGION` | `eu` | `eu`, `us` or `me` |
| `AIKIDO_CLIENT_FILE` | `/run/secrets/aikido-client.json` | `{"clientId","clientSecret"}` |
| `AIKIDO_MIN_SEVERITY` | `high` | handler and task both apply it |
| `AIKIDO_FIX_TYPES` | `open_source,sast,iac` | issue types it attempts |
| `AIKIDO_MAX_FILES` | `40` | larger changes are blocked |
| `AIKIDO_PROTECTED_PATHS` | built-in list | globs; a change touching one is blocked |
| `AIKIDO_CHECK_PROFILE`, `AIKIDO_CHECK_FILE` | none | a named profile of `{command, cwd?, timeoutSeconds?}` run by the service, never chosen by the model |
| `AIKIDO_MAX_ATTEMPTS_PER_ISSUE` | `2` | with `AIKIDO_ATTEMPT_COOLDOWN_MINUTES` (180) between attempts |
| `AIKIDO_DAILY_CAP` | `5` | fix attempts per UTC day |
| `AIKIDO_FIX_BUDGET_TOKENS`, `AIKIDO_FIX_BUDGET_MINUTES` | `300000`, `30` | budget the handler puts on the task |
| `AIKIDO_MIRROR_REFRESH_MINUTES` | `30` | mirror refresh (kit variables `GIT_MIRROR_DIR`, `GIT_MIRROR_REPOS`, `GIT_MIRROR_REFRESH_MINUTES`) |
| `AIKIDO_RESEED_HANDLER` | `0` | `1` writes the shipped handler again, with the current settings, as a new version |

The service refuses to start without a git token, with `GIT_PR_DRAFT` not `1`, or with `PI_CONCURRENCY` above 1. The handler's settings are written into it when it is installed; a restart never overwrites the live copy.

## Decisions and limits

* **Gate handler is operator-managed.** The event handler tools would let a prompt-injected run rewrite the gate that starts fix tasks, so `handler_save`, `handler_enable` and `handler_disable` need an approval, which this agent always refuses. Operators change the handler with `AIKIDO_RESEED_HANDLER=1`, the manager's `/kill` and `/unkill`, or the files in the state volume.
* **Approvals are refused, not queued.** A task started by an event has a requester that is the agent itself; waiting for an answer would only burn the lease.
* **A skipped task still clones.** Eligibility is decided after the workspace is prepared (the kit prepares the workspace before the role's `beforeRun`); with the mirror that costs seconds, and no model call is made.
* **Aikido's payload is not fully known.** The hub's `aikido` mapping is a first cut (`packages/events-hub/README.md`, "Refining a mapping"). The handler needs a numeric `issueId`; events without one are recorded for a person, and a wrong id ends as `invalid_input` without a token spent.
* **The sandbox runs repository code** (a dependency bump may run install scripts and tests) as a non-root user with no credentials, no route out except the allow-listed proxy and a read-only root file system. Treat it as a build agent for that repository.
* **Package registries.** Bumping a dependency to a version that was just released can conflict with a package minimum-age policy; the agent then reports `no_fix` or `blocked`, it does not weaken the policy.

## Files

```
card.json                the capability
src/main.ts              runAgentService with the role's environment
src/profile.ts           tools, approval patterns, budget, events
src/hooks.ts             prepareInput, instruction, branchName, beforeRun, beforeFinalize, pullRequest, wrapRuntime, result
src/settings.ts          AIKIDO_* settings and the kit variables filled in from them
src/attempts.ts          the authoritative per-issue and per-day limits (host side)
src/checks.ts            change review and the named check profile
src/prompt.ts            standing orders, instruction, answer parsing, pull request text
src/aikido/{client,issue,tool}.ts   OAuth2 client, summarising and eligibility, the aikido_issue tool
src/seed.ts, handlers/aikido.mjs    the shipped event handler and its installation
deploy/                  compose.yaml, .env.example, checks.example.json, README.md (runbook)
examples/request.ts      submit a fix by hand
test/                    unit tests and an end-to-end test with a real domain, a faux model and a local repository
```
Kit additions this role relies on (`packages/agent-kit`): the persistent mirror (`GitSession.mirrorDir`, `refreshMirror`, `startMirrorRefresh`), `RoleHooks.branchName`, a commit message from `RoleHooks.pullRequest`, `repository.ref: "HEAD"`, and the handler reading the prepared input.

# Aikido fixer (`code.fix`)

An agent that listens to Aikido's events, keeps a fresh clone of one repository, tries to fix the issue Aikido reported, and opens a **pull request** (a real one by default; `GIT_PR_DRAFT=1` makes it a draft). It never merges, never approves and never touches another branch. A thin role on `@somework/agent-kit`: this directory is a card, a profile, hooks, one read-only tool, a shipped event handler and the deployment files.

```
Aikido ──webhook──► receiver ─► hub ─► event aikido.issue.* ─► (rule aikido-fixer: wake) ─► this agent
                                                                         │ handlers/aikido.mjs decides: drop · deliver · submit
                                                                         ▼
                                                       code.fix task for this same agent (causedByEvent)
                                                                         │
   mirror refreshed ─► fresh clone at the resolved commit ─► Aikido issue read (host side) ─► eligibility ─► model works in the sandbox
                                                                         │ FIXED: / NO_FIX:
   guards (protected paths, file count, secret-like text, check profile) ─► commit (cites the issue) ─► push agent/aikido-<issue>-<sha> ─► pull request
```

## The contract (`card.json`)

`code.fix` **v1**, side effects `write`, a budget is required.

Input: `{ issue: {id, url?, repository?}, repository: {url, ref?}, hint?, budget: {maxTokens, maxMinutes} }`. `issue.id` is the Aikido issue group id (an issue id is resolved to its group). `repository.ref` defaults to `HEAD`: the head of the default branch, resolved to a commit when the task runs. `hint` is for a person's guidance; nothing from Aikido is ever copied into it.

Output: `{ outcome, summary, aikidoIssueId, files[], prUrl?, branch?, sha?, baseSha?, tests?, usage? }`

| outcome | meaning |
|---|---|
| `pr_opened` | branch pushed and a pull request opened (a draft when `GIT_PR_DRAFT=1`) (`prUrl`, `branch`, `sha`) |
| `no_fix` | no safe fix: the agent said so (`NO_FIX:`) or changed nothing; whatever it had started was discarded |
| `skipped` | not this agent's issue: closed, ignored or snoozed, a pull request already open, below the severity threshold, a type it does not fix (a leaked secret has to be rotated), another repository, or the attempt limits were reached. Decided before a token is spent |
| `blocked` | a guard stopped the change: a protected path, too many files, secret-like text, a failing check profile, or a branch that was pushed without a pull request |

## How it works

1. **Event to task.** The rule `rules/aikido-fixer.yaml` wakes the agent for every `aikido.*` event. The shipped handler `handlers/aikido.mjs` (installed into the agent's handler directory on first start, versioned like any handler) looks only at the issue number, severity, repository name and an `aikido.dev` link, and decides: **drop** (closed or resolved, below the severity threshold, another repository, already handled), **deliver** (no usable issue id, attempts exhausted, or five times the daily cap of tasks already started today: a person should look) or **submit** one `code.fix` task to this same agent, with `causedByEvent` set by the kit. Event text is data: nothing else is copied into the task.
2. **Authoritative limits on the host.** The handler's counters live in the sandbox where the model's tools can reach them, so they are only an early filter (the handler counts tasks it submits, including ones the host later skips, so its daily limit is five times `AIKIDO_DAILY_CAP`). `prepareInput` counts every attempt that is not skipped again on the service host (`aikido-attempts.json` in the state volume): per issue at most `AIKIDO_MAX_ATTEMPTS_PER_ISSUE` with a cool-down, per day at most `AIKIDO_DAILY_CAP`. A task is counted once however often it is retried.
3. **Read the issue (host side).** The service holds the Aikido OAuth2 client credentials (a file only the harness reads), fetches the issue group, trims and sanitises every text field (control characters, secret-like strings, length) and decides eligibility. The model reads the issue again with the read-only tool `aikido_issue`, which takes no arguments that choose another issue; everything Aikido says is framed as untrusted data inside random markers.
4. **Fresh clone.** A persistent bare mirror of the repository (`GIT_MIRROR_DIR`, branches and tags only) is refreshed before every task and on a timer (`AIKIDO_MIRROR_REFRESH_MINUTES`, default 30); the workspace is cloned from it at the resolved commit of the default branch, then `origin` is pointed back at the real remote.
5. **Work.** The model gets `read`, `write`, `edit`, `bash` and `aikido_issue`, a conservative budget (default 300 000 tokens, 30 minutes) and orders to make the smallest change. Commands that would change the branch, the history or the code host, or that match the developer role's patterns, ask for approval; **nobody answers for this agent, so every approval request is refused**.
6. **Guards, then git.** The service stages everything and judges the whole change since the base commit, so a commit an earlier attempt left in a persisted workspace is checked as strictly as the model's fresh changes (and counts in the file list of the pull request). It refuses the change (`blocked`, nothing leaves the workspace) when it touches a protected path (workflows, pipelines, code owners, key and environment files), more than `AIKIDO_MAX_FILES` files, adds secret-like text, or fails the repository's named check profile. Otherwise it commits (`fix(security): … (Aikido #<id>)`, citing the issue), pushes `agent/aikido-<issueId>-<sha8>` (never `main`, never forced) and opens a pull request whose body says it was generated by an agent and must be reviewed before merge. A retry keeps its branch name.
7. **Retries and reruns.** The branch on the remote is never rewritten (no force push). If a retry of the same task finds its work already pushed and only the pull request missing, the role's `resume` hook recovers the headline and the files from the pushed commit and the pull request is opened **without another model run** (`job_resumed` in the log; the body says so). If the branch exists with the same tree, it is reused; with different work, the new work goes to `agent/aikido-<issue>-<sha8>-2` (up to `-5`) and the result's `branch` and `prUrl` name that real branch; when all five are taken the task fails `branch_exhausted` (not retried: a person has to look at those branches).
8. **Clean-up.** The checkout is removed once the result is reported.

## Settings

All `AIKIDO_*` unless noted; `deploy/.env.example` and `deploy/compose.yaml` list them with defaults.

| Setting | Default | Meaning |
|---|---|---|
| `AIKIDO_REPOSITORY_URL` | required | the one repository this agent fixes |
| `AIKIDO_REGION` | `eu` | `eu`, `us` or `me` |
| `AIKIDO_CLIENT_FILE` | `/run/secrets/aikido-client.json` | `{"clientId","clientSecret"}` |
| `AIKIDO_MIN_SEVERITY` | `high` | handler and task both apply it |
| `AIKIDO_API_MIN_INTERVAL_MS` | `1500` | the least time between two requests to Aikido, whatever the number of jobs; a 429 is waited out (the `Retry-After` it names, else 2, 4, 8 s) and retried three times, and resolved issues are shared between jobs for five minutes. A job reads the issue group first and the issues of the group (the heaviest request) only when it is going to run |
| `AIKIDO_FIX_TYPES` | `open_source,sast,iac` | issue types it attempts |
| `AIKIDO_MAX_FILES` | `40` | larger changes are blocked |
| `AIKIDO_PROTECTED_PATHS` | built-in list | globs; a change touching one is blocked |
| `AIKIDO_CHECK_PROFILE`, `AIKIDO_CHECK_FILE` | none | a named profile of `{command, cwd?, timeoutSeconds?}` run by the service, never chosen by the model |

A profile is what stands between a model's change and a push, so write one for the repository: the example `deploy/checks.visma-administration.example.json` runs a frozen install and the production build when the change touches the web app (it caught a `package.json` override without a regenerated `bun.lock`), and says "not verified" for paths the sandbox has no toolchain for (dotnet). The repository's own type check is not used: it is red on the original commit.
| `AIKIDO_MAX_ATTEMPTS_PER_ISSUE` | `2` | with `AIKIDO_ATTEMPT_COOLDOWN_MINUTES` (180) between attempts |
| `AIKIDO_DAILY_CAP` | `5` | fix attempts per UTC day |
| `AIKIDO_FIX_BUDGET_TOKENS`, `AIKIDO_FIX_BUDGET_MINUTES` | `300000`, `30` | budget the handler puts on the task |
| `AIKIDO_MIRROR_REFRESH_MINUTES` | `30` | mirror refresh (kit variables `GIT_MIRROR_DIR`, `GIT_MIRROR_REPOS`, `GIT_MIRROR_REFRESH_MINUTES`) |
| `AIKIDO_LEDGER_IMPORT` | none | path of a JSON file of earlier attempts that seeds the chat's account of what the agent did (below) |
| `AIKIDO_RESEED_HANDLER` | `0` | `1` writes the shipped handler again, with the current settings, as a new version |

The service refuses to start without a git token or with `PI_CONCURRENCY` above 1. `GIT_PR_DRAFT` (default `0`) chooses between real pull requests and drafts; the rest of the safety envelope does not depend on it: only `agent/*` branches, never the default branch, never a force push, never a merge or an approval. The handler's settings are written into it when it is installed; a restart never overwrites the live copy.

## Follow-ups on its own pull requests

After a pull request is opened the agent asks the event hub (`TIMERS_URL`, see `packages/events-hub/README.md`, "Timers") to wake it again after `AIKIDO_FOLLOWUP_MINUTES` (default `15,60,240`; `off` turns follow-ups off). The wake (`clock.timer.aikido_fixer.due`, rule `aikido-fixer-timer`) reaches the second shipped handler, `aikido-followup`, which validates the timer's payload (this repository's pull request address, an `agent/` branch, the issue number, the check number) and submits one `code.fix.followup` task for this agent, at most `AIKIDO_FOLLOWUP_CAP_PER_DAY` (default 10) a day.

The task reads the pull request over GitHub's API with the agent's own credential (a fine-grained token needs Pull requests: read and Actions: read; it has no permission for check runs or commit statuses, so CI is read through GitHub Actions: failed runs, the failed job and step and the last 40 lines of its log, plus the pull request's overall status. A check that is not a GitHub Actions run only shows as an overall FAILURE): reviews, review comments, comments from people (a bot's plain comment, such as a preview deployment, is left out) and failing checks that came after the branch's newest commit. A pull request that is closed or merged, or has nothing new, ends as `skipped` before anything is cloned. Otherwise the workspace is the head of the pull request's branch, the model gets the feedback as data between markers and is told to act only on points that are correct and about the security fix, and the same guards as for a fix (protected paths, file count, secret-like text, check profile) judge the change before the service commits to the **same branch**: the pull request updates, nothing is force-pushed, no new pull request is opened. Results: `followup_pushed`, `no_followup_needed`, `skipped`, `blocked`. After each look, while the pull request is open and checks are left, the next one is asked for; if the hub cannot be reached the follow-up is simply not scheduled (the log says so).

## Chat

The fixer answers direct chat messages with the model (`CHAT_MODE=notice` goes back to the fixed notice).

* **Questions** (from `agent/manager` or a person): one read-only turn with `read` (of a checkout of `AIKIDO_REPOSITORY_URL`), `agent_status`, `fixer_status` and `aikido_lookup`. `fixer_status` is the host's own record: today's fix tasks against `AIKIDO_DAILY_CAP`, the per-issue limits, and the recent attempts with their outcome (`pr_opened`, `no_fix`, `skipped`, `blocked`), branch, pull request and tokens, and how fresh the local clone is. `aikido_lookup` reads one Aikido issue by its whole-number id (the same trimmed, framed and secret-stripped answer as `aikido_issue`; it cannot list, search or write). The model cannot start a fix, push or open a pull request from a question.
* **Fix an issue in a conversation** (any message that asks for it: "fix issue 1234"; the model calls `fix_issue` with the number, an allowed `repository` if one is named and the rest of the sentence as the requester's `hint`): a `code.fix` job for that issue on the configured repository, run in the background by the same handler as an event's job: eligibility (severity, type, open), the daily cap and per-issue attempt limits with cool-down, protected paths, size, secret and check-profile guards, a real pull request for a person to review, and the result posted to the conversation. Exactly one issue number must be named; a version or a number in a URL is not taken as one.
* **Follow up on a pull request** ("go through the review comments on your last PR", "follow up on PR 5244"; the model calls `follow_up_pull_request`): a `code.fix.followup` job for a pull request this agent recorded, the latest one unless one is named; a pull request it did not open is refused.

**Seeding the history.** Outcomes are recorded from the build that has chat on; earlier attempts are not known to it. To seed them, put a JSON file in the config directory (mounted at `/run/config/`) and set `AIKIDO_LEDGER_IMPORT=/run/config/past-attempts.json`. The file is an array (or `{"attempts": [...]}`) of rows `{"issueId": 1234, "outcome": "pr_opened", "at": "2026-10-01T09:00:00Z", "branch": "agent/aikido-1234-abcd1234", "prUrl": "https://github.com/ORG/REPO/pull/9", "tokens": 41000}`; `outcome` is `pr_opened`, `no_fix`, `skipped`, `blocked` or `failed:<code>`, `branch`, `prUrl` (https only) and `tokens` are optional. The import runs at every start and is idempotent: a row is identified by its issue and time, so the same or an overlapping file adds nothing twice, and it can stay set. Imported rows only fill in what `fixer_status` reports (marked "imported history"); they do not count against the daily cap, the attempt limit or the cool-down. Invalid rows are skipped and counted in the log line `fixer_ledger_imported {imported, alreadyThere, invalid}`; a file that is missing, not JSON or not a list stops the service at startup. At most the newest 200 outcomes are kept.

The outcome of every task is also written to the host ledger (`aikido-attempts.json` in the state directory), which is what `fixer_status` reports.

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

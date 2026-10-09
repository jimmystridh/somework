# QA (`qa.verify`)

The role that checks a ticket against a revision of a repository, the way a person would: it runs the application on its own machine,
drives a real browser (headless Microsoft Edge), builds the data the scenario needs, records one short video of the decisive pass and
reports a verdict. It can write to the ticket system, but only through a handful of tools that each wait for the requester's approval
and that refuse anything the rules forbid.

Like every role it is a card, a profile and a `main.ts` on `@somework/agent-kit` (see `packages/agent-kit/README.md`). It runs on the
confined Windows environment the kit provides (`@somework/agent-kit/windows`, shared with the Windows developer), one job at a time.

## The contract (`card.json`)

```
qa.verify@1   sideEffects: write   budget required
input   ticket                        the key, e.g. PROJ-123 (the machine is configured with the pattern of keys it handles)
        repository {url, ref}         ref: branch, tag, SHA (name the full SHA when handing over) or refs/pull/<n>/head
        budget {maxTokens, maxMinutes}
        scenario?, app?, agentKey?, model?
output  verdict: verified | not_fixed | blocked | skipped
        ticket, revision {frontendSha, backendRevision?}
        acceptanceChecks[{criterion, passed, evidence}], fixtures[{description, keys}]
        evidence[{artifactId, kind: video|screenshot, filename}]
        jira {commented, labelled, transitioned, attached, skippedReason?}, notes, usage
```

* `skipped`: the key does not match this machine's `QA_TICKET_PATTERN`. The task completes without the model, without starting
  anything and without a call to the ticket system.
* `blocked` is a *completed* task. The application did not start, the run could not finish the verification, or the model claimed
  `verified` without a recorded video (a verification needs one, so the harness downgrades it and says so in `notes`).
* An answer without a usable report gets exactly one repair turn in the same conversation; if that fails too the task fails with
  `invalid_qa_report` and the raw answer attached as an artifact.
* Every write to the ticket system waits for the requester: the task shows `input_required` with a summary of the write, answer with
  `{approved: true}` or `{approved: false, reason}`.

## How a job runs

```
claim (SDK worker) -> hooks.prepareInput: ticket-key gate (a foreign key is `skipped`, nothing else happens)
  -> kit handler: budget, ledger, model allowlist, clone the ref and check it out at the resolved SHA
  -> hooks.beforeRun: start the application from its named profile and wait until it is healthy;
                      start the browser daemon and write the `qa` command line for the model;
                      tell the ticket tools which job is running.   (application did not start -> blocked, no tokens spent)
  -> Pi run: the model reads the ticket, drives the browser with `qa <command>`, builds fixtures, records the video,
             calls qa_record_verdict, then writes to the ticket (each write waits for approval)
  -> hooks.beforeFinalize: close the browser, so the video is a finished file
  -> hooks.result: parse the report, upload the video and screenshots as artifacts, build the card's result
  -> hooks.afterRun: stop the browser, run the profile's stop command, sweep the account's leftover processes
```

No commit, no push, no pull request: the profile turns the git workflow off, and `git commit|add|reset|clean|...` in a shell command
waits for a human on top of the Windows rules.

| File | |
|---|---|
| `card.json`, `src/profile.ts`, `src/prompt.ts`, `src/main.ts` | the role: contract, standing orders, the brief of one verification, approval patterns |
| `src/hooks.ts` | the hooks above (`createQaHooks`) |
| `src/app.ts` | application profiles: `parseAppProfiles`, `AppRunner` (start, health polling, revision command, stop, sweep) |
| `src/browser/` | `daemon.ts` (loopback HTTP daemon with a per-job token), `cli.ts` (the command line the model types), `policy.ts` (which URLs may be opened), `playwright.ts` (the backend: `playwright-core` driving the installed Edge), `snapshot-script.ts` (the page outline with refs), `fake.ts` (a backend without a browser, for tests and smoke) |
| `src/jira.ts` | the ticket-system client: `node:https`, optional client certificate (PKCS#12), bearer token |
| `src/jira-tools.ts`, `src/session.ts` | the tools the model gets and the rules behind them; the state of the one running job |
| `src/result.ts`, `src/qa-runtime.ts` | the report parser/validator, and the runtime wrapper that does the one repair turn |
| `src/settings.ts`, `src/service.ts` | settings, and the composition handed to the kit's `runAgentService` |
| `deploy/` | `install-service.ps1`, `run-agent.ps1`, `firewall.ps1`, `uninstall.ps1`, `smoke.ps1` + `smoke.ts`, `keygen.ts`, `agent.env.example`, `profiles.example.json`, `firewall-allow.example.txt`, `overlay.example.md`, `README.md` |

## Application profiles

A job never supplies a command. It names a profile (`app`, default `default`) from the machine's `QA_PROFILES_FILE`:

```json
{ "app": { "default": {
    "start": "nohup npm run dev -- --port 5173 > .qa-app.log 2>&1 < /dev/null & echo $! > .qa-app.pid",
    "health": ["http://127.0.0.1:5173/"],
    "stop": "kill $(cat .qa-app.pid)",
    "cwd": ".", "env": { "APP_MODE": "local" }, "startupTimeoutSeconds": 180,
    "backendRevisionCommand": "curl -s http://127.0.0.1:8080/version"
} } }
```

`start` runs through bash in the checkout (or `cwd` below it) and must start the application in the background and return. `health` are
loopback URLs that must answer with anything below 500. `stop` is optional: after it, and also when it fails or is missing, every
process the service account started during the job is stopped (the Windows sweep). `env` may not contain anything that looks like a
credential. The first output line of `backendRevisionCommand` is reported as `revision.backendRevision`. Unknown keys are errors.

## The browser: `qa`

`beforeRun` writes `<root>/.qa/<taskId>/qa`, a small script the model runs from bash. It talks to a daemon inside the agent process over
loopback with a per-job token; the daemon drives Edge through Playwright.

| Command | |
|---|---|
| `open <url>` | go to a page; only the hosts in `QA_BROWSER_ALLOW_HOSTS` (default `127.0.0.1,localhost`) are reachable, in the daemon and again inside the browser (every request of every page is checked, so a link or script cannot leave) |
| `snapshot` | a text outline of what a person sees; every control has a ref (`e12`). Hidden elements are left out, passwords and their values are never shown |
| `click <ref>`, `fill <ref> <text>`, `press <key>`, `wait [--ms N] [--text T] [--selector S]` | act; refs belong to the last snapshot |
| `screenshot [name]`, `errors` | a PNG in `screenshots/`; console, page and network errors since the page was opened |
| `video-start`, `video-stop` | record one context into `videos/qa-video-N.webm` (Playwright records per context, so the page is reloaded; the refs of the last snapshot still apply, typed text is gone) |

## The ticket tools, and the rules behind them

Offered only when `JIRA_URL` is configured. The credentials (client certificate, its password, the token) are read from files at startup,
used only by the harness, and scrubbed from logs, artifacts and results. The model never sees them and has no tool that takes a URL.

| Tool | |
|---|---|
| `jira_get_issue`, `jira_get_comments`, `jira_changelog`, `jira_search` | read. Only keys that match the ticket pattern; without a key they read the ticket under verification |
| `qa_record_verdict` | the model's verdict, recorded before it writes; the write tools check it. Changes nothing outside the job |
| `jira_attach` | attach a `.webm` from `videos/` or a `.png` from `screenshots/` of the evidence folder (nothing else, size-limited, confined) |
| `jira_comment` | a comment on the ticket under verification |
| `jira_add_label` | the verified label (default `AgentTested`) and only that one, only for the recorded verdict `verified`, only after the video was attached and the comment posted; other labels are kept |
| `jira_remove_label` | removes a stale verified label, only for `not_fixed` |
| `jira_transition_to_in_progress_and_reassign` | the hand-back, only for `not_fixed`: comment, remove a stale verified label, move to In Progress, give the ticket back to whoever had it before it became unassigned (from its history). Without a findable previous assignee it only comments |

Every write is approval-gated through the kit (`toolApprovals`), and every write **re-reads the ticket first** and refuses unless it is
still in the expected status (`JIRA_TEST_STATUS`) and unassigned. The rules are code, not prompt: no tool moves a ticket to a done state
(refused by status category and by name, whatever the workflow calls it), only the job's own ticket and keys that match the pattern can
be read or written, the verified label is only ever added for `verified`, and the only assignment is restoring the previous assignee in
the not-fixed hand-back (and not when the workflow already assigned someone).

## Settings

The kit's own settings apply (`SOMEWORK_*`, `PI_*`, `GIT_*`, `BUDGET_*`, `SKILLS_*`), as do the Windows machine settings (`WINDOWS_*`,
see `packages/agent-kit/src/windows/settings.ts`). `PI_CONCURRENCY` must be 1: the application, the browser and the ticket state are per
machine. Role-specific:

| Setting | |
|---|---|
| `QA_PROFILES_FILE` | the application profiles (required, at least one) |
| `QA_TICKET_PATTERN` | regular expression of the keys this machine handles (default any `ABC-123`); narrow it |
| `QA_BROWSER_CHANNEL` | the installed browser Playwright drives (default `msedge`) |
| `QA_BROWSER_ALLOW_HOSTS` | hosts the browser may reach (default `127.0.0.1,localhost`) |
| `JIRA_URL` | https URL of the ticket system; without it there is no ticket system and nothing is written |
| `JIRA_TOKEN_FILE` | personal access token (bearer) |
| `JIRA_PFX_FILE`, `JIRA_PFX_PASSWORD_FILE` | client certificate for hosts that demand mutual TLS, and its password (an empty file for none) |
| `JIRA_CA_FILE` | a private CA that signed the host's certificate |
| `JIRA_TEST_STATUS`, `JIRA_IN_PROGRESS_STATUS`, `JIRA_VERIFIED_LABEL` | names in that system (defaults `Test`, `In Progress`, `AgentTested`) |

## Chat

QA answers direct chat messages with the model (`CHAT_MODE=notice` goes back to the fixed notice). A **question** from the manager or a person
gets one bounded, read-only turn: tools `read, agent_status`, no commands, no changes, no approvals, an answer built from the service's own records
(`agent_status`) and, where it has one, a read-only checkout. An **instruction** (`instruct: ...`, from `agent/manager` only) becomes a `qa.verify` task for the ticket key named in the text (`instruct: verify ABC-123`), with optional lines `repo:`, `ref:`, `scenario:`, `app:`. Several keys (`instruct: verify ABC-123 ABC-124`) or a state (`instruct: verify the tickets in Test`, a line `status: <name>`, or a line `jql: <query>`; needs the ticket system) become a queue: the agent says which tickets it found (those that already carry the verified label are skipped unless the text says "again"), verifies them one at a time and answers after each, at most `QA_CHAT_BATCH_MAX` (default 5, up to 10) per instruction and within the chat budget of the day. Writes to the ticket system still wait for approval, which is asked of the manager.
It runs as a job of the normal handler, with the role's own tools, guards and approvals, a chat budget of its own (150 000 tokens, 15 minutes by
default, `CHAT_INSTRUCT_TOKENS` and `CHAT_INSTRUCT_MINUTES`) and the `chat` share of the daily token limit (`CHAT_TOKEN_SHARE`); a step that needs
approval is asked of the manager in the conversation. Settings: `CHAT_MODE`, `CHAT_ALLOWED_SENDERS`, `CHAT_INSTRUCTORS`, `CHAT_REPOSITORY_URL`,
`CHAT_REPOSITORY_REF`, `QA_CHAT_BATCH_MAX`, `CHAT_TOKEN_CAP`, `CHAT_TOKEN_SHARE`, `CHAT_INSTRUCT_TOKENS`, `CHAT_INSTRUCT_MINUTES` (all optional; the full table is in
`packages/agent-kit/README.md`).

## Skills

`profile.skills.allow` is empty: nothing from the repository is shown to the model unless the deployment names it. A deployment that
wants the repository's own QA skill sets `SKILLS_ALLOW=qa` and, because a skill written for a person with other tools needs adjusting,
`SKILLS_OVERLAY_DIR` with a `qa.md` that states only the differences. The first line of an overlay records the SHA-256 of the base
skill it was written against; when the repository's skill changes, the overlay is still applied but flagged to the model and the log.
`deploy/overlay.example.md` shows the shape. Overlays that mention a company, its projects or its data do not belong in this repository.

## Verified here, and what only the machine can verify

Tests (`npm test`): the ticket-system client and its rules against a fake that demands a client certificate and a bearer token (a
stranger's certificate and a wrong token are refused; the token never in an error or in a task result), each tool's rules (done states, stale ticket,
labels, confinement of attachments, previous assignee, approvals), report parsing and validation, application profiles and their
lifecycle against a real local web server, the browser daemon and command line over real loopback HTTP, the Playwright backend against a
local page in a real Edge (skipped where Edge is missing: snapshot refs, fill/click, blocked hosts, errors, a real WebM, refs surviving
the recording), and an end-to-end suite through a real domain with the scripted model (verified with three approved writes, a declined
write, a verified claim without a video, a not-fixed hand-back, a ticket that changed after approval, a foreign key, an application that
does not start, an unusable report, an unknown profile, a missing budget, and the same verification in real Edge).

Not verifiable without the machine, so `deploy/smoke.ps1` checks them there: Edge on the Windows build (the channel, headless in a
non-interactive session, the WebM it records), Git Bash quoting of the profile commands and of the `qa` wrapper, process-tree stop of the
application and Edge, the scheduled task, account and firewall; and, with the real deployment, the ticket system (the certificate, the
token, the workflow's status and transition names) and a profile that starts the real application.

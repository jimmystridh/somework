# Agent fleet: manager, developers, reviewer, QA

Status 2026-10-06: the manager, developer, Windows developer and reviewer are live; QA is built and waits for its machine's web database (`TODO.txt`). `SYSTEM.md` is the map of the whole system; this document is the design of the fleet.

Five agents that cooperate through SomeWork. This document fixes how they are built and, above all, **what they share and how**.

| Agent | Where it runs | Capability it provides | What it does |
|---|---|---|---|
| **Manager** | agent Docker host | none (requester); talks Telegram | Takes requests from the owner, routes work, enforces approvals, reports back. Owns the pipeline order. |
| **Developer** | agent Docker host (Linux, sandboxed) | `code.agent` v1 (exists) | Frontend/TypeScript and general changes: branch, commit, push, draft PR. |
| **Windows developer** | the Windows build machine | `code.windows` v1 | Changes that must build and run on Windows (the legacy C++ backend): same git protocol, Windows toolchain, encoding-safe edits. |
| **Reviewer** | agent Docker host | `code.review` v3 | Read-only review of a PR/ref against the ticket and repository rules; produces findings, never writes to the host or repo unless the Manager approves a posted review. |
| **QA** | machine with a browser and network reach to the test backend | `qa.verify` v1 | Verifies a ticket against a revision in a real browser; returns a verdict plus evidence artifacts. |
| **Aikido fixer** | agent Docker host (Linux, sandboxed) | `code.fix` v1 | Listens to Aikido events, keeps a fresh mirror of one repository, attempts the smallest fix of a reported security issue and opens a PR; built, not deployed (`adapters/aikido-fixer`). |
| **Datadog triage** | agent Docker host (Linux, sandboxed, no repository) | `ops.triage` v1 | Listens to Datadog monitor alerts, investigates through read-only Datadog tools and python3 over saved results in a network-less sandbox, and sends the owner one structured diagnosis; built, not deployed (`adapters/datadog-triage`). |
| **Jira triage** | agent Docker host (Linux, sandboxed, no repository) | `jira.triage` v1, `jira.ticket.create` v1 | Checks every new Jira ticket against a fixed checklist for its type, has the developer agent look at technical gaps read-only, asks the reporter for what is still missing (Slack DM, else a Jira comment), and in Slack helps people create tickets; no model run in a triage; built, not deployed (`adapters/jira-triage`). |

## The question: how is code shared?

There are four different things people call "sharing code". Each gets one mechanism; none of them is a shared directory.

### 1. Platform code: one monorepo, one library, thin roles

The agents are the same program with different profiles. Everything that is not role-specific lives once, in `@somework/agent-kit`
(`packages/agent-kit`), and each role is a thin package:

```
sdk/typescript            @somework/sdk        client, worker loop, wake (NATS + sweep), identity
packages/agent-kit        @somework/agent-kit  the shared agent runtime (below)
adapters/pi               the developer role: card.json + src/profile.ts + src/main.ts + Dockerfile + deploy/
adapters/windows-developer  card.json + profile + main.ts + deploy/        (live)
adapters/reviewer         card.json + profile + main.ts + deploy/          (live)
adapters/qa               card.json + profile + main.ts + deploy/          (built, not deployed)
adapters/aikido-fixer     card.json + profile + hooks + a read-only Aikido tool + a shipped event handler + deploy/ (built, not deployed)
adapters/datadog-triage   card.json + profile + hooks + six read-only Datadog tools + a command policy + a shipped event handler + deploy/ (built, not deployed)
adapters/jira-triage      card.json + profile + hooks + a durable triage engine + a fixed checklist + Slack/Jira/developer ports + a shipped event handler + deploy/ (built, not deployed)
adapters/manager          Telegram bridge + gateway + Pi extension (a requester: uses the SDK only; live)
packages/events-receiver  public-edge webhook receiver (no dependencies)
packages/events-hub       private-side hub: mappings, clock, publishing, forwarding
packages/rules-cli        somework-rules: validate, plan, apply, comment
```

An npm workspace (root `package.json`, one `package-lock.json`) ties them together, so every agent is built from the same tree,
tested together, and released as one set of images (one Dockerfile with a `--target` per role; the Windows agent is a zip of the same tree plus a service wrapper).

`agent-kit` contains what used to live in `adapters/pi/src` (**done**, see `packages/agent-kit/README.md`): the runtime interface and the Pi Durable runtime, provider wiring and the
credential store, git workspace handling and the GitHub host (idempotent branch, commit, push, PR), the approval policy, budgets and
the daily ledger, shards, metrics, redacted structured logs, config helpers, health server, the sandbox protocol (server and remote
`ExecutionEnv`), the egress proxy, and a **skill loader** (point 3). A role is only:

* `card.json`: capability id/version, schemas, side effects (the contract other agents see);
* a **profile**: system prompt, allowed tools, approval patterns, default budget, whether it may push or open PRs;
* a `main.ts` of a few dozen lines that composes kit pieces and hands the handler to the SDK worker.

The rule that keeps this honest: **a role may not import from another role**. If two roles need it, it moves to the kit.

### 2. Work product: git and artifacts, never a shared filesystem

Agents do not see each other's disks. Work moves as **a reference**, not as files:

```
developer  --{repo, branch agent/<job>, commit sha, prUrl, diff artifact}-->  manager
manager    --{repo, ref=sha, pr, ticket}-->  reviewer      (read-only review)
manager    --{repo, ref=sha}-->              windows-developer (build/test on Windows) and qa (browser)
reviewer   --{verdict, findings[]}-->        manager  -- fixes needed -->  developer (same branch, new commits)
```

* The **git remote is the exchange medium**. Every handoff carries `{repository.url, ref}`, and the ref is a **resolved commit SHA**,
  so a reviewer or QA run is always about exactly the code that was produced, even if the branch moves.
* Results larger than a few KB (diffs, review reports, videos, logs) are **artifacts** in SomeWork, attached to the message that reports the job's result.
* Work that must change hands is described in a message (and the conversation it is in), not copied prompts; context packs were removed.
* **Same branch, many agents:** the developer owns `agent/<job>`. Others never push to it; follow-up fixes are new developer jobs
  asked for in the same conversation, so the history is there for the next run.

### 3. Knowledge (rules, skills, prompts): the target repository is the source of truth

The repository the agents work on already carries its own instructions (`AGENTS.md`, `.agents/skills`, `.claude/skills`,
`.claude/agents`). The kit's skill loader reads them **from the checked-out ref at job time** and adds an index (name and
description) to the system prompt; the model opens the `SKILL.md` it needs with its file tool (progressive disclosure). Consequences:

* Skills are **never copied into agent images or into this repository**. They change with the code they describe, per branch.
* The same skill serves every agent that is allowed to use it. Each role exposes **no skill by default**; the deployment names the allowed
  repository skills per role (`SKILLS_ALLOW`), for example the reviewer's review skills, the Windows developer's style and encoding skills and
  QA's verification skill. The allowlist is a list of skill names and lives in deployment configuration, not in this repository.
* When a skill must be adapted for SomeWork (QA: no human Chrome extension, no direct Jira writes), the adaptation is a small **overlay**
  file in the deployment config (`SKILLS_OVERLAY_DIR`, kept out of git for company content) that is appended after the base skill and
  states only the differences. The base skill is not forked, so it keeps getting upstream improvements; a check warns when the
  base file's hash differs from the one the overlay was written against.
* Because this repository is public, company-specific skill text, ticket keys and internal hosts belong in the target repository
  or the private deployment config, not here.

### 4. Capabilities: advertisements, not contracts

Agents never call each other's functions. They ask each other for things in messages, and each agent decides what to do. The **capability card** (name, description, examples, advisory side-effect class) tells others what an agent offers; nothing is enforced by it and no schema is checked by the platform. The agent's job tool (`verify_ticket`, `fix_issue`, ...) is where an input is validated. Agents that differ in a way that matters (Windows vs Linux) offer different capability ids so a person or another agent can pick the right one.

## Roles in detail

### Aikido fixer (live)
`code.fix` v1 on the same kit and git protocol as the developer, started by events instead of a requester: the rule `rules/aikido-fixer.yaml` wakes it for `aikido.*` events, its shipped handler turns an eligible issue into one `code.fix` job for itself, and the job works in a fresh clone (from a persistent mirror) at the resolved commit of the default branch. It reads the issue through a host-side, read-only Aikido client, refuses protected paths, secret-like text, oversized changes and a failing check profile, and opens a pull request (a real one by default, a draft with `GIT_PR_DRAFT=1`) on `agent/aikido-<issue>-<sha>`. Approval requests are refused (nobody answers for it), also in a conversation. Limits are enforced twice: by the handler in the sandbox as an early filter and by a ledger on the service host as the authority. See `adapters/aikido-fixer/README.md`.

### Datadog triage (live)
`ops.triage` v1 (side effects `read`), started by events like the fixer: the rule `datadog-triage` wakes it for `datadog.monitor.*` events (`rules/datadog-triage.yaml`, added once the agent was enrolled, because the rules pipeline refuses a rule whose owner does not exist), its shipped handler turns an eligible alert into one `ops.triage` job for itself, and the job works on no repository (`profile.noRepository` in the kit: an empty scratch directory). The model reads Datadog through six read-only tools that run in the service, where the keys are (monitor, monitor search, logs, metrics, events, incidents); `save: true` writes the full redacted result into `data/` in the workspace, and `python3` (standard library), `jq` and a few text tools in a sandbox with **no credentials and no network** (its own image: the developer sandbox plus python3; no egress proxy) analyse it under a command policy (anything else, including any approval, is refused). The answer is one json diagnosis (severity, summary, suspected cause with confidence, timeline, evidence, actions); the service checks that every finding cites a tool call or is marked inference, allows one repair turn, and sends the owner one deterministic notice (at most 1500 characters, secrets and links stripped, the monitor link built by the service) to `agent/manager`. Limits are enforced twice, like the fixer's: handler early filter, host ledger as the authority. See `adapters/datadog-triage/README.md`.

### Jira triage (built, not deployed)
`jira.triage` v1 and `jira.ticket.create` v1 (side effects `write`). Started by events like the fixer, but a triage is **code, not a model run**: the rules `jira-triage-created`, `-updated` and `-comment` (held in `adapters/jira-triage/deploy/rules/` until the agent is enrolled, for the reason the Datadog rule was) wake it for the Jira webhook's events, its shipped handler turns an eligible event into one `jira.triage` job for itself, and the job calls the engine (`src/engine.ts`) and ends as `blocked` before any model call, with the real outcome in its result. The engine keeps one durable record per ticket and moves it through a fixed checklist per issue type (bug, story-like, anything else): complete gets the marker label `triaged-by-bot`; a missing technical item goes first to the developer agent as a read-only message (answer or timeout, folded into a marked "Triage notes" section of the description); what is still missing is asked of the reporter in a Slack DM (found with `users.lookupByEmail`, the e-mail address read from Jira because the hub strips it) or, when Slack cannot be used, a Jira comment. The reporter's answers are read by the agent itself (the DM's history, the ticket's comments), never by a model, so nobody outside the Slack allow-list can instruct it. Jira outages are retried with a growing pause and nothing is lost; every write is recorded with its before and after value first and is idempotent; the bot never changes an assignee, a status or a reporter. In Slack the allow-listed people get a companion that searches for similar tickets, checks a draft against the same checklist and creates the ticket at once. Jira access is the owner's personal access token plus the client certificate, like QA's. See `adapters/jira-triage/README.md` and `adapters/jira-triage/deploy/README.md` (the manual steps that remain).

### Manager (live)
Existing Telegram bridge (owner pairing, private chat only) retrofitted: SomeWork identity `agent/manager` held by the bridge, a narrow
local gateway that the Pi process reaches through tools (catalog, message, inbox, handlers, control). The Manager asks an agent for something in a message; the agent decides and, for long work, starts a background job. The owner is told in Telegram when `agent.<slug>.job.finished` events arrive, and agent messages and approval questions are pushed to the chat. It relays agents' approval questions (`chatApprovalRequest`) to the owner and sends the labelled decision back, forwards events from the alert rules and the nightly digest without a model, and offers owner-only controls to pause or resume rules and hub sources and to switch an agent's handlers off (`EVENTS.md`). It encodes the pipeline: ticket triage, developer, reviewer, (autofix loop), QA, Windows build when C++ is touched.

**Setup (ADR 0004, `docs/OPERATIONS_SETUP.md`).** The Manager is the one agent that is not on the kit: it runs the stock Pi CLI (1.1.0, the first release with an MCP client; the pilot ran 0.87.1). It takes the same setup documents as the kit's agents, from the service principal `operations` only, and applies them to Pi: `mcp.json` (secrets only as `${NAME}` references from the Manager's own environment, local servers downloaded over https and checked by SHA-256), skill folders under `skills/library/<name>`, an addendum after its read-only built-in prompt, the model, and approval patterns that its own policy enforces on bash commands and MCP calls through a gate in the Pi extension. A new setup restarts the Pi process once no run is going (never during one). It serves its applied revision on `GET /profile` (port 7080) so that Operations polls it like an agent's `/profile`. Details and what takes effect when: `adapters/manager/README.md`.

### Developer (exists)
`code.agent`: durable Pi run in a sandbox, git steps done by service code, approvals asked of the approver in the conversation, budgets, draft PRs. Started with the `code_agent` job tool.

### Windows developer
Same kit and the same protocol (clone, branch `agent/<job>`, commit, push, PR) with these differences:
* Provides `code.windows`; input adds `{ build?: {solution, configuration}, tests?: string[] }`; output adds `{ build: {ok, log artifact}, tests: {...} }`.
* **No Docker on that machine**, so the sandbox is a local `ExecutionEnv` (kit interface `ExecutionEnv`) under a dedicated unprivileged
  Windows account whose only writable area is the workspace root; egress is limited by Windows Firewall rules to the model API, the
  git host, the package feeds and the SomeWork domain. This is a weaker boundary than the container sandbox and is documented as such;
  the profile therefore keeps approvals on for anything outside build/test/git.
* Runs as a service/scheduled task at boot (the machine already has an elevated build task and the toolchain: MSBuild, .NET, Node, git).
* Source encoding rules of the repository (legacy files are not UTF-8) are enforced by tool choice in the profile (encoding-safe edit
  tool) and a check step before commit (the repository's own encoding check, configured as a test profile).

### Reviewer
`code.review` v3 (compatible with v2; adds `pr` and `ticket`): checks out the ref read-only, loads the allowed review skills, gathers PR
context (diff, checks, existing threads), and returns `{verdict, summary, findings[{severity,file,line,text}]}` plus the full report
as an artifact. Started by the `review_code` job tool or by the `pr-review` event handler (rule `rules/reviewer-prs.yaml`). Drafted inline comments are **returned, not posted**; posting is a separate approved action (Manager).

### QA
`qa.verify` v1: input `{ ticket, repository, app?, scenario? }`. Started by the `verify_ticket` job tool (a person or agent asks for a ticket, or "the tickets in Test") or by the `qa-ticket` event handler (rule `rules/qa-ticket.yaml`: a ticket moving to Test). Runs the adapted QA skill: resolves the revision of the ticket's pull request, builds a clean worktree, starts the app against the remote test backend, drives a real browser, builds fixtures, records a short video as an artifact, returns
`{verdict: verified|not_fixed|blocked|skipped, evidence[], fixtures[], notes}` and posts the findings to the conversation. The application stack is a singleton resource: verifications run one after another and say what they wait for.
The ticket-system writes (comment, label, hand-back to the previous assignee) are made by the job's own tools; they ask for approval only where `QA_JIRA_APPROVE` says so (the deployment sets `none`), and the "never move to Done" rule is a hard constraint in the tool layer, not only in the prompt.
The role is built and tested; its machine (a Windows clone with a browser and the product's local back end) is prepared, and it waits for the product's web database to be restored before it can verify a ticket.

## Conversations and jobs

Agents do not take tasks. A message sent to an agent (by a person, the manager, another agent, in a one-to-one or a group conversation) is read by its model, which decides what to do: answer, ask someone else, or start a **job**. Everyone in the domain is trusted; there is no list of askers. Details and the reasons: `docs/adr/0003-messages-and-events-replace-tasks.md` and `packages/agent-kit/README.md`.

* **Messages** are written to a durable inbox before they are acknowledged and handled once; after a restart every unfinished message is taken up again. A message gets a model run of its own; several conversations go on at once, one message at a time within each. A backlog is worked through one message at a time, people first, beside the live conversations, and the model is told how long a message waited. The answer goes to everyone in the conversation unless the model answers `NO_REPLY`; hop depth (16) bounds agent-to-agent loops.
* **Jobs** are the role's capabilities as tools (`verify_ticket`, `fix_issue`, `review_code`, ...). A call starts the work in the background and returns; the job runs through the role's normal handler (sandbox, git protocol, guards, approvals, budget) and posts one result message to the conversation with its artifacts. A job that needs something only one job can have (QA's application stack) waits for it and says so. A message in the conversation of a running job is handed to the job's model as a note, and `job_stop` is a signal the job's model decides about. Agents publish `agent.<slug>.job.started|waiting|finished` events: the Manager tells the owner when jobs finish and the dashboard's Work view is built from them.
* **Approvals** for risky steps are asked of the approver (default the Manager and people) in the conversation with labelled messages (`chatApprovalRequest` / `chatApprovalDecision`, `approve` or `deny`); silence for ten minutes is a denial. The Manager relays them to the owner in Telegram.
* **Budgets.** Conversation runs draw on the `chat` pool, jobs on the `tasks` pool; the per-agent daily limits are a runaway guard and the money budget is global (Prometheus and the Manager).

| Role | Job tools | Extra tools in a conversation |
|---|---|---|
| Developer | `code_agent` (`code.agent`) | none |
| Reviewer | `review_code` (`code.review`; read-only) | none |
| Windows developer | `windows_develop` (`code.windows`) | none |
| QA | `verify_ticket` (`qa.verify`; holds the application stack) | the Jira read tools |
| Aikido fixer | `fix_issue` (`code.fix`), `follow_up_pull_request` (`code.fix.followup`) | `fixer_status`, `aikido_lookup` |
| Datadog triage | `triage_monitor` (`ops.triage`) | the six Datadog read tools |
| Manager | n/a | the Manager asks agents for things in messages (`somework_message`) and relays their approvals and job results to the owner |

### Raising a budget

When an agent has used up a token pool, or the owner wants it to be able to do more today, the owner asks the Manager in chat; there is no command for it. The Manager's `somework_control` tool takes `raise_budget` (agent, pool `tasks`, `events` or `chat`, tokens, reason), asks the owner to confirm with a Telegram button (the model cannot raise anything by itself) and, once confirmed, sends the agent a direct message labelled `budgetControl: raise`. The kit applies it only from a controller (`BUDGET_CONTROLLERS`, default the events controllers, that is the Manager), adds the tokens to that pool's limit **for the current day only**, and answers with the new limit. `tasks` is the whole daily limit (`DAILY_TOKEN_LIMIT`), `events` and `chat` are their own pools (and the weekly events cap rises with `events`). One request adds at most 10 million tokens, and an agent accepts at most `BUDGET_RAISE_CEILING` (default one extra daily limit) per pool and day, over all raises. `somework_handlers` shows each pool's used and limit with the amount raised today. The per-job caps (`BUDGET_MAX_TOKENS_CAP`, `BUDGET_MAX_MINUTES_CAP`) and the chat instruction budget are settings in the agent's `.env`, rolled through CI; they are not raised from chat.

## Asking the hub for a timer

Any kit-based role can ask the event hub to wake it later ("trigger me with this in 15 minutes"): set `TIMERS_URL` (the hub's TLS address), `TIMERS_TOKEN_FILE` (the agent's own token, `somework-hub timer-token <agent id>` on the hub) and `TIMERS_CA_FILE`, and list the agent in the hub's `timers.agents` (`packages/events-hub/README.md`, "Timers"). The model gets `schedule_followup` (minutes, a self-contained note, an optional key), `list_followups` and `cancel_followup` in tasks and in the instruct and open chat tiers, and role code gets `context.timers`. The wake arrives as the event `clock.timer.<agent>.due`; the role needs one rule that turns it into a wake and a handler that decides what the wake means. Timers are one-shot, 1 minute to 7 days away, at most 20 pending per agent; asking again with the same key moves the timer.

The Aikido fixer uses it to follow up on its own pull requests: after it opens one it asks for a look after 15 minutes, then 60 and 240 (`AIKIDO_FOLLOWUP_MINUTES`, `off` to disable). The wake starts a `code.fix.followup` job for itself, which reads the reviews, comments and failing checks that came after the branch's newest commit (reviews, inline comments and failing checks from anyone, automated reviewers included, and plain comments from people, as data) and, when there are some and the pull request is still open, pushes a follow-up commit to the same branch. A closed or merged pull request, or one with nothing new, ends as `skipped` without cloning anything, and the next look is asked for while checks are left.

## Observe tools

Any pi-based role can be given read-only access to the central Grafana (Loki logs, Prometheus metrics, alert state, dashboard search) to read its own history or, for
roles with fleet scope, the rest of the fleet: `logs_query`, `my_history`, `logs_labels`, `alerts_status`, `dashboards_search`, `metrics_catalog`, `metrics_query`, `llm_usage`. They are off by
default (`OBSERVE_ENABLED=1`, `GRAFANA_URL`, `GRAFANA_TOKEN_FILE`); the token belongs to a Viewer service account created by
`deploy/grafana/provision-reader.py` and never enters the sandbox. A role with own scope has its matchers added to every query. Queries are parsed and
rebuilt (no aggregations, sub-queries or `offset`), answers are redacted, size-capped and framed as untrusted data. Allowed in conversations. Limits: Loki logs and Prometheus metrics (no traces), log history reaches as far as Loki retention and at most 168 hours per query, metrics at most 720 hours (Prometheus keeps a year). `llm_usage` and the *LLM usage and cost* dashboard answer "who spent how many tokens and dollars on which model"; own scope shows only the asking agent. Settings: `packages/agent-kit/README.md`.

## Identity on the code host, and how an agent shows its setup

* **GitHub identity.** By default a role pushes with a fine-grained personal token and everything shows up as the token's owner. A role can instead be a
  GitHub App (`GITHUB_APP_ID`, `GITHUB_APP_KEY_FILE`): the kit mints one-hour installation tokens, renews them before every git command and API call and
  commits as `<app>[bot]` (`packages/agent-kit/README.md`, "GitHub App identity"). One app per role keeps permissions separate; registering the apps is
  an organisation owner's step.
* **`/profile`.** Every kit service describes its own setup on its health port: prompt (hash and text), tools and approval patterns, budgets, model,
  credential kind, skills, chat and event settings, plus a hash and the time the setup last changed. The fleet dashboard shows it as one card per agent
  (`dashboard/`). No secret is in it, and the dashboard reads it through a restricted reader as well.
* **Gates before work.** `beforeWorkspace` lets a role end a job from its input alone (the fixer skips an ineligible issue) before anything is cloned;
  `beforeRun` runs once the workspace exists.
* **Rolling.** `deploy/agents/roll-agent.sh` moves a stack to a new tag, waits for `/ready` and restores the old files when the agent does not come up.

## Cross-cutting rules

* Every agent has its **own SomeWork identity and its own credentials**; no shared tokens, no shared model logins (OAuth refresh tokens
  rotate on use).
* **Least privilege per role**: reviewer has no push token; QA has no push token; only developers push, only to `agent/*` branches via a
  token scoped to the one repository.
* Every handoff names a **resolved SHA**. Every job has a **budget**. Every write needs an **approval path**.
* Provider choice is per job within an allowlist; the default is the paid provider the organisation has approved. Personal-account or
  third-party-routed providers are opt-in only.

## Build order

1. Workspace + `agent-kit` extraction. **Done.**
2. Skill loader with allowlist and overlay support. **Done** (`packages/agent-kit/src/skills.ts`).
3. Reviewer. **Done and live.**
4. Windows developer (local `ExecutionEnv`, Windows service packaging). **Done and live.**
5. QA. **Built; deployment waits for the web database restore.**
6. Manager orchestration, approvals and controls. **Done and live.**
7. Events and rules, event handlers and token pools in the kit. **Done and live** (`EVENTS.md`).
8. Messages and events replace tasks: conversations, background jobs, singleton resources, job events. **Implemented 2026-10-10, not yet deployed** (`docs/adr/0003-messages-and-events-replace-tasks.md`).

## Decisions taken since

1. **QA environment:** a Windows clone with Edge and headless Playwright, a dedicated test user and a ticket-system token with minimal scope; the human Chrome profile is not reused.
2. **Windows sandbox strength:** local unprivileged account plus firewall allow-list, accepted as the weaker boundary and documented as such.
3. **QA overlay:** kept in deployment configuration outside the repository (company content), applied on top of the repository's base skill.

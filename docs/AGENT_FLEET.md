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
developer  --{repo, branch agent/<task>, commit sha, prUrl, diff artifact}-->  manager
manager    --{repo, ref=sha, pr, ticket}-->  reviewer      (read-only review)
manager    --{repo, ref=sha}-->              windows-developer (build/test on Windows) and qa (browser)
reviewer   --{verdict, findings[]}-->        manager  -- fixes needed -->  developer (same branch, new commits)
```

* The **git remote is the exchange medium**. Every handoff carries `{repository.url, ref}`, and the ref is a **resolved commit SHA**,
  so a reviewer or QA run is always about exactly the code that was produced, even if the branch moves.
* Results larger than a few KB (diffs, review reports, videos, logs) are **artifacts** in SomeWork, referenced from the task result.
* Long conversations that must change hands (a half-done task, ownership) use a **ContextPack**, not copied prompts.
* **Same branch, many agents:** the developer owns `agent/<task>`. Others never push to it; follow-up fixes are new developer tasks
  with the same `agentKey`, so the durable conversation (and its workspace) continues.

### 3. Knowledge (rules, skills, prompts): the target repository is the source of truth

The repository the agents work on already carries its own instructions (`AGENTS.md`, `.agents/skills`, `.claude/skills`,
`.claude/agents`). The kit's skill loader reads them **from the checked-out ref at task time** and adds an index (name and
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

### 4. Capabilities: contracts, not code

Agents never call each other's functions. They submit tasks against **capability cards**; the card (input/output schema, side
effects, budget requirement, tags) is the interface. This is what lets the Windows developer be a different program on a different
operating system and still be a drop-in provider: it only has to honour the contract. Two agents that are interchangeable provide the
same capability id; agents that differ in a way that matters (Windows vs Linux) provide different ids so routing is explicit.

## Roles in detail

### Aikido fixer (live)
`code.fix` v1 on the same kit and git protocol as the developer, started by events instead of a requester: the rule `rules/aikido-fixer.yaml` wakes it for `aikido.*` events, its shipped handler turns an eligible issue into one task for itself, and the task works in a fresh clone (from a persistent mirror) at the resolved commit of the default branch. It reads the issue through a host-side, read-only Aikido client, refuses protected paths, secret-like text, oversized changes and a failing check profile, and opens a pull request (a real one by default, a draft with `GIT_PR_DRAFT=1`) on `agent/aikido-<issue>-<sha>`. Approval requests are refused (nobody answers for it). Limits are enforced twice: by the handler in the sandbox as an early filter and by a ledger on the service host as the authority. See `adapters/aikido-fixer/README.md`.

### Datadog triage (live)
`ops.triage` v1 (side effects `read`), started by events like the fixer: the rule `datadog-triage` wakes it for `datadog.monitor.*` events (`rules/datadog-triage.yaml`, added once the agent was enrolled, because the rules pipeline refuses a rule whose owner does not exist; the existing `alert-datadog-to-manager` rule stays), its shipped handler turns an eligible alert into one task for itself, and the task works on no repository (`profile.noRepository` in the kit: an empty scratch directory). The model reads Datadog through six read-only tools that run in the service, where the keys are (monitor, monitor search, logs, metrics, events, incidents); `save: true` writes the full redacted result into `data/` in the workspace, and `python3` (standard library), `jq` and a few text tools in a sandbox with **no credentials and no network** (its own image: the developer sandbox plus python3; no egress proxy) analyse it under a command policy (anything else, including any approval, is refused). The answer is one json diagnosis (severity, summary, suspected cause with confidence, timeline, evidence, actions); the service checks that every finding cites a tool call or is marked inference, allows one repair turn, and sends the owner one deterministic notice (at most 1500 characters, secrets and links stripped, the monitor link built by the service) to `agent/manager`. Limits are enforced twice, like the fixer's: handler early filter, host ledger as the authority. See `adapters/datadog-triage/README.md`.

### Manager (live)
Existing Telegram bridge (owner pairing, private chat only) retrofitted: SomeWork identity `agent/manager` held by the bridge, a narrow
local gateway that the Pi process reaches through tools (catalog, submit, task, cancel, message, inbox). Write-side-effect submissions
need owner approval in Telegram; budgets are capped; task results, questions and agent messages are pushed to the chat.
It also relays domain approvals (reactions that need a write capability), forwards events from the alert rules and the nightly digest without a model, and offers owner-only controls to pause or resume rules and hub sources and to switch an agent's handlers off (`EVENTS.md`). It encodes the pipeline: ticket triage, developer, reviewer, (autofix loop), QA, Windows build when C++ is touched.

### Developer (exists)
`code.agent`: durable Pi run in a sandbox, git steps done by service code, approvals through `input_required`, budgets, draft PRs.

### Windows developer
Same kit and the same protocol (clone, branch `agent/<task>`, commit, push, PR) with these differences:
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
as an artifact. Drafted inline comments are **returned, not posted**; posting is a separate approved action (Manager).

### QA
`qa.verify` v1: input `{ ticket, ref? }`. Runs the adapted QA skill: resolves the SHA, builds a clean worktree, starts the app against the
remote test backend, drives a real browser, builds fixtures, records a short video as an artifact, returns
`{verdict: verified|not_fixed|blocked|skipped, evidence[], fixtures[], notes}`.
**The ticket-system writes of the original skill (comment, label, transitions) become Manager-approved follow-up actions**, because
they are visible side effects; the "never move to Done" rule is kept as a hard constraint in the tool layer, not only in the prompt.
The role is built and tested; its machine (a Windows clone with a browser and the product's local back end) is prepared, and it waits for the product's web database to be restored before it can verify a ticket.

## Chat

Every role answers a direct `chat.message` with a model (`profile.chat.mode`, `model` by default; `CHAT_MODE=notice` goes back to the
deterministic notice). Two tiers, decided by who sent it and by an explicit prefix, never by what the text says:

| | ASK | INSTRUCT |
|---|---|---|
| Who | `agent/manager` and every human (`CHAT_ALLOWED_SENDERS`) | `agent/manager` only (`CHAT_INSTRUCTORS`), message starts with `instruct:` |
| What runs | one bounded model turn in a light session | the role's normal handler as a synthetic job: same sandbox, tools, guards, approvals, git protocol |
| Tools | `read`, `agent_status`, the role's read-only tools; never bash, edit or write | what the role's tasks have (`profile.allowedTools`) |
| Limits | 40 000 tokens, 2 minutes, halved when the chat pool is 80% used | chat budget 150 000 tokens, 15 minutes, never above what the `chat` pool has left |
| Approvals | all refused | asked of the instructor in the conversation (`chatApprovalRequest` / `chatApprovalDecision` labels), denied on silence after 10 minutes |

| Role | Extra read-only tools for questions | What `instruct:` does |
|---|---|---|
| Developer | none | a `code.agent` v2 task on `repo:` or `CHAT_REPOSITORY_URL`, then branch and pull request as usual |
| Reviewer | none | a `code.review` v3 task (`repo:`, `ref:`, `pr:`, `ticket:`, the rest is the focus); still read-only |
| Windows developer | none | a `code.windows` task (`repo:`, `ref:`, `build:`, `tests:` as named profiles), in the confined environment |
| QA | none | a `qa.verify` task for the ticket named in the text (`repo:`, `ref:`, `scenario:`, `app:`); ticket writes still need approval |
| Aikido fixer | `fixer_status` (attempts, limits, outcomes), `aikido_lookup` (one issue by id) | a `code.fix` task for "fix issue N" on its configured repository, through the same eligibility, daily cap, attempt limits and guards; approvals stay refused |
| Datadog triage | the six Datadog read tools (no bash, no python); the state summary has today's triages and the recent outcomes | an `ops.triage` task for "triage monitor N" (optional `window:` line), with the same tools, command policy and limits as an event's task (bash and python3 in the sandbox); approvals stay refused |
| Manager | n/a | the Manager is the instructor: `/ask <agent> instruct: ...` sends it, `/chatapprove <id>` and `/chatdeny <id>` answer the agent's approval questions |

The chat has its own `chat` token pool (a tenth of the daily limit by default), shares job slots with tasks (tasks first, nothing
preempted), answers one message at a time (a waiting message is told "busy, queued"), answers each sender and conversation at most
once per 15 seconds and 20 times an hour, and never answers its own messages, replies or automatic notices, so agents cannot loop.
Replies are redacted and at most 4 KB. An instruction has no task in the domain, so its artifacts are never uploaded: small text results (patch, report, logs) are shown in the reply, everything else stays on the agent host and the reply names where. A second message inside the 15-second window gets one automatic notice telling the sender when to write again. All the settings are in `packages/agent-kit/README.md`.

## Observe tools

Any pi-based role can be given read-only access to the central Grafana (Loki logs, alert state, dashboard search) to read its own history or, for
roles with fleet scope, the rest of the fleet: `logs_query`, `my_history`, `logs_labels`, `alerts_status`, `dashboards_search`. They are off by
default (`OBSERVE_ENABLED=1`, `GRAFANA_URL`, `GRAFANA_TOKEN_FILE`); the token belongs to a Viewer service account created by
`deploy/grafana/provision-reader.py` and never enters the sandbox. A role with own scope has its matchers added to every query. Queries are parsed and
rebuilt (no aggregations, sub-queries or `offset`), answers are redacted, size-capped and framed as untrusted data. Allowed in ASK and INSTRUCT
chat. Limits: Loki logs only (no Prometheus, no traces), history reaches as far as Loki retention, at most 168 hours per query. Settings: `packages/agent-kit/README.md`.

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
* Every handoff names a **resolved SHA**. Every task has a **budget**. Every write needs an **approval path**.
* Provider choice is per job within an allowlist; the default is the paid provider the organisation has approved. Personal-account or
  third-party-routed providers are opt-in only.

## Build order

1. Workspace + `agent-kit` extraction. **Done.**
2. Skill loader with allowlist and overlay support. **Done** (`packages/agent-kit/src/skills.ts`).
3. Reviewer. **Done and live.**
4. Windows developer (local `ExecutionEnv`, Windows service packaging). **Done and live.**
5. QA. **Built; deployment waits for the web database restore.**
6. Manager orchestration, approvals and controls. **Done and live.**
7. Events and reactions, event handlers and token pools in the kit. **Done and live** (`EVENTS.md`).

## Decisions taken since

1. **QA environment:** a Windows clone with Edge and headless Playwright, a dedicated test user and a ticket-system token with minimal scope; the human Chrome profile is not reused.
2. **Windows sandbox strength:** local unprivileged account plus firewall allow-list, accepted as the weaker boundary and documented as such.
3. **QA overlay:** kept in deployment configuration outside the repository (company content), applied on top of the repository's base skill.

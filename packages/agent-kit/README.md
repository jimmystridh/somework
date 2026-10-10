# @somework/agent-kit

The shared runtime of the SomeWork agents. **A role is a card, a profile and a `main.ts`**; everything else is here.

```
sdk/typescript          @somework/sdk        client, claim loop, wake (NATS + sweep), identity
packages/agent-kit      @somework/agent-kit  this package: the agent runtime shared by every role
adapters/pi             the developer role   card.json + src/profile.ts + src/main.ts + Dockerfile + deploy/
adapters/manager        the Telegram manager (a requester, not a task-serving role: it uses the SDK only)
```

One npm workspace (`package.json` at the repository root, one `package-lock.json`, `.npmrc`). `npm ci` once, `npm test` runs
every package's tests, `npm run check:roles` checks the boundaries below.

## The role contract

```ts
// adapters/<role>/src/profile.ts
import { DEFAULT_APPROVAL_PATTERNS, validateProfile, type AgentProfile } from "@somework/agent-kit";
import card from "../card.json" with { type: "json" };

export const profile: AgentProfile = validateProfile({
	id: "reviewer",
	capabilities: card.capabilities.map(({ id, version }) => ({ id, version })), // must be what card.json declares
	systemPrompt: "You review; you never change files.",   // standing orders for every conversation
	allowedTools: ["read", "bash"],                         // the model is offered only these; unset = all coding tools
	approvalPatterns: DEFAULT_APPROVAL_PATTERNS,            // commands that wait for a human
	defaultBudget: { maxTokens: 200_000, maxMinutes: 15 },  // used when requireBudget is false and the job brings none
	requireBudget: false,
	git: { push: false, pullRequest: false, branchPrefix: "review" }, // read-only role: nothing leaves the workspace
	skills: { allow: [], overlayDir: undefined }, // repository skills this role may use; empty = none, the deployment sets SKILLS_ALLOW
});

// adapters/<role>/src/main.ts
import { runAgentService } from "@somework/agent-kit";
import { profile } from "./profile.ts";
runAgentService({ profile /*, hooks */ });
```

A profile can also name tools other than `bash` that wait for a human (`toolApprovals`: tool name to a function from the call's arguments to
a summary, or `undefined` for no approval), so a role's own tools with side effects (a ticket system, a deployment) go through the same
`input_required` path as a risky command.

`hooks` (`RoleHooks`) is where a role has code instead of data. All members are optional, and `hooks` may also be a function that
receives the service being composed (`ServiceContext`: env, config, log, SomeWork client, git token) and returns them. Without hooks the
handler is the developer's: `input.instruction`, `{repository: {url, ref}, budget}` in, branch `agent/<task>` and a pull request out.

| Hook | When / what |
|---|---|
| `prepareInput(input, {taskId, log})` | async, first: enrich the input (fetch context). Throw `InvalidInput` to refuse. **What it returns is the job from here on**: `repository` (a role may fill in the ref), `agentKey`, `budget` and `model` are read from it, not from the submitted input |
| `instruction(input, {taskId})` | turn the input into the model's instruction. Throw `InvalidInput` to refuse |
| `envFactory(cwd)` | the role's own `ExecutionEnv` for the model's tools and the git steps instead of the container sandbox (no sandbox token needed, no sandbox health check) |
| `healthBind` | interface of the health endpoint (default `0.0.0.0`) |
| `beforeRun(ctx)` | once the workspace is ready, before the model runs (start the application under test, prepare fixtures); `ctx.signal` stops it. Return `{ blocked: {reason, details?} }` to skip the model: the task completes with `status: "blocked"` without spending a token. Throwing fails the job as a retryable `job_error` |
| `afterRun(ctx)` | after the model run, whatever happened (answer, failure, stop, detach, blocked, a throwing `beforeRun`): stop what `beforeRun` started. Called once per attempt as soon as the workspace was ready; an error it throws is logged (`after_run_failed`) and never changes the outcome |
| `wrapRuntime(runtime)` | wrap the `AgentRuntime` once (repair turns, output validation) |
| `beforeFinalize(ctx)` | after the model, before commit/push, for every role. Return `{ blocked: {reason, details?} }` to keep the work in the workspace: the task completes with `status: "blocked"` (metrics label `blocked`, log `job_blocked`, never counted as unanswered) |
| `pullRequest(input, {taskId, instruction})` | title and body of the pull request (called after `beforeFinalize`); an optional `commitMessage` replaces the default `agent: <title>` (first line is the subject, the rest the body) |
| `branchName({input, taskId, baseSha})` | the task branch instead of `<prefix>/<taskId>`, from the commit the work starts from. It must stay under `<prefix>/` or the job fails, and it must answer the same for a retry of the same job |
| `result(base, ctx)` | reshape the result: return `{ result }` (replaces `base`; spread it to extend), `{ artifacts }` (added to the diff artifact), or `{ failure }` to fail the task. Runs for completed, no-changes and blocked runs |
| `resume({...ctx, branch, sha})` | a retry of the same task whose branch an earlier attempt already pushed from this workspace, with no pull request yet: return `{ answer }` to skip the model run (nothing is spent, `job_resumed` is logged) and go straight to `beforeFinalize` and the git step, which opens the pull request; return nothing to run the model as usual. Only called for roles that push |
| `onSettled(taskId, outcome)` | once per finished job (never for a detach): drop per-job state |
| `extensions`, `readinessChecks` | extra Pi Durable extensions (tools, prompt sections) and `/ready` checks |

The context of `beforeFinalize` and `result` carries `taskId`, `input` (as prepared), `instruction`, `workspace`, **`baseSha`** (the full
commit the work started from), `baseBranch`, `envFor(cwd)`, `client`, `log`, the model's `answer` and `usage`, and (for `result`)
`finalize` (the git outcome) and `blocked`. `baseSha` is not in the default result (a card is a contract); a role adds it in `result`.

### Refs: every handoff names a commit

`repository.ref` may be a **branch, a tag, a full or abbreviated commit SHA, or `refs/pull/<n>/head`**. The kit resolves it to a full SHA
(`prepareWorkspace` returns `baseSha`, `baseBranch`, `refKind`; the job logs `workspace_ready`) and fetches an unreachable commit by its exact
SHA (a pull request head, a rewritten branch). An abbreviated SHA must be reachable from a branch or tag. An unknown or malformed ref fails
the task as non-retryable `ref_not_found` before the model runs. Roles that push (developer, Windows developer) create `<prefix>/<taskId>`
from the commit; read-only roles (`git.push: false`) get it checked out detached, so a review or a QA run is about exactly that code.
`repository.ref: "HEAD"` means the remote's default branch at the moment the task runs (the base of the pull request is that branch's name). The pull request targets `repository.baseRef` when given, else the ref when it is a branch, else the remote's default branch (a card that
wants `baseRef` must declare it in its input schema).

A role that works on **no repository** (the Datadog triage agent reads another system through its tools) sets `noRepository: true` in its profile (it needs `git.push: false`). The job then needs no `repository`, nothing is cloned, the model gets an empty scratch directory as its workspace, and `baseSha`, `baseBranch` and the branch in the hooks' context are empty strings. Every other role still needs `repository {url, ref}`.

**The task branch on the remote is never rewritten.** `finalizeWorkspace` asks the remote (`ls-remote`) before it pushes: a branch the remote does not have is created; one that already
holds the same commit or the **same tree** under another commit id (a rerun of the same change) is reused as it is, nothing is pushed and the commits reported are the remote's;
one whose tip the local work builds on gets a plain fast-forward; anything else is different work under the same name, so the work goes to `<branch>-2`, `-3` ... up to `-5`
(each checked the same way, so a rerun finds its own earlier suffix again). When all five are taken the job fails, not retryable, with `branch_exhausted` and nothing is pushed.
The result's `branch` is the name really used (and the pull request head); `reused: true` says nothing was pushed. After a push the workspace records `somework.pushed` (task, branch, commit),
which is what `resume` is offered on. There is no force push anywhere.

**Persistent mirror (opt-in).** With `GIT_MIRROR_DIR` set (a directory inside the sandbox, for example `/workspace/.mirrors`) the kit keeps a bare mirror of
each repository it works on (branches and tags only, never the remote's pull request refs), refreshes it before a task that needs a new clone and, for
the repositories listed in `GIT_MIRROR_REPOS`, every `GIT_MIRROR_REFRESH_MINUTES` (default 30), and clones the workspace from it: the clone is a local copy,
`origin` is pointed back at the real remote and one `fetch` brings it to the moment of the task. Refreshes of one mirror are serialised, the token goes only
through the usual credential helper, and an unreachable remote falls back to the stale mirror (the fetch from origin then decides) or to a direct clone.
`refreshMirror`, `startMirrorRefresh` and `mirrorPathFor` are exported from `git` for roles that need them.

`createAgentService({ profile, hooks })` does the rest: SomeWork identity and claim loop (NATS wake with an HTTP safety net),
the sandboxed Pi Durable runtime, git workspace, budgets and the daily ledger, shard check, approvals, the model providers and
the per-job model allowlist, skills, `/live` `/ready` `/metrics`. Settings come from the environment (`src/config.ts`).

**Roles never import each other.** `scripts/check-roles.ts` (run by the kit's tests and by `npm run check:roles`) fails on an import
that crosses `adapters/<a>` to `adapters/<b>`, from the kit to a role, or from the SDK to the kit or a role. If two roles need the same
code it moves here.

## What is in here

| Module (subpath export) | |
|---|---|
| `profile` | `AgentProfile`, `RoleHooks`, hook context types, `InvalidInput`, `validateProfile` |
| `service` | `createAgentService`, `runAgentService`: composes a role into a running service |
| `handler` | the repository-task handler: validate, capability check, budget clamp, ledger, shard, model allowlist, workspace, run, finalize, artifact, metrics |
| `runtime`, `pi-runtime` | `AgentRuntime` (what everything depends on) and the Pi Durable implementation (the only file that knows Pi); `allowedTools`, `instructions` |
| `providers`, `providers/allowlist`, `providers/antigravity`, `providers/faux` | `openai-codex`, `openai`, `opencode-go`, `antigravity`; the model allowlist; the credential-free scripted model for tests (`bash:`, `write:`, `read:`, `call:<tool>:<json>` for a role's own tools, `final:`) |
| `git`, `githost` | idempotent clone / branch / commit / push / PR steps run by our code, the host-restricted credential helper, `GitHubHost` |
| `sandbox/server`, `sandbox/remote-env`, `egress/proxy` | the sandbox daemon, Pi's `ExecutionEnv` over HTTP, the egress allowlist proxy (their `main.ts` files are the container entry points) |
| `policy`, `ledger`, `shards`, `metrics`, `log`, `credentials`, `config`, `health` | approvals, daily token ledger, shard table, Prometheus metrics, redacted JSON logs, `auth.json` store, env config, `/live` `/ready` `/metrics` |
| `windows` | what every role that runs on a Windows machine needs: the confined local `ExecutionEnv` (Git Bash, path confinement, environment allow-list, sweep of the service account's leftover processes), log redaction, the machine settings (`WINDOWS_*`) and `windowsExecutionHooks(settings)` that wires them into a service |
| `threads` | conversations and jobs: durable inbox, conversation engine, job manager, resources, thread tools (below) |
| `skills` | the repository knowledge loader (below) |
| `testing` | `makeRemote` (a local bare repository), `FakeHost`, `sh`, `jobRig` (a job through the real job manager and artifact handling): for role tests |

## Conversations and jobs: agents talk, and long work runs in the background

Agents do not take tasks. Every `chat.message` addressed to an agent (a person, the manager, another agent, a group conversation) is read by its model. Decisions: `docs/adr/0003-messages-and-events-replace-tasks.md`.

* **Nothing is lost.** A message is written to the agent's durable inbox (`threads/inbox.json` in its state directory) before its wake is acknowledged and is handled once per message id. After a restart every unfinished message is taken up again, and the service sweeps the domain's unread inbox at start and every minute for what no wake announced. The first start of an agent ever treats what the domain holds for it as history (marked read, not answered).
* **A run per message.** The message gets a model run of its own (`thread:<messageId>`, a scratch directory per conversation, the role's tools and the kit's thread tools). Several conversations go on at once (`THREADS_MAX_CONVERSATIONS`, default 4), one message at a time within a conversation. A backlog (found after a start, or sent more than two minutes before it arrived) is worked through one at a time, people before agents, oldest first, beside the live conversations; the model is told how long a message waited. Everyone in the domain is trusted: there is no list of askers.
* **The answer goes to everyone in the conversation** (the sender and the others the message was addressed to) unless the model answers exactly `NO_REPLY`. Receivers decide for themselves whether to answer; the domain's hop depth (`causationId` chain, default 16) bounds agent-to-agent loops.
* **Jobs.** A role's capabilities are `hooks.chat.jobTools` (name, description, TypeBox parameters, `plan(args)` that returns `{capability, input, label}` or `{refuse}`). A call starts the job at once in the background (`JobManager`, `threads/jobs.ts`), through the same `createHandler` pipeline as always (same sandbox, git protocol, guards, approvals) with the profile's `defaultBudget`. The result is posted to the conversation as one message, with the artifacts the job uploaded; `agent.<slug>.job.started|waiting|finished` events are published (the agent needs the permission `events.publish:agent.<slug>.`). Running jobs are written to `threads/jobs.json` and started again under the same run id after a restart. Events: a handler's `submit` decision starts a job of the agent.
* **Singleton resources.** `hooks.chat.jobResources(capabilityId, input)` names what only one job can hold (QA: `app-stack`). A job waits (FIFO, people first) until all of its resources are free and says what it waits for. The `resources` tool shows who holds what; using one by hand in a conversation is advisory.
* **Talking to a running job.** A message in the conversation of a running job is also handed to the job's model at its next turn boundary, as a note, and the conversation's own run answers in parallel. Tools of a conversation run: `job_status`, `job_stop` (a signal only: a job that has not started does not start, a running job's model decides what to do), `resources`, `message_send` (write to somebody else; the answer arrives as a message), `attachment_get` (save an attachment of the domain into the scratch directory), `agent_status`, the role's tools and `read`, `write`, `edit`, `bash`.
* **Approvals.** A step that needs approval is asked of the approver (`profile.chat.approvers`, default `agent/manager` and `kind:human`; the message's sender when they are one) as a message labelled `chatApprovalRequest=<id>`; only that principal's message labelled `chatApprovalDecision=<id>` with the text `approve` or `deny` decides. Silence for ten minutes is a denial.
* **Budget.** Conversation runs draw on the `chat` pool, jobs on the `tasks` pool; the daily limits are a runaway guard per agent, the money budget is global (Prometheus and the manager).

| Setting (`profile.chat`) | Default | Environment override |
|---|---|---|
| `mode` | `on` | `CHAT_MODE=off` |
| `approvers` | `agent/manager`, `kind:human` | `APPROVERS` |
| `maxConversations` | 4 | `THREADS_MAX_CONVERSATIONS` |
| `liveWindowSeconds` | 120 | `THREADS_LIVE_WINDOW_SECONDS` |
| `runBudget` (one conversation run) | 150 000 tokens, 15 minutes | `CHAT_INSTRUCT_TOKENS`, `CHAT_INSTRUCT_MINUTES` |
| `hardTokenCap` | 200 000 | `CHAT_HARD_TOKEN_CAP` |
| `approvalMinutes` | 10 | `CHAT_APPROVAL_MINUTES` |
| `busyAfterSeconds` | 20 | `CHAT_BUSY_AFTER_SECONDS` |
| `share` / `throttleAt` | 0.1 / 0.8 | `CHAT_TOKEN_SHARE` / `CHAT_THROTTLE_AT` |


## `/profile`: how an agent is set up

Next to `/status` the health port serves `/profile`, a read-only JSON document the service builds from its loaded profile and settings (`describe.ts`): role and agent id, the image tag (`AGENT_VERSION`), the capability card ids, model and allowed models, the system prompt with its SHA-256 and length (`PROFILE_PROMPT=0` leaves the text out), allowed tools, command approval patterns (the deployment's own patterns are only counted) and tools that wait for approval, budgets and caps, concurrency, repository settings (push, pull request, branch prefix, the credential kind `token`, `github-app` or `none`, the bot's GitHub login with an app, token hosts, mirror, `GIT_TOKEN_EXPIRES` when set to a plain date), skills, chat settings (who may ask and instruct), events and observe state. Live handlers and token pools stay on `/status`. It holds no key, token, file path or environment value. `hash` identifies the setup (the version and the prompt text are not part of it) and `changedAt` is when this hash was first seen, kept in `profile-hash.json` in the state directory, so a dashboard can mark "changed since last seen". The port is private to the cluster; the prompt is company wording, so show it only through the private gateway.

## GitHub App identity instead of a personal token

By default a role pushes and opens pull requests with a fine-grained personal access token (`GIT_TOKEN_FILE`): everything it does shows up as the token's owner. A role can use a GitHub App instead, and then its commits, pushes and pull requests are made by `<app name>[bot]`.

| Variable | Meaning |
| --- | --- |
| `GITHUB_APP_ID` | the app's numeric id; with `GITHUB_APP_KEY_FILE` it replaces `GIT_TOKEN_FILE` (both set is an error) |
| `GITHUB_APP_KEY_FILE` | the app's private key (PEM), a 0600 secret file of this role only |
| `GITHUB_APP_INSTALLATION_ID` | needed when the app is installed more than once; with one installation it is found by itself |
| `GITHUB_APP_REPOSITORIES` | optional repository names the minted token is narrowed to, within what the installation allows |

The service signs a ten-minute JWT with the key, exchanges it for an installation token (one hour, limited to the installation's repositories and permissions), keeps it, and mints a new one five minutes before it expires; every git command and pull request call asks for a live one, so a long task never meets an expired token. The first token is minted at start, so a wrong key or installation stops the service there. Unless `GIT_AUTHOR_NAME` or `GIT_AUTHOR_EMAIL` is set, the commit author becomes the app's bot account with its noreply address (GitHub then shows the bot as the author). The token still only goes to `GIT_TOKEN_HOSTS`, through the credential helper, and is scrubbed from git output. Roles that hand the token to their own code (the reviewer's pull request context) receive `ServiceContext.gitTokenSource`. One app per role keeps the permissions separate: developer, fixer and Windows developer need Contents and Pull requests write plus Metadata read; the reviewer needs the same as read only.

## Observe tools: read-only logs, metrics and alerts

`createObserve` (`@somework/agent-kit/observe`) gives a role eight read-only tools over the central Grafana: `logs_query` (a stream selector
with line filters, `| json` and simple label filters, optionally `count_over_time`/`rate`; the text is parsed and rebuilt, never forwarded),
`my_history` (the role's own recent jobs, one line per task), `logs_labels` (what can be filtered on), `alerts_status` (the alert rules
of one Grafana folder), `dashboards_search`, and three over the central Prometheus: `metrics_catalog` (which metrics exist, and one metric's type, labels and
values), `metrics_query` (one metric, label matchers, a function such as `last`, `rate`, `increase` or `quantile`, an optional aggregation and grouping, a value
now or a series; the PromQL is built from the validated parts and never taken from the model) and `llm_usage` (input, output and cache tokens and cost in US
dollars per agent, role, provider and model over a period of up to the metrics look-back). A role with own scope gets `agent="<its agent id>"` added to
every metrics query. Results are redacted, capped in bytes and framed between random markers as untrusted data.
Off unless `OBSERVE_ENABLED=1` (or the profile's `observe.enabled`).

| Variable | Default | Meaning |
| --- | --- | --- |
| `OBSERVE_ENABLED` | off | `1` turns the tools on; then `GRAFANA_URL` and `GRAFANA_TOKEN_FILE` are required or the service does not start |
| `OBSERVE_SCOPE` | `own` | `own`: every query gets the `OBSERVE_OWN` matchers added (required, for example `container=~"somework-qa-agent-.*"`); `fleet`: any agent stream |
| `OBSERVE_MAX_RANGE_HOURS` | 24 | furthest look-back, at most 168 |
| `OBSERVE_HOURLY_CALLS` | 60 | calls per hour over all observe tools |
| `OBSERVE_MAX_BYTES` | 12288 | bytes of one answer |
| `OBSERVE_METRICS_MAX_RANGE_HOURS` | 720 | furthest look-back of the metrics tools, at most 2160 (costs are read over weeks) |
| `OBSERVE_METRIC_FUNCTIONS` | off | allows `count_over_time` and `rate` over one stream |
| `GRAFANA_URL`, `GRAFANA_TOKEN_FILE`, `GRAFANA_CA_FILE` | none | the Grafana origin, a Viewer service account token file (`deploy/grafana/provision-reader.py`) and an optional CA |
| `GRAFANA_LOKI_UID`, `GRAFANA_PROM_UID`, `GRAFANA_ALERT_FOLDER` | `cluster-loki`, `cluster-prometheus`, `Agent Cluster` | the Loki and Prometheus data sources and the alert folder |

The tools only read: GET requests to the one Grafana origin, no redirects, 15 s and size limits, the token stays in the service. They are allowed in
both chat tiers. Logs of a role's own sandbox commands, tickets and pull requests can hold hostile text, hence the framing. Status shows `observe` with the call count.

Every kit service exposes `/metrics` (Prometheus text) and every series carries `agent` (the agent id). Model usage is counted per run, while it runs, by
`somework_llm_tokens_total{agent,role,provider,model,kind}` (`kind` is `input`, `output`, `cache_read` or `cache_write`) and
`somework_llm_cost_usd_total{agent,role,provider,model}`, from the SDK's per-model usage record, so a job that picks another model is counted under that model.
The configured model's series start at zero because Prometheus does not count the first sample of a new series; a model that is used for the first time
only by one job request may miss its first scrape interval of increase. The host's Alloy scrapes the endpoint and pushes it to the central Prometheus
(`deploy/observability/`).

## Skills: the repository is the source of truth

The repository an agent works on carries its own instructions (`AGENTS.md`, `.agents/skills/<name>/SKILL.md`,
`.claude/skills/<name>/SKILL.md`). Pi Durable does not discover these itself, so the kit does it, per request and through the sandbox:

* A role lists the skills it may use (`profile.skills.allow`; a deployment can replace the list with `SKILLS_ALLOW=a,b`). **Only listed
  skills are ever shown**; an empty list turns the whole feature off (not even `AGENTS.md` is injected), so a role changes nothing until
  it opts in. Names are `[a-z0-9-]+`: nothing can point outside the skills directories.
* The loader reads `AGENTS.md` and each listed skill's front matter (`name`, `description`) **from the workspace at the task's ref**
  through the sandbox `ExecutionEnv`, never from the harness host, and renders a `repository-knowledge` prompt section: the repository
  instructions plus an index (name, description, file path). The model opens the skill it needs with its file tool, so a long skill costs
  nothing until it is used. Caps: 16 KiB for `AGENTS.md`, 500 characters per description, 48 KiB for the section.
* **Overlays** adapt a skill without forking it: `<SKILLS_OVERLAY_DIR>/<name>.md` (kept with the deployment, not in the repository)
  states only the differences and is shown next to the index entry; it wins where it conflicts. Its first line records the skill it was
  written against, `<!-- base-sha256: <sha256 of the repository's SKILL.md> -->` (`skillHash(text)` computes it). When the repository's
  skill has since changed, the model is told so and a `skills_warning` is logged. Company skill text belongs in the repository or in the
  private overlay directory, not in this public repository.

## Adding a role

1. `adapters/<role>/package.json` (depends on `@somework/agent-kit` and `@somework/sdk`), `card.json`, `src/profile.ts`, `src/main.ts`.
2. A Dockerfile target (copy `adapters/pi/Dockerfile`: `npm ci -w @somework/<role>`; keep the build-time import check).
3. Tests next to the role (`adapters/<role>/test`), using `@somework/agent-kit/testing` and `sdk/typescript/test/harness.ts`.
4. `npm run check:roles`.

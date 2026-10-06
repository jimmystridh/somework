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
| `chat` | the automatic answer to direct chat messages (below) |
| `skills` | the repository knowledge loader (below) |
| `testing` | `makeRemote` (a local bare repository), `FakeHost`, `sh`: for role tests |

## Chat: agents take tasks, not chat

A message sent to an agent used to sit unread, and the sender never learned that. Every kit service now answers a direct `chat.message`
once with a `chat.notice`: who this is, that nobody reads the thread, and the capabilities to submit a task for. It is deterministic (no
model, no tokens) and never echoes what the sender wrote.

* **It cannot loop.** The answer is a `chat.notice`, whose only permitted trigger mode is `never`, so it wakes nobody; it carries the
  label `autoReply`; and the responder acts only on plain `chat.message`s without that label, never on its own messages. Per sender and
  conversation there is at most one answer per 10 minutes, at most 30 per hour in total, and a message older than 5 minutes is not
  answered, so a restart does not answer a backlog.
* **Switch and wording.** `profile.chat = { autoReply: false }` turns it off for a role; `CHAT_AUTOREPLY=0` turns it off for one
  deployment; `profile.chat.replyTemplate(context)` replaces the text (it must not include anything the sender sent).
* **Observability.** Logs `chat_message_received` (with `replied` and `reason`), `chat_reply_sent`, `chat_reply_failed`; the counter
  `somework_chat_messages_total{result,reason}`.

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

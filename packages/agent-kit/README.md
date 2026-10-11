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
| `setup`, `mcp` | the setup override and fleet limits an agent takes from Operations, and the MCP client behind them (below) |
| `testing` | `makeRemote` (a local bare repository), `FakeHost`, `sh`, `jobRig` (a job through the real job manager and artifact handling): for role tests |

## Conversations and jobs: agents talk, and long work runs in the background

Agents do not take tasks. Every `chat.message` addressed to an agent (a person, the manager, another agent, a group conversation) is read by its model. Decisions: `docs/adr/0003-messages-and-events-replace-tasks.md`.

* **Nothing is lost.** A message is written to the agent's durable inbox (`threads/inbox.json` in its state directory) before its wake is acknowledged and is handled once per message id. After a restart every unfinished message is taken up again, and the service sweeps the domain's unread inbox at start and every minute for what no wake announced. The first start of an agent ever treats what the domain holds for it as history (marked read, not answered).
* **A run per message.** The message gets a model run of its own (`thread:<messageId>`, a scratch directory per conversation, the role's tools and the kit's thread tools). Several conversations go on at once (`THREADS_MAX_CONVERSATIONS`, default 4), one message at a time within a conversation. A backlog (found after a start, or sent more than two minutes before it arrived) is worked through one at a time, people before agents, oldest first, beside the live conversations; the model is told how long a message waited. Everyone in the domain is trusted: there is no list of askers.
* **The answer goes to everyone in the conversation** (the sender and the others the message was addressed to) unless the model answers exactly `NO_REPLY`. Receivers decide for themselves whether to answer; the domain's hop depth (`causationId` chain, default 16) bounds agent-to-agent loops.
* **Jobs.** A role's capabilities are `hooks.chat.jobTools` (name, description, TypeBox parameters, `plan(args)` that returns `{capability, input, label}` or `{refuse}`). A call starts the job at once in the background (`JobManager`, `threads/jobs.ts`), through the same `createHandler` pipeline as always (same sandbox, git protocol, guards, approvals) with the profile's `defaultBudget`. The result is posted to the conversation as one message, with the artifacts the job uploaded; `agent.<slug>.job.started|waiting|finished` events are published (the agent needs the permission `events.publish:agent.<slug>.*`). Running jobs are written to `threads/jobs.json` and started again under the same run id after a restart. Events: a handler's `submit` decision starts a job of the agent.
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


## Telegram: every agent can have its own bot

Off unless the agent has a bot token. Create the bot with BotFather (one bot per agent), put the token in a file and set:

| Environment | Meaning |
|---|---|
| `TELEGRAM_BOT_TOKEN_FILE` | path of the file with the bot token (preferred; `TELEGRAM_BOT_TOKEN` takes the token itself) |
| `TELEGRAM_ALLOWED_USER_IDS` | **required with a token**: the numeric Telegram user ids that may write to the agent, separated by commas. Without a usable list the channel does not start (the log says `telegram_disabled` and why); the agent runs as before |
| `TELEGRAM_MESSAGES_PER_HOUR` | messages one person may send to the model per hour (default 30; commands do not count) |
| `TELEGRAM_POLL_SECONDS` | long-poll time of `getUpdates` (default 30) |

* **Who is served.** Only private chats with an allowed person. Everyone else (strangers, bots, groups) is ignored without an answer. Text only (other content gets "I read text messages only"); at most 4000 characters a message.
* **A message is a conversation message.** It becomes a message from `telegram/<userId>` (kind `human`, so people first) in the conversation `tg:<chatId>` and is handled by the same thread engine as any other: durable inbox, a model run of its own, the thread tools, jobs. The domain never sees these conversations. The answer (or `NO_REPLY`, which sends nothing) goes to the chat in chunks, with secrets scrubbed; a job started there reports its end into the same chat (attachments stay in the domain: their ids are named). `agent.<slug>.job.*` events are still published.
* **Commands, no model run:** `/start` and `/help` (what the agent is and offers), `/status`, `/jobs`, `/stop <job>` (a signal, as `job_stop`), `/approve <id>` and `/deny <id>`. An approval that the agent needs for work started on Telegram is asked on the chat and answered there, by the person asked only; an approver outside Telegram is asked through the domain as before.
* **Transport and state.** Long polling (`getUpdates`), no webhook, so nothing listens and nothing is exposed. `telegram/messages.json` (the chat history the model sees and what a restart needs) and `telegram/offset.json` (how far updates were read) are in the state directory. The offset moves only after a message is in the inbox, so a restart neither loses nor repeats a message; a reply that was sent just before a crash can be sent again after it. Errors back off from 1 s to 30 s; the token never appears in an error or a log.
* `/profile` shows `telegram: {enabled, allowedUsers}` (a count, never the ids).


## Slack: every agent can have its own app

Off unless the agent has both tokens of a Slack app. The agent opens the connection to Slack itself (**Socket Mode**, a WebSocket from the agent), so nothing listens, nothing is exposed and no public URL is needed. One Slack app per agent. Telegram and Slack can run side by side in the same agent: each conversation is kept by the channel it came from and answered there.

| Environment | Meaning |
|---|---|
| `SLACK_BOT_TOKEN_FILE` | path of the file with the bot token, `xoxb-...` (preferred; `SLACK_BOT_TOKEN` takes the token itself) |
| `SLACK_APP_TOKEN_FILE` | path of the file with the app-level token, `xapp-...`, scope `connections:write` (`SLACK_APP_TOKEN` takes the token itself) |
| `SLACK_ALLOWED_USER_IDS` | **required with the tokens**: the Slack member ids (like `U0123ABCD`) that may write to the agent, separated by commas. Without a usable list the channel does not start (the log says `slack_disabled` and why); the agent runs as before |
| `SLACK_ALLOWED_CHANNELS` | optional: channel ids (like `C0123ABCD`) where a mention of the bot is answered. Empty: no channel use, DMs only |
| `SLACK_MESSAGES_PER_HOUR` | messages one person may send to the model per hour (default 30; commands do not count) |

Both tokens are required. Neither set, or both files empty (the deployment mounts `/dev/null` by default), means "not configured": the channel is off and nothing is logged. Only one of them, a token of the wrong kind (a bot token must start with `xoxb-`, an app token with `xapp-`) or a missing allow-list is logged as `slack_disabled` with the reason; a reason never contains a token.

* **Who is served.** Only the members in `SLACK_ALLOWED_USER_IDS`, and only (a) in a DM with the bot or (b) in a message that mentions the bot in a channel of `SLACK_ALLOWED_CHANNELS`. Everything else (other people, other channels, bots, edited and deleted messages, other events) is ignored without an answer. Text only: a message with a file gets "I read text messages only". At most 4000 characters a message; the leading `@bot` mention is dropped and Slack's `&amp; &lt; &gt;` are decoded.
* **A message is a conversation message.** It becomes a message from `slack/<memberId>` (kind `human`, so people first) in the conversation `slack:<channel>` (a DM) or `slack:<channel>:<thread>` (a mention: the answer goes into a thread of that message, and one thread is one conversation) and is handled by the same thread engine as any other: durable inbox, a model run of its own, the thread tools, jobs. Within a thread the person mentions the bot again for each message (the app does not read the other messages of a channel). The domain never sees these conversations. The answer (or `NO_REPLY`, which sends nothing) goes out as plain text (no Slack markup, no link previews) in chunks of 3000 characters, with secrets scrubbed; a job started there reports its end into the same DM or thread (attachments stay in the domain: their ids are named). `agent.<slug>.job.*` events are still published. A mention in a channel is answered where everybody in the channel can read it: allow only channels whose members may see what the agent says.
* **Commands, no model run.** Slack swallows `/`, so the commands start with `!`: `!help` (what the agent is and offers), `!status`, `!jobs`, `!stop <job>` (a signal, as `job_stop`), `!approve <id>` and `!deny <id>`, worded as on Telegram. An approval that the agent needs for work started on Slack is asked in the conversation and answered there, by the person asked only (in a thread: in that thread); an approver outside Slack is asked through the domain as before.
* **Transport and state.** `apps.connections.open` with the app token gives an address for one connection; every connection asks for a fresh one. Every envelope is acknowledged at once, then handled in order; Slack delivers an event again when an acknowledgement is lost, so the event id and the channel and timestamp of each message are kept (`slack/seen.json`) and a delivery that is known adds nothing, not even a second reply. `slack/messages.json` (the history the model sees and what a restart needs) is in the state directory too. A `disconnect` of Slack (it asks for one every few hours) is followed by a new connection at once; a lost connection or a failed start by a new one after 1 s, doubling to 30 s (and starting over after a good connection). Neither the token, nor a connection address, nor what people wrote is logged or shown in an error. The events logged are `slack_started`, `slack_connected`, `slack_disconnected`, `slack_connection_failed`, `slack_sent`, `slack_reply_failed`, `slack_accept_failed` and `slack_stopped`. `somework_slack_events_total{result}` counts what became of each event (`accepted`, `command`, `unsupported`, `rate_limited`, `duplicate`, and the reasons for ignoring one).
* **Limits.** `chat.postMessage` is retried once after an HTTP 429 (`Retry-After`, at most a minute). The agent needs `slack.com` and `wss-primary.slack.com` / `wss-backup.slack.com` outbound (the Windows roles list them in their `firewall-allow.pilot.txt`).
* `/profile` shows `slack: {enabled, allowedUsers, channels}` (counts, never the ids).

### Turning the Slack app on for one agent

1. **Create the app from the manifest.** api.slack.com/apps -> *Create New App* -> *From a manifest* -> pick the workspace -> YAML tab -> paste `docs/slack-app-manifest.yaml` (change the two names) -> *Create*. The manifest sets Socket Mode on, the bot user, the scopes `chat:write`, `im:history`, `im:read`, `im:write`, `app_mentions:read`, the events `message.im` and `app_mention`, and the Messages tab of the app home with writing enabled (without it the DM box says "Sending messages to this app has been turned off").
2. **Install it** to the workspace (*Install App* -> *Install to Workspace*; an admin may have to approve it). Copy the *Bot User OAuth Token* (`xoxb-...`).
3. **Generate the app-level token.** *Basic Information* -> *App-Level Tokens* -> *Generate Token and Scopes* -> add the scope `connections:write` -> copy the token (`xapp-...`).
4. **Find the member ids.** In Slack: open a person's profile -> the three dots -> *Copy member ID* (`U0123ABCD`). For a channel (optional): channel name -> *About* -> the channel ID at the bottom (`C0123ABCD`), and invite the bot there (`/invite @name`).
5. **Store the tokens as files** on the agent host, readable by the container user only, one token per file, no other text: `./secrets/slack-bot-token` and `./secrets/slack-app-token` (`chmod 600`, owner uid 10001 for the containers; the Windows roles use `C:\somework\secrets\...` readable by the service account).
6. **Set the environment** of the agent: `SLACK_BOT_TOKEN_HOST=./secrets/slack-bot-token`, `SLACK_APP_TOKEN_HOST=./secrets/slack-app-token`, `SLACK_ALLOWED_USER_IDS=U0123ABCD` and optionally `SLACK_ALLOWED_CHANNELS=C0123ABCD` in the compose `.env` (the compose files already map them to `/run/secrets/slack-*`; the Windows roles use `SLACK_BOT_TOKEN_FILE`, `SLACK_APP_TOKEN_FILE` in `agent.env`). Restart the agent.
7. **Check.** The log shows `slack_started` and `slack_connected` (a `slack_disabled` line says what is missing; `slack_connection_failed` with `invalid_auth` means a wrong or revoked app token); `/profile` shows `slack.enabled: true`. Send the bot a DM: `!help`.

## `/profile`: how an agent is set up

Next to `/status` the health port serves `/profile`, a read-only JSON document the service builds from its loaded profile and settings (`describe.ts`): role and agent id, the image tag (`AGENT_VERSION`), the capability card ids, model and allowed models, the system prompt with its SHA-256 and length (`PROFILE_PROMPT=0` leaves the text out), allowed tools, command approval patterns (the deployment's own patterns are only counted) and tools that wait for approval, budgets and caps, concurrency, repository settings (push, pull request, branch prefix, the credential kind `token`, `github-app` or `none`, the bot's GitHub login with an app, token hosts, mirror, `GIT_TOKEN_EXPIRES` when set to a plain date), skills, chat settings (who may ask and instruct), events and observe state. Live handlers and token pools stay on `/status`. `setup` is what an operator changed (see "Setup overrides"). It holds no key, token, file path or environment value. `hash` identifies the setup (the version and the prompt text are not part of it) and `changedAt` is when this hash was first seen, kept in `profile-hash.json` in the state directory, so a dashboard can mark "changed since last seen". The port is private to the cluster; the prompt is company wording, so show it only through the private gateway.

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

## Setup overrides: what Operations may change

An agent takes a **setup override** and **fleet limits** from one sender only: the service principal `operations` (ADR 0004, `docs/OPERATIONS_SETUP.md`; the wire format is `src/setup/contract.ts`). The document is the whole desired state with a revision number, uploaded as an `application/json` artifact and announced by a message with the labels `setup.kind` (`override` or `limits`), `setup.revision` and `setup.sha256`. The domain gives a `chat.notice` no wake-up (its only trigger mode is `never`), so a notice reaches the agent at its next inbox sweep (within a minute); a `chat.message` with `triggerMode: directed` wakes it at once. The agent takes either from the operations principal. It needs chat mode on, and the message never becomes a conversation.

* **From whom.** `sender.kind = service` and `sender.id = operations`, in the agent's own domain; the domain has already checked the signature. The same labels from anyone else are ignored and logged (`setup_ignored`), with no answer. Conversations, work requests and events keep the full trust of ADR 0003.
* **Intake.** The artifact is downloaded (at most 2 MiB), its SHA-256 must equal `setup.sha256`, and `parseOverride` / `parseLimits` check it (agent id, names, regular expressions, checksums of library skills, https and SHA-256 of downloads, no duplicates). A revision that is not newer than the applied one is acknowledged and ignored. A document that fails, or that this agent cannot honour (a model it does not allow, a secret it does not have, a download whose checksum differs), is **rejected as a whole**: the previous setup stays, `/profile` shows `setup.rejected` with the reason, and the acknowledgement says so. Every document is answered with a `chat.notice` (trigger mode `never`) to Operations carrying `setup.ack=<revision>` and `setup.status=applied|rejected` (idempotency key `setup-ack:<agent>:<kind>:<revision>`).
* **Kept across restarts.** An applied document is written atomically to `<state>/setup/override.json` and `limits.json` (readable by the agent only) and loaded at startup, before the runtime is built. At a restart a model that is no longer allowed is ignored, and an MCP server whose secret or download is gone is left out (reported with its reason in `/profile`); the rest still applies.
* **What takes effect, and when.** From the next model run; runs in progress keep what they started with (a conversation keeps its instructions, model and tools).

| In the document | Effect |
|---|---|
| `instructions` | appended to the role's built-in system prompt (which stays read-only) for new conversations. Chat conversations get a suffix `#setup-<hash>` on their key while the instructions, the model or the extra tools are set, so a new revision starts a fresh conversation; without such an override keys are what they always were. |
| `model` | the model new conversations start on. Refused unless it is in the agent's allowed models (`PI_ALLOWED_MODELS`) and its provider offers it; removing it goes back to `PI_PROVIDER`/`PI_MODEL`. |
| `approvalPatterns` | when present, replaces the role's own list of commands that need approval (the deployment's `APPROVAL_PATTERNS` and the role's tool approvals stay). Read on every tool call. |
| `skills.repository` | replaces the role's list of repository skills (an empty list turns them off); `skills.overlays` come from the override first and from `SKILLS_OVERLAY_DIR` as before. |
| `skills.library` | offered as `library/<name>` through one fixed tool, `skill_library` (no argument lists name and description, `{name}` returns the `SKILL.md`), and an index in the prompt. They never replace a repository skill. |
| `mcp` | MCP servers (below). |
| fleet limits (`kind: limits`) | `maxTokensCap`, `maxMinutesCap`, `dailyTokenLimit` and `budgetRaiseCeiling` are read on every job, ledger and budget-raise call; the environment's values are the fallback until a document arrives. Not part of any override. |

`/profile` shows `setup`: `override` (revision, the SHA-256 of the bytes Operations sent, when applied), `limits`, `rejected`, the role's `defaults` (its own approval patterns as `{pattern, reason}`, its repository skills, the configured model and the allowed models) and `effective` (instructions with their text and hash, model, approval patterns, repository skills, library skills with versions, MCP servers by name, transport and approval). No secret, URL, header or command is ever in it.

### MCP servers

Pi Durable has no MCP client, so `src/mcp/` has a small one (`initialize`, `tools/list`, `tools/call`): **stdio** (a child process, one JSON message per line, a timeout per request, killed when the entry goes away or the service stops) and **streamable HTTP** (a POST per message, answered with JSON or an event stream; redirects are not followed, because the headers carry secrets). The model reaches every server through two fixed tools registered once, `mcp_tools` (the tools of the enabled servers, or of one) and `mcp_call` `{server, tool, arguments}`; the set of servers behind them changes with the override. A new conversation is offered them only while the override has servers (or library skills, for `skill_library`).

* **Approval.** `approval: ask` sends every call through the agent's approval (the same flow as a command that needs approval), `never` allows it, `writes` asks unless the server's own tool list says `readOnlyHint: true` for that tool (a tool never listed counts as a write).
* **Secrets.** A `${NAME}` in `env`, `headers` or `args` is expanded **only** from the agent's own environment and only for names the entry lists under `secrets`; an undeclared name, or a declared one the host lacks, rejects the document (the reason names the variable, never a value). Values are never logged, never put in `/profile` and never sent to the model. The child process gets a minimal environment: the entry's own `env` plus `PATH`, `HOME` and similar basics, nothing else of the agent's.
* **Downloads.** An entry can say how to obtain its server per operating system (`linux`, `windows`, `darwin`): an https URL (redirects must stay on https), a SHA-256, an archive kind (`none`, `zip`, `tar.gz`) and the executable's path. The bytes are verified against the checksum **before** anything is written as executable or unpacked, into `<state>/mcp/<name>/<sha256>/` (so a new checksum is a new folder and a verified one is reused). Archives are unpacked by the kit: files and folders only, no link, no path outside the folder, size and entry caps. `${LOCAL}` as the command (or in `args`) is the downloaded executable.
* **Results are data.** Each result is run through the same redaction as the event handlers (`events/redact.ts`), cut at 32 KiB, and framed as data from another party; non-text content is named, not carried.

## Adding a role

1. `adapters/<role>/package.json` (depends on `@somework/agent-kit` and `@somework/sdk`), `card.json`, `src/profile.ts`, `src/main.ts`.
2. A Dockerfile target (copy `adapters/pi/Dockerfile`: `npm ci -w @somework/<role>`; keep the build-time import check).
3. Tests next to the role (`adapters/<role>/test`), using `@somework/agent-kit/testing` and `sdk/typescript/test/harness.ts`.
4. `npm run check:roles`.

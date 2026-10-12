# SomeWork Manager

The Manager is the agent you talk to from Telegram. It is the old `pi-demo` Telegram bridge grown up: the same private pairing, the
same Pi (coding-agent 1.1.0; the pilot ran 0.87.1, see `deploy/README.md`, "Upgrading Pi") container as its brain, plus its own SomeWork identity `agent/manager` and a small **gateway** through
which Pi can find and talk to the other agents. It works with them the way a colleague would: it asks in a message and the agent decides
what to do with it. There are no tasks to submit, follow or cancel (ADR 0003).

```
Telegram (owner only) <--long poll--> bridge (host process, Node)
                                          |  holds the SomeWork key (agent/manager) and the Telegram token
                                          |  JSON lines over stdin/stdout
                                          v
                                Pi container `pi-demo` --HTTP+bearer--> gateway (same process)
                                (no SomeWork credentials)                 policy: confirmations, rate limits
                                                                            |
                                                              SomeWork domain (REST, TLS, private CA)
```

## What the model can do
Nine tools (extension `extension/somework-tools.ts`, loaded into Pi with `-e`): `somework_catalog`, `somework_ask`, `somework_message`,
`somework_inbox`, and for events `somework_rules`, `somework_sources`, `somework_handlers`, `somework_setup` (read only) and `somework_control`
(asks the owner to pause or resume a rule or source, to switch handlers off or on, to raise an agent's token budget for today, or to change an
agent's operator instructions). They call the gateway only;
the SomeWork key never enters the container. The rules are enforced in the gateway, not in the prompt:

* The catalog is advertisement only. A capability tells the model what an agent says it can do and what input it understands; it is not a
  button and carries no approval class. To get something done the model asks the agent in plain words (`somework_ask`, or
  `somework_message` by exact id). Everyone in the domain is trusted, so there is nothing to approve before talking to an agent; the agent
  decides what a message asks for: answer, start work in the background, or ask back.
* A switch the model asks for (`somework_control`) only creates a request: the owner confirms it with a button or `/approve <id>`; ten
  minutes (`MANAGER_APPROVAL_TTL_MINUTES`) end it, and a restart forgets pending requests, which means denied. The gateway has no route
  that approves anything.
* **Changing an agent's prompt.** `somework_setup` reads an agent's operator instructions (the addendum Operations appends to the role's own
  prompt, which stays read only) from Operations; `somework_control` with `set_instructions` and the complete new text asks the owner, who sees
  the whole text in Telegram before confirming. On confirmation the Manager saves it in Operations as one more revision from the current one,
  authored `agent/manager`, with the rest of the agent's setup (skills, tool servers, model, approvals) untouched; Operations delivers it as
  for any editor, so the console shows saved and applied revision and the agent confirms. The Manager reaches Operations with a service
  token (`MANAGER_OPERATIONS_URL`, `MANAGER_OPERATIONS_TOKEN_FILE`, `MANAGER_OPERATIONS_CA_FILE`, default `MANAGER_CA_FILE`); without them the
  tool answers that Operations is not configured and the owner is not asked.
* Messages to agents are limited to 60 per hour (`MANAGER_MESSAGES_PER_HOUR`), `somework_ask` to 30 per hour. Payloads are never logged, only
  route, status and sizes.

## What the owner gets
* Replies in the conversations the owner started (`/ask`), and any other message an agent writes to `agent/manager` (`[agent/x] text`),
  limited per sender and hour.
* **Job results.** Agents run long work as background jobs and post the result into the conversation that asked for it. Every agent also
  publishes `agent.<agent>.job.finished` when a job ends; the Manager subscribes to these (once, at start: `ensureJobSubscription`) and tells
  the owner in one line: which agent, how it ended (completed, could not finish, cancelled), which job and its summary. A job started in a
  conversation the owner has with the agent is not announced twice (its result message is shown there). Jobs that start or wait are not
  announced; ask the agent. Finished-job lines are not cut by the per-topic rate limit, and quiet hours hold them like any non-urgent event.
* Approval questions from agents (below).
* Commands: `/agents` `/pending` `/approve <id>` `/deny <id>` `/status` `/stop` `/workspace` `/help`, and `/ask <agent> <text>` (see below).
  Everything else goes to Pi as `[telegram] text`.

## Chatting with agents
`/ask <agent> <text>` sends a message to an agent (the name may be short: `reviewer`, `aikido-fixer`; it is resolved against the
catalog and refused when unknown or ambiguous) and answers "sent, waiting for a reply". Ask in plain words: a question, or a request such as
"verify SAD-123". The Manager remembers the conversation: whatever that agent writes back in it reaches you as one Telegram message titled
with the agent's id (split into parts above 3500 characters), with secret-looking values hidden and no tappable `/commands`. If nothing comes
back within 3 minutes you are told once; a late answer is still shown. A follow-up `/ask` to the same agent continues the conversation.
Limits: 30 messages per hour, 2000 characters each. Plain messages that agents start on their own are shown too, titled the same way. The Pi
tool `somework_ask` does the same for the model, but the answer goes to you, not back to the model, and the Manager itself never answers a
chat message, so conversations cannot loop.

**Approvals.** When a step of an agent's work needs approval (its approval patterns: publishing, pushing, deleting broadly), the agent asks
in a message labelled `chatApprovalRequest=<id>`, in whatever conversation the work came from. The Manager shows you the question with its
id: answer with `/chatapprove <id>` or `/chatdeny <id>`. Only these commands, typed by you, answer; no Pi tool can, nothing the agent writes
can, and an unanswered question is denied by the agent after ten minutes (an answer later than 30 minutes is not sent). The answer goes out
once, in the same conversation, as a message with the text `approve` or `deny` labelled `chatApprovalDecision=<id>`. `/pending` lists the
questions and switches that wait for you.

## Events and controls
* **Event forwarding, no model.** Events the Manager is woken by (subscriptions of `agent/manager`) are shown as one compact message each
  when the topic is on the allow-list, de-duplicated by event id, limited per topic and hour (the excess is summarised), optionally held
  during quiet hours, and the schedule topic produces a digest (questions waiting, rules, sources, handlers). Event text is shown as data:
  fixed fields only, cut, secret-looking values hidden, and every `/word` given a look-alike slash so it cannot be tapped as a command.
  Notices from agents (a handler's notify decision, an auto-disabled handler, a used-up token pool) come the same way, limited per sender.
* **Commands.** `/rules` `/pause <rule>` `/resume <rule>` `/sources` `/pausesource <source>` `/resumesource <source>` `/handlers <agent>`
  `/kill <agent> <handler|all> [reason]` `/unkill <agent> <handler|all>`. The owner's commands run at once; the model's
  `somework_control` only creates a request the owner confirms with a button. Creating or deleting rules is not possible from here.

## Setup from Operations (ADR 0004)
The Manager is not a kit agent: it runs the stock Pi CLI. It takes the same setup documents as the kit's agents (`packages/agent-kit/src/setup/contract.ts` is the
wire contract; the Manager reads that one file) and applies them to Pi. A setup override reaches the Manager only from the service principal `operations`:

* **Intake** (`src/setup/intake.ts`). A message that carries the label `setup.kind` is taken by the inbox reader before it can become chat: it is never a
  conversation, never shown to the owner and never visible to the model (`somework_inbox` leaves such messages out). The sender is checked with `isOperations` and must belong to the Manager's own domain;
  anyone else's is ignored and logged (`setup_ignored`) without an answer. For Operations the artifact is downloaded (at most 2 MiB), its SHA-256 is compared with
  `setup.sha256`, it is parsed with `parseOverride` / `parseLimits`, a revision that is not newer than the applied one is acknowledged and ignored, a new one is
  applied, and a `chat.notice` goes back to the sender with `setup.ack` (the revision), `setup.status` (`applied` or `rejected`, the reason in the text) and
  `setup.kind`, idempotency key `setup-ack:<agent>:<kind>:<revision>:<status>`. A rejected document leaves the earlier setup in place and is reported in `setup.rejected`.
* **Kept** in `<config dir>/setup/` (`override.json`, `limits.json`, `status.json`, mode 0600, no secret in them) and put to work again at every start; a saved
  setup that cannot be applied any more (a secret removed from the host) is reported rejected and Pi starts without it.
* **Status.** `GET /profile` on the Manager's own endpoint (`MANAGER_HEALTH_PORT`, default 7080; `src/health.ts`) returns the fields of the kit's description that
  apply to the Manager (role, agent id, model, built-in prompt hash and size, approval patterns, skills, MCP servers, Pi version, `hash`) and `setup` as the kit reports
  it (`{ override: {revision, hash, appliedAt} | null, limits: {revision, appliedAt} | null, rejected? }`). No secrets and no operator text, only sizes. `GET /live` answers 200.

What a document changes, and when it takes effect:

| Part of the document | Where it goes | Takes effect |
| --- | --- | --- |
| `instructions` | a second `--append-system-prompt` after the built-in prompt (the built-in one, `src/prompt.ts`, stays read-only) | next Pi start |
| `model` | `--model provider/id`; a reset puts back the model Pi ran with before the first override | next Pi start |
| `mcp` | `~/.pi/agent/mcp.json` (`mcpServers` replaced as a whole, other keys kept); secrets only as `${NAME}` references that Pi expands, the names passed to the container as `-e NAME` from the Manager's environment; a document naming a secret this host lacks, referring to a variable it does not list, or using a `!command` value is rejected; local servers are downloaded over https, checked against the SHA-256, unpacked safely (no paths outside the folder, no links) into `~/.pi/agent/mcp-servers/<sha256>/` and run through `${LOCAL}` | next Pi start (Pi reads `mcp.json` at session start; the Pi image starts with `--no-extensions`, so the Manager adds `-e builtin:mcp` whenever a document has MCP entries) |
| `skills.library`, `skills.overlays` | skill folders `~/.pi/agent/skills/library/<name>/SKILL.md`; an overlay is a skill `overlay-<name>` that says it belongs to `<name>` (the Manager has no repository skill to change); the Pi image starts with `--no-skills`, so the Manager passes `--skill <agent folder>/skills/library` | next Pi start |
| `skills.repository` | nothing: the Manager has no repository skills | - |
| `approvalPatterns`, MCP `approval` | the Manager's own policy (`ApprovalRules` in `src/policy.ts`), enforced by a `tool_call` gate in the Pi extension: a bash command that matches a pattern, or an MCP call of a server set to `ask` (or `writes` for a tool that is not read-only), is blocked until the owner confirms the exact call in Telegram (one use, ten minutes) | at once for the next call |
| fleet limits | recorded and reported; the Manager has no per-run caps of its own, so nothing reads them yet | - |

Pi 1.1.0 takes none of this through RPC (`/reload` is an interactive command, not an RPC one, and the addendum is an argument), so a new setup means a new Pi process:
the Manager starts it again as soon as no run is going (`src/pi-process.ts`), never during a run; messages that arrive in those few seconds wait for the new process, and the
session file carries the conversation over. If Pi does not come up with the new setup (a model that does not exist), it is started without the operator parts and the
document is reported as rejected. MCP tools use Pi's default exposure (`codemode`): the model reaches them through its `codemode` and `tool_search` tools.

## Learning about messages
`MANAGER_FEED=wake` (default) uses the SDK's wake source: NATS for messages when the domain offers it, an HTTP safety net, no long
polls. `MANAGER_FEED=polling` skips NATS and uses short HTTP lookups. The feed only decides *when* to look; `InboxReader` decides what
is new (it marks everything read and forwards what other agents wrote), so changing the transport touches `WakeFeed` only.

## Layout
`src/` bridge (Telegram commands, Pi turns), `service` (all decisions), `gateway` (HTTP front for Pi), `notifier` (inbox, feeds),
`domain` (REST adapter), `chat` (the owner's conversations and agents' approval questions), `policy`, `event-intake` (alerts, job-finished lines,
digest), `controls` (rules, hub, handlers), `rate`, `http`, `redact`, `rpc`, `telemetry`, `state`, `config`, `main`. `extension/` the Pi tools.
`src/setup/` (the contract's re-export, intake, applier, store, `mcp.json`, downloads and archives, skills, profile), `pi-process` (the restartable Pi child),
`health` (`/profile`), `prompt`, `pi-version`. `deploy/` systemd unit, compose override, env example, rollout, `verify-pi-1.1.0.sh`. `test/` 140 tests, including an end-to-end run against a real domain
from `sdk/typescript/test/harness.ts`; Telegram and Pi are faked, no model or network calls.

```bash
npm ci && npm test -w @somework/manager      # from the repository root (npm workspace)
```

## Suspending everything

`/suspend [reason]` is the owner's kill switch from Telegram. It pauses every active rule and every event source of the hub, tells every agent that runs handlers to switch all of them off and stops the Manager's own model run (jobs the agents are running are not cancelled from here: the host controls below stop the processes); `/approve`, `/chatapprove` and the confirm buttons then refuse until `/unsuspend`. What it changed is recorded in the Manager's state (`suspended`), and `/unsuspend` puts back exactly that: a rule the owner had paused before stays paused, and a step that could not be reached stays recorded so a second `/unsuspend` retries only it. `/status` shows `SUSPENDED since ...`.

With `MANAGER_HOST_CONTROL` (a JSON file, see `src/host.ts`) it also stops the processes, after the platform steps: the agent stacks on the Manager's own VM with `docker compose stop` (agents first, the event hub last) and the Windows agents over ssh. `/unsuspend` does the reverse first: it starts the hub, then the agents, then the Windows agents, waits for the hub, and only then resumes the rules, sources and handlers. While the processes are stopped the file `<pilotDir>/SUSPENDED` exists; the CI deploy wrappers refuse to deploy while it (or a disabled agent task) is there, because a deployment would start the stopped agents again, and `/status` and the approval guard honour it too, so a suspension made by hand with `scripts/fleet-suspend.sh` is resumed with `/unsuspend` as well.

```json
{ "pilotDir": "/home/js/somework-pilot", "firstStacks": ["events-hub"], "stacks": ["pi-agent", "reviewer", "aikido-fixer", "datadog-triage", "jira-triage"],
  "windows": [{ "name": "qa", "host": "10.10.10.44" }],
  "ssh": { "user": "js", "keyFile": "/home/js/.config/agent-cluster-telegram/fleet-control-key", "knownHostsFile": "/home/js/.config/agent-cluster-telegram/fleet-known-hosts" } }
```

The Windows machines are reached with a dedicated ed25519 key whose entry in `C:\ProgramData\ssh\administrators_authorized_keys` forces `deploy/windows/fleet-control.ps1` (`command="powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:/somework/bin/fleet-control.ps1",restrict,from="<the Manager's VM>"`), which accepts exactly `suspend` or `resume`: a leaked key can stop and start the agents and nothing else. The script is installed by hand (copy it to `C:\somework\bin\`), like the deployment wrapper. `scripts/fleet-suspend.sh` does the same from the owner's workstation.

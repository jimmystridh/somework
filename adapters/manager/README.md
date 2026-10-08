# SomeWork Manager

The Manager is the agent you talk to from Telegram. It is the old `pi-demo` Telegram bridge grown up: the same private pairing, the
same Pi (coding-agent 0.87.1) container as its brain, plus its own SomeWork identity `agent/manager` and a small **gateway** through
which Pi can find, instruct and talk to the other agents.

```
Telegram (owner only) <--long poll--> bridge (host process, Node)
                                          |  holds the SomeWork key (agent/manager) and the Telegram token
                                          |  JSON lines over stdin/stdout
                                          v
                                Pi container `pi-demo` --HTTP+bearer--> gateway (same process)
                                (no SomeWork credentials)                 policy: approvals, budgets, rate limits
                                                                            |
                                                              SomeWork domain (REST, TLS, private CA)
```

## What the model can do
Twelve tools (extension `extension/somework-tools.ts`, loaded into Pi with `-e`): `somework_catalog`, `somework_submit`,
`somework_task`, `somework_cancel`, `somework_message`, `somework_ask`, `somework_inbox`, and for events `somework_rules`, `somework_sources`, `somework_handlers`, `somework_approvals` (read only) and `somework_control` (asks the owner to pause or resume a rule or source, or to switch handlers off or on). They call the gateway only; the SomeWork key never enters the
container. The rules are enforced in the gateway, not in the prompt:

* A capability whose card declares `none` or `read` side effects is submitted immediately. Anything else (`write`, `irreversible`, or a
  card that says nothing) creates an approval: the owner gets a Telegram message with the capability, the target, the budget and a
  redacted summary of the input, and **nothing is submitted** until they answer `/approve <id>`. `/deny <id>` or ten minutes
  (`MANAGER_APPROVAL_TTL_MINUTES`) end it; a restart forgets pending approvals, which means denied. Only the owner's Telegram
  command can approve; the gateway has no such route.
* Capabilities in `budgetedCapabilities` (`code.agent`) get a default budget of 200 000 tokens / 20 minutes and are refused above the
  ceiling (500 000 / 60). Submissions are limited to 20 per hour, chat messages to 60.
* Only tasks the Manager itself submitted can be canceled or answered. Inputs are never logged, only route, status and sizes. Secret-looking
  keys and values are hidden in approval prompts.

## What the owner gets
* A message when a task finishes (PR url or summary, usage), fails or is canceled; when a task asks a question (reply to that message,
  or `/answer <taskId> <text>`: yes/no answer `{approved}`, anything else `{answer}`); when another agent writes to `agent/manager`
  (`[agent/x] text`).
* Commands: `/agents` `/tasks` `/pending` `/approve <id>` `/deny <id>` `/answer <taskId> <text>` `/cancel <taskId>` `/status` `/stop`
  `/workspace` `/help`, and `/ask <agent> <text>` (see below). Everything else goes to Pi as `[telegram] text`.

## Chatting with agents
`/ask <agent> <text>` sends a direct chat message to an agent (the name may be short: `reviewer`, `aikido-fixer`; it is resolved against the
catalog and refused when unknown or ambiguous) and answers "sent, waiting for a reply". The Manager remembers the conversation: whatever
that agent writes back in it (the kit's `chatReply` answer, or the older automatic notice labelled `autoReply`) reaches you as one
Telegram message titled with the agent's id (split into parts above 3500 characters), with secret-looking values hidden and no tappable
`/commands`. If nothing comes back within 3 minutes you are told once; a late answer is still shown. A follow-up `/ask` to the same agent
continues the conversation. Limits: 30 chat messages per hour, 2000 characters each. Plain direct chat that agents start on their own is
shown too, titled the same way. The Pi tool `somework_ask` does the same for the model, but the answer goes to you, not back to the
model, and the Manager itself never answers a chat message, so chats cannot loop.

**Instructions and approvals.** `/ask <agent> instruct: <what to do>` is an instruction: the agent (when `agent/manager` is one of its instructors, which is the default) runs it as a job of its own capability and reports the outcome in the same chat. If a step of the job needs approval, the agent asks in the conversation and the Manager shows you the question with its id: answer with `/chatapprove <id>` or `/chatdeny <id>`. Only these commands, typed by you, answer; no Pi tool can, nothing the agent writes can, and an unanswered question is denied by the agent after ten minutes (an answer later than 30 minutes is not sent). The answer goes out once, in the same conversation, labelled `chatApprovalDecision=<id>`.

## Events, approvals and controls
* **Domain approvals.** A write-class task that an event rule starts waits for a structured approval in the domain (bound to the task's
  action digest and revision). The Manager polls for pending ones (`MANAGER_APPROVAL_POLL_MS`) and tells the owner once: capability,
  side effects, rule and the event it fired on, budget, a redacted input summary, expiry, with Approve and Deny buttons (or
  `/approve <id>`, `/deny <id>`). The decision carries the digest and revision the domain reported, so the domain's own checks stay in
  charge. Decided elsewhere or expired approvals are reported once. Only the paired owner's taps and commands count.
* **Event forwarding, no model.** Events the Manager is woken by (rules owned by `agent/manager`) are shown as one compact message each
  when the topic is on the allow-list, de-duplicated by event id, limited per topic and hour (the excess is summarised), optionally held
  during quiet hours, and the schedule topic produces a digest (tasks, approvals, rules, sources, handlers). Event text is shown as data:
  fixed fields only, cut, secret-looking values hidden, and every `/word` given a look-alike slash so it cannot be tapped as a command.
  Notices from agents (a handler's notify decision, an auto-disabled handler, a used-up token pool) come the same way, limited per sender.
* **Commands.** `/rules` `/pause <rule>` `/resume <rule>` `/sources` `/pausesource <source>` `/resumesource <source>` `/handlers <agent>`
  `/kill <agent> <handler|all> [reason]` `/unkill <agent> <handler|all>` `/approvals`. The owner's commands run at once; the model's
  `somework_control` only creates a request the owner confirms with a button. Creating or deleting rules is not possible from here.

## Learning about changes
`MANAGER_FEED=wake` (default) uses the SDK's wake source: NATS for chat messages when the domain offers it, an HTTP safety net, no long
polls. The domain pushes a requester nothing about its own tasks (status messages never wake, task wakes go to the assignee), so tasks in
flight are looked at every `MANAGER_POLL_TASK_MS` (4 s) while there are any, and not at all otherwise. `MANAGER_FEED=polling` skips
NATS and uses short HTTP lookups for everything. Tracked tasks are kept in the state file and followed after a restart. The feed only
decides *when* to look; `TaskTracker` and `InboxReader` decide *what* changed, so changing the transport touches `WakeFeed` only.

## Layout
`src/` bridge (Telegram commands, Pi turns), `service` (all decisions), `gateway` (HTTP front for Pi), `notifier` (tracker, inbox, feeds),
`domain` (REST adapter), `chat` (the owner's conversations), `policy`, `approvals`, `reaction-approvals` (domain approvals), `event-intake` (alerts, digest), `controls` (rules, hub, handlers), `rate`, `http`, `redact`, `rpc`, `telemetry`, `state`, `config`, `main`. `extension/` the Pi tools.
`deploy/` systemd unit, compose override, env example, rollout. `test/` 104 tests, including an end-to-end run against a real domain
(and a real nats-server) from `sdk/typescript/test/harness.ts`; Telegram and Pi are faked, no model or network calls.

```bash
npm ci && npm test -w @somework/manager      # from the repository root (npm workspace)
```

## Suspending everything

`/suspend [reason]` is the owner's kill switch from Telegram. It pauses every active rule and every event source of the hub, tells every agent that runs handlers to switch all of them off, cancels the tasks in flight and stops the Manager's own model run; `/approve` and the approval buttons then refuse until `/unsuspend`. What it changed is recorded in the Manager's state (`suspended`), and `/unsuspend` puts back exactly that: a rule the owner had paused before stays paused, and a step that could not be reached stays recorded so a second `/unsuspend` retries only it. `/status` shows `SUSPENDED since ...`.

With `MANAGER_HOST_CONTROL` (a JSON file, see `src/host.ts`) it also stops the processes, after the platform steps: the agent stacks on the Manager's own VM with `docker compose stop` (agents first, the event hub last) and the Windows agents over ssh. `/unsuspend` does the reverse first: it starts the hub, then the agents, then the Windows agents, waits for the hub, and only then resumes the rules, sources and handlers. While the processes are stopped the file `<pilotDir>/SUSPENDED` exists; the CI deploy wrappers refuse to deploy while it (or a disabled agent task) is there, because a deployment would start the stopped agents again, and `/status` and the approval guard honour it too, so a suspension made by hand with `scripts/fleet-suspend.sh` is resumed with `/unsuspend` as well.

```json
{ "pilotDir": "/home/js/somework-pilot", "firstStacks": ["events-hub"], "stacks": ["pi-agent", "reviewer", "aikido-fixer", "datadog-triage"],
  "windows": [{ "name": "qa", "host": "10.10.10.44" }],
  "ssh": { "user": "js", "keyFile": "/home/js/.config/agent-cluster-telegram/fleet-control-key", "knownHostsFile": "/home/js/.config/agent-cluster-telegram/fleet-known-hosts" } }
```

The Windows machines are reached with a dedicated ed25519 key whose entry in `C:\ProgramData\ssh\administrators_authorized_keys` forces `deploy/windows/fleet-control.ps1` (`command="powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:/somework/bin/fleet-control.ps1",restrict,from="<the Manager's VM>"`), which accepts exactly `suspend` or `resume`: a leaked key can stop and start the agents and nothing else. The script is installed by hand (copy it to `C:\somework\bin\`), like the deployment wrapper. `scripts/fleet-suspend.sh` does the same from the owner's workstation.

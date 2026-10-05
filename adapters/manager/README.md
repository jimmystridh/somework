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
Six tools (extension `extension/somework-tools.ts`, loaded into Pi with `-e`): `somework_catalog`, `somework_submit`,
`somework_task`, `somework_cancel`, `somework_message`, `somework_inbox`. They call the gateway only; the SomeWork key never enters the
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
  `/workspace` `/help`. Everything else goes to Pi as `[telegram] text`.

## Learning about changes
`MANAGER_FEED=wake` (default) uses the SDK's wake source: NATS for chat messages when the domain offers it, an HTTP safety net, no long
polls. The domain pushes a requester nothing about its own tasks (status messages never wake, task wakes go to the assignee), so tasks in
flight are looked at every `MANAGER_POLL_TASK_MS` (4 s) while there are any, and not at all otherwise. `MANAGER_FEED=polling` skips
NATS and uses short HTTP lookups for everything. Tracked tasks are kept in the state file and followed after a restart. The feed only
decides *when* to look; `TaskTracker` and `InboxReader` decide *what* changed, so changing the transport touches `WakeFeed` only.

## Layout
`src/` bridge (Telegram commands, Pi turns), `service` (all decisions), `gateway` (HTTP front for Pi), `notifier` (tracker, inbox, feeds),
`domain` (REST adapter), `policy`, `approvals`, `redact`, `rpc`, `telemetry`, `state`, `config`, `main`. `extension/` the Pi tools.
`deploy/` systemd unit, compose override, env example, rollout. `test/` 57 tests, including an end-to-end run against a real domain
(and a real nats-server) from `sdk/typescript/test/harness.ts`; Telegram and Pi are faked, no model or network calls.

```bash
npm install && npm test
```

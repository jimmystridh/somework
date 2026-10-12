# SomeWork

An agent collaboration platform: agents talk to each other and to people in messages, learn what happened in events, decide for themselves what to do, and everything that is said is durable, authorised and audited. This glossary covers the platform's core nouns and the language of events, which is how the outside world and the platform itself can start work.

*Task*, *Reaction* and *Automation principal* were removed from the platform (ADR 0003); the entries below say what replaced them.

## Language

**Domain**:
The trust boundary: one SomeWork service instance (it has an id such as `development`) with its principals, messages, events, rules and audit. Principals enrolled in the same domain trust each other fully; whatever comes from outside it, or from another domain, is data, not instruction.
_Avoid_: tenant, workspace, environment

**Principal**:
An authenticated identity that can act on the platform: an agent, a human or a producer.
_Avoid_: user, account

**Agent**:
A principal that receives messages and events and decides for itself what to do with them. It acts on a message from any principal of its domain without asking who sent it.
_Avoid_: bot, worker

**Capability**:
An advertisement on the agent's card of what it can be asked to do: a name, a description, examples and an advisory side-effect class. It enforces nothing; what an agent will actually do is its own decision.
_Avoid_: skill, tool, contract

**Setup override**:
An operator's edit of one agent's operator instructions (an addendum appended to the role's built-in system prompt, which operators can read but not change), skill list, tool servers, model or approval patterns, kept by that agent and sent to it as a message from the Operations principal, the only principal an agent accepts a setup override from. It wins over the role's built-in setup, takes effect from the agent's next model run (runs already in progress finish with the old setup), and is removed by resetting to the role's default. Library skills reach the model under their own `library/` names, so they never replace a repository skill; the override also holds the per-agent overlay (the differences from a repository skill).
_Avoid_: config, settings, patch

**Operations**:
The operators' console for the fleet (the former fleet dashboard): it lists the agents, shows each one's metrics, jobs and history, and is where an operator edits an agent's setup override and the MCP catalog. It has its own database; the domain does not store any of it.
_Avoid_: dashboard, admin UI (the domain's own UI is a separate thing)

**Global prompt**:
The text added to every agent's prompt after its role's built-in prompt and before its operator instructions, telling it what holds for all agents alike (initially: ask the other agents for help, and how). Administrators edit it with the *Fleet limits*; until they do, agents use a built-in text. Each agent's *Setup override* can switch it off for that agent alone.
_Avoid_: system prompt (the role's built-in prompt is that), operator instructions (those belong to one agent)

**Fleet limits**:
The one set of budget limits (per-run caps, daily token limit, raise ceiling) that applies to every agent alike, together with the fleet's *Model choice*. Administrators edit it in Operations and it is sent to all agents; an agent falls back to its own environment values until it has received one. It is not part of any *Setup override*.
_Avoid_: budget (a job's own budget is a different thing), quota

**Model choice**:
Which provider, which model and how much reasoning effort an agent uses, as three independent settings. Each is set at the fleet level in the *Fleet limits* and for one agent in its *Setup override*; a part left out is inherited from the layer below, the lowest being the agent's own environment, and one job may still ask for a model and an effort of its own. The agent rejects a combination it cannot use (a model it does not allow, an effort the model does not take) and keeps its previous setup.
_Avoid_: model setting, model profile, thinking level (Pi's name for the effort)

**MCP catalog**:
The one list, shared by every agent, of the tool servers (MCP servers) that an agent may be given. Operators maintain it in Operations; an agent can use only the entries its setup override enables. An entry can say how a local server is obtained for each operating system, with a fixed version and checksum, and names the secrets it needs without holding them.
_Avoid_: plugin list, registry

**Skill library**:
The one shared collection of skills, kept in Operations, that operators add to and that every agent keeps an up-to-date local copy of. A skill is written guidance for doing one kind of work (distinct from a *Capability*, which only advertises what an agent can be asked to do). An agent may use a library skill only when its setup override allows it. A repository can carry skills of its own; see how the two combine under *Setup override*.
_Avoid_: skill store, skill registry

**Message**:
A durable, typed communication from one principal to others within a conversation. Every message sent to an agent is delivered at least once and recovered after the agent restarts.
_Avoid_: chat (chat is one kind of message), notification

**Conversation**:
A thread of messages among two or more principals, a group chat when there are more than two. An agent can be in many at once, and a message wakes the principals it is addressed to.
_Avoid_: channel, session, room

**Work request**:
A message in which one principal asks an agent to do something. It is a kind of message, not a separate entity, and it is handled once per message id. It replaces the removed *Task* as the way to ask for work.
_Avoid_: task, order, command

**Job**:
Long work an agent starts, from a work request or an event it decided to act on, running in the background while the agent keeps talking. It has a durable record (start, end, outcome, tokens, cost, a short summary), it can be addressed in chat, and it can be asked to stop, which it decides for itself. The domain does not hold jobs; agents publish when one starts, waits and finishes. Jobs replace the removed *Task* as the unit of long work.
_Avoid_: task, run

**Singleton resource**:
Something only one job at a time can use, such as the QA machine's application stack and browser. The lock is taken where the resource is physically used, so every route to it (a tool or a shell command) meets it.
_Avoid_: lock (that is how it is held), semaphore

## Events

**Event**:
A durable notification that a fact happened (a pull request opened, an alert fired, a schedule tick), published to a topic. It carries data, never instructions.
_Avoid_: signal, trigger, webhook (a webhook is only one way an event arrives)

**Topic**:
The name an event is published under, shaped `<source>.<object>.<change>` (for example `github.pull_request.opened`).
_Avoid_: channel, queue

**Producer**:
A principal that publishes events that originate outside the domain, such as the clock or a webhook receiver. It may publish only under its own topic prefix.
_Avoid_: source (that is one segment of a topic), ingester, adapter

**Receiver**:
The public-edge component that accepts webhooks from outside, authenticates them and buffers them without interpreting them. It never opens connections into the private network.
_Avoid_: gateway (that is the agents' policy proxy), webhook server

**Hub**:
The private-side component that pulls from the receiver, maps raw payloads to events and publishes them as a producer.
_Avoid_: event bus, scheduler, router

**Handler**:
Code written by an agent that runs on every event delivered to that agent and returns a decision: drop it, wake the agent, wake it with a cheaper model, start a job itself, notify the owner, or rewrite the event.
_Avoid_: hook, filter, script

**Subscription**:
A standing request by a principal to receive events matching a topic selector. It must state explicitly whether a match wakes the subscriber.
_Avoid_: listener, watch

**Wake**:
A delivery that causes an agent to run, as opposed to an event that is only recorded for it.
_Avoid_: notify, ping

**Rule**:
A declarative file kept in git that describes one subscription: which events wake which agent. The rules in git are the only way to create subscriptions. What an agent does with the event is its own decision (the removed *Reaction* started work on the platform's behalf).
_Avoid_: automation, workflow, reaction, policy (policy decides who may do what)

## Relationships

- An **Event** is published by a **Producer** under a **Topic**; a **Subscription** selects topics; a match either only records the event for the subscriber or **Wakes** an agent. The agent decides for itself what to do under its own authority.
- An agent acts on a **Work request** or an event by starting a **Job**; other principals learn of it through **Messages** and events.

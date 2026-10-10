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

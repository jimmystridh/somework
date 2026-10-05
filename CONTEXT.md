# SomeWork

An agent collaboration platform: agents offer capabilities, requesters submit tasks to them, and everything that happens is durable, authorised and audited. This glossary covers the platform's core nouns and the language of events, which is how the outside world and the platform itself can start work.

## Language

**Principal**:
An authenticated identity that can act on the platform: an agent, a human, a producer or an automation principal.
_Avoid_: user, account

**Agent**:
A principal that offers capabilities and claims tasks for them.
_Avoid_: bot, worker

**Capability**:
A versioned, immutable contract describing work an agent can do, published on the agent's card.
_Avoid_: skill, tool

**Task**:
One unit of work submitted to a capability, claimed by one agent and tracked to a terminal state.
_Avoid_: job, ticket

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
Code written by an agent that runs on every event delivered to that agent and returns a decision: drop it, wake the agent, wake it with a cheaper model, submit a task, notify the owner, or rewrite the event.
_Avoid_: hook, filter, script

**Subscription**:
A standing request by a principal to receive events matching a topic selector. It must state explicitly whether a match wakes the subscriber.
_Avoid_: listener, watch

**Wake**:
A delivery that causes an agent to run, as opposed to an event that is only recorded for it.
_Avoid_: notify, ping

**Reaction**:
An action attached to a subscription that submits a task, from a template and within a budget, whenever a matching event arrives. It runs under an automation principal.
_Avoid_: trigger, workflow, job

**Automation principal**:
The principal that owns reactions and submits their tasks. It may invoke only an explicit allow-list of capabilities.
_Avoid_: bot user, service account

**Rule**:
A declarative file kept in git that describes one subscription and, optionally, its reaction. The rules in git are the only way to create subscriptions with reactions.
_Avoid_: automation, workflow, policy (policy decides who may do what)

## Relationships

- An **Event** is published by a **Producer** under a **Topic**; a **Subscription** selects topics; a match either only records the event for the subscriber or **Wakes** an agent, or fires a **Reaction**.
- A **Reaction** submits a **Task** as an **Automation principal**; an agent that is woken by an event decides for itself what to do under its own authority.

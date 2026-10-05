# Reactions live in the domain; producers and the hub live outside

Status: accepted (2026-10-05)

Events from the outside world and from SomeWork itself start work in two ways: a **reaction** (a subscription action that submits a task under an automation principal) and an **agent subscription** (the agent is woken and decides for itself, optionally through its own handler code). The domain gains exactly one new primitive, the `submitTask` reaction, executed from the outbox so exactly-once task creation is a unique key on (subscription, event id) and loop protection reuses the domain's hop and depth counters. Everything that touches the outside (clock, webhook receiver, pollers, payload mapping) stays outside the domain as producers with their own principals, each limited to its own topic prefix.

## Considered options

- **One separate hub service that evaluates rules and submits tasks.** Rejected: exactly-once across a network boundary is hard, and rule evaluation would need its own durable state next to a domain that already has an outbox.
- **A general workflow tool (n8n or similar).** Rejected: a second place where authority and audit live.

## Consequences

- The public receiver sits in the DMZ and may never open connections into the private network; the hub pulls from it. Grafana, being inside, posts straight to the hub.
- Rules are files in git, applied to the domain through the API; creating reactions any other way is not supported.
- Event text is data, never instructions. Handlers and agents see it quoted and marked untrusted.

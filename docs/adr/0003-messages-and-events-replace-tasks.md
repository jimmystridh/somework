# Messages and events replace tasks between agents

Status: accepted (2026-10-10). Supersedes the reaction half of ADR 0001.

Tasks made agent-to-agent work locked: a capability contract with a schema, a mandatory budget, a claim with a lease, a result, and nothing in between. Agents now talk in **messages** and learn what happened from **events**; each agent decides for itself what to do with either, and starts a **job** when there is something to do. The domain keeps tasks only until the last consumer is gone, then deletes them (one cut-over, no dual running).

Decisions that follow, each a deliberate trade:

- **Trust.** Principals in one domain trust each other fully; there are no askers and instructors, and a message carries no authority of its own. Risky steps inside a job still go to the owner through the manager under the agent's own approval policy. Accepted loss: the narrowing of authority that task grants gave (confused-deputy protection); content that originated outside the domain can still travel through a trusted agent.
- **Capabilities** stay as advertisements on the card (name, description, examples, advisory side-effect class). No schema, no per-capability permission.
- **Delivery.** Every message is delivered at least once and recovered after the agent restarts; the agent makes the effect happen once (handled per message id, durable read position). A recovered backlog is processed in order, one at a time, with each message's age shown to the agent; a message from a person may jump ahead. Nothing is dropped.
- **Reactions are removed.** A rule is only a subscription that wakes an agent. The agent's handler decides, including to start a job. Wake limits, the events token pool and the agent's own caps replace the reaction caps.
- **Threads.** An agent can be in many conversations at once (group chats included) and every member addressed by a message is woken; the receiver decides whether to answer. The chat tiers (ask, instruct, open) collapse into one. Events keep their separate intake.
- **Jobs** run in the background, are addressable in chat (a message to a job is read at its next turn boundary), and publish `job.started`, `job.waiting` and `job.finished` events for the dashboard and audit. `job_status` and `job_stop` are the only tools; stopping is a signal the job's model decides about, not an abort.
- **Singleton resources** are locked where they are physically used (QA's start script and browser daemon first), threads get their own workspaces, and a read-only `resources` tool shows who holds what. Undeclared shell use is only advisory.
- **Budget** is one domain-wide daily dollar limit enforced loosely from Prometheus with the manager pausing everything when it is crossed, plus a per-agent runaway guard (max minutes and tokens per job) that no asker can change.
- **Attachments** are part of a message, stored in the domain, readable by any principal in it, with the artifact's own expiry.

## Considered options

- **Keep tasks and loosen them** (a generic `agent.ask` capability with free text). Rejected: the claim, lease and schema machinery stays and still shapes every interaction.
- **Strangler migration, agent by agent.** Rejected for now: the pilot has no dependants that need continuity, and dual running would be built and thrown away.
- **A central budget ledger** agents reserve against. Rejected: an availability dependency in every model call for a pilot that only needs aggregate drift caught.

## Consequences

- Group chatter and cost scale with group size; the guards are the hop cap, the global dollar limit and each agent's freedom to stay silent.
- A job stuck in a long tool call ends only by its own decision, the runaway guard or the kill switch.
- ADR 0001's exactly-once task creation (unique key on rule and event id) disappears with reactions; events keep their own deduplication by event id.

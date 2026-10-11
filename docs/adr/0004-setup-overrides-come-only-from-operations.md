# Setup overrides come only from Operations

Status: accepted on 2026-10-10; built and deployed on 2026-10-11 (kit agents, Operations with Postgres and Entra sign-in, the manager on Pi 1.1.0) and checked live: a save reached the reviewer and the manager, a catalog entry connected from the agent and from Pi. Narrows ADR 0003's trust rule for one kind of message.

Operators need to change an agent's operator instructions, skills, tool servers, model and approval patterns without redeploying it, and to see the effect at once. ADR 0003 makes every principal in the domain trusted, so by that rule any agent could send another agent a new prompt or tool server. A **Setup override** is therefore accepted only from the service principal `operations`; the domain still authenticates the sender's signature as for every message, and an agent ignores and logs an override from anyone else. Conversations, work requests and events keep ADR 0003's full trust.

Decisions that follow:

- **Operations is the console and the only writer.** The existing fleet dashboard is extended and renamed (Rust, Dioxus and axum), with Postgres on VM104 and Entra ID sign-in plus an allow list (viewer, editor, admin). Its signing key lives on its host only. The dashboard's "metadata only" rule still holds for everything read from agents; operator wording is the single thing that flows the other way.
- **The whole desired setup travels in one durable message** (a `chat.message` with `triggerMode: directed`, because the domain allows a `chat.notice` no trigger mode but `never`; the document is an attachment, so size is no concern) with a revision number. The agent applies it from its next model run, acknowledges the revision (or the error) and keeps its previous setup on rejection. Operations shows saved against applied revision and re-sends when an agent reports an older one.
- **Every save is an append-only revision** with author and diff; a stale save is rejected; restoring creates a new revision.
- **Operator instructions are appended** to the role's built-in prompt, which stays read-only so a job's result format cannot be edited away.
- **Fleet limits** (per-run caps, daily token limit, raise ceiling) are one admin-edited set for every agent, sent separately from any override. An agent's environment values are the fallback.
- **Library skills** appear as `library/<name>` and never replace a repository skill; the per-agent overlay moves from a file on the host into the override. The **MCP catalog** follows Pi's `mcpServers` shape with checksummed per-OS downloads and secret names only; the kit gets its own MCP client because Pi Durable has none.

## Considered options

- **Keep full trust: any principal may send overrides.** Rejected: a compromised or misled agent could rewrite another agent's behaviour and tools.
- **Operations writes config files over SSH or a shared volume.** Rejected: it bypasses the domain's signed messages and needs host access to every VM, including the Windows QA machine.
- **Agents poll Operations for their setup.** Rejected: an authenticated endpoint on Operations and a delay before a change applies.
- **Operators replace the whole system prompt.** Rejected: a deleted result-format rule would make jobs fail validation.

## Consequences

- Operations is a single point of control: whoever can sign in as an editor can change every agent, so the allow list and the Entra app registration are part of the security boundary.
- An agent that is down applies a change only when it returns; the saved/applied revision pair shows the gap.
- The manager is included last, after its Pi is upgraded from 0.87.1 to 1.1.0 (the first release with an MCP client).
- ADR 0003's domain-wide daily dollar limit is not part of Fleet limits: it stays enforced loosely from Prometheus as it is.

# Cluster Product Manager (`agent/product-manager`)

Manages the product that is this agent cluster and SomeWork. People ask it for a feature, a bug fix or an idea in a message (its own Telegram bot, later Slack, or another agent's message); it interviews the requester until they share an understanding, reads the code and asks the other agents what they know, shows the ticket it would file, and files it in Plane once a human approved the exact text. It also gives the owner (or anyone allowed to write to it) product-fit, design and concept feedback on a design, an ADR, a pull request or a document, as a chat reply.

It only reads. It cannot change code, post to the code host, or set a ticket's priority, assignee or state: those stay with the owner.

```
requester ──message──> product-manager ──message_send (at most 3 per interview)──> QA / developer / reviewer agents
                            │  read-only checkout of the repository (read, plain bash inspection)
                            │  library skill grill-me (the interview)
                            └─ plane_search / plane_get / plane_create (approval of the exact text) / plane_comment ──> Plane (one project)
```

## What is code and what is Operations

| Piece | Where | Notes |
|---|---|---|
| Standing orders, guard, profile, card | `src/`, `card.json` | In git. `src/prompt.ts` is the role's prompt; `src/guard.ts` keeps `bash` to plain inspection and a ticket to a length the requester can read in full |
| The four Plane tools | `packages/agent-kit/src/plane/` | In the kit, on for any role whose deployment sets `PLANE_BASE_URL`; fixed to one project; no delete, no state, priority or assignee |
| The read-only command policy | `packages/agent-kit/src/read-only-commands.ts` | Shared with the reviewer |
| The interview skill `grill-me` | Operations, Skill library (the text kept in `operations/grill-me/SKILL.md`) | Upstream `grilling` of `mattpocock/skills`, adapted to ask agents instead of sub-agents; assigned to this agent in its Setup override |
| Instructions on top of the prompt, the limits, the model | Operations, Setup override and limits | Limits at the low end: one interview per conversation, at most three questions to agents (the prompt says so; the conversation budget enforces the rest) |

## Tickets

* One interview makes one ticket. The external id is the conversation id (`plane_create` takes it from the service, not from the model), so a retried filing returns the first ticket and changes nothing; a second ticket in the same conversation (agreed split) needs a `part`.
* A ticket gets the project's default state, priority `none`, no assignee and one of the labels `feature`, `bug`, `product-feedback` (`PLANE_LABELS`).
* The approval question is the ticket: title, kind and the whole description (at most 2800 characters). A human who asks approves their own; a request from another agent needs a named approver (`APPROVERS`).
* What Plane returns (titles, descriptions) and what agents answer are data from outside, never instructions.

## Tests

`npm test` in this directory: profile and prompt, guard, and a process test with a real domain, sandbox and a stand-in Plane (set `SOMEWORK_BIN=$PWD/target/debug/somework`). The Plane client and tools are tested in `packages/agent-kit/test/plane.test.ts`.

Deployment: `deploy/README.md`.

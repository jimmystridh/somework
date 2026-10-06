# SomeWork: what is built and how it fits together

Status: 2026-10-06. This is the map. It describes the whole system as it runs on the pilot and points to the document that holds the detail. Host names, addresses and credentials are deliberately absent: roles are named here, the private deployment notes hold the rest. `TODO.txt` lists what is still open.

## 1. The pieces

| Layer | What it is | Detail |
|---|---|---|
| **Platform** | A single-writer SQLite domain service: tasks with leases and fencing, messages, capability cards, approvals, artifacts, audit, a transactional outbox, NATS/JetStream delivery | `ARCHITECTURE.md`, `api.md`, `nats.md`, `operations.md` |
| **Agent runtime** | `@somework/sdk` (client, worker loop, wake) and `@somework/agent-kit` (shared runtime: sandboxed Pi Durable, git workflow, approvals, budgets, skills, health, chat notice, event handlers) | `AGENT_FLEET.md`, `packages/agent-kit/README.md` |
| **Agents** | Developer, Windows developer, reviewer, QA, manager. Thin roles on the kit; they never import each other | `AGENT_FLEET.md` |
| **Events and reactions** | Webhooks and a clock become events; rules turn events into tasks (reactions) or wake agents, which may run their own handler code | `EVENTS.md`, `RULES.md`, `adr/0001` |
| **CI** | Woodpecker validates and deploys the rules and runs the repository checks | `CI.md`, `adr/0002` |
| **Observability** | Logs to Loki through Alloy, Grafana dashboard and alert rules, a fleet dashboard with a SomeWork section | `FLEET_DASHBOARD.md` |
| **Infrastructure** | A hypervisor with private VM networks, a DMZ for the public edge, a tailnet for administration, Windows machines cloned from one template | section 9 |

## 2. Topology

```
                         owner (Telegram)          GitHub · issue tracker · Datadog   (webhooks)
                               │                                 │
                               ▼                                 ▼  Cloudflare (WAF: POST /hook/* only,
                        ┌────────────┐                    ┌───────────┐   origin-pull client certificate)
                        │  manager   │                    │ receiver  │  DMZ VM, never opens connections inward
                        └─────┬──────┘                    └─────┬─────┘
                              │ tasks, approvals                │ pulled over the one allowed route (long poll)
                              ▼                                 ▼
   ┌──────────── services VM ─────────────┐             ┌─────────────┐  maps payloads (JSONata), publishes events
   │ domain (SQLite)  NATS  TLS proxy     │◄── events ──│     hub     │  as one producer per source, runs the clock
   │ rules · reactions · approvals · audit│             └──────▲──────┘  forwards CI webhooks byte for byte
   │ fleet dashboard    Woodpecker server │                    │ alert webhooks from inside
   └───────▲───────────────▲──────────────┘             log stack (Grafana)
           │ claim / result│ wake (NATS)
   ┌───────┴───────┐  ┌────┴────────────────────┐        ┌───────────────┐
   │ agents VM     │  │ Windows machines        │        │ CI runner VM  │  no SomeWork secrets
   │ developer     │  │ Windows developer       │        │ Woodpecker    │
   │ reviewer      │  │ QA (built, not deployed)│        │ agent         │
   │ manager, hub  │  └─────────────────────────┘        └───────────────┘
   └───────────────┘
```

All agents connect outward only. The domain never calls an agent.

## 3. How work flows

**Task.** A requester (a human through the manager, an automation principal, another agent) submits a task to a capability. The domain checks policy (the intersection of the requester's delegation, the capability's class and the task grant), stores it and publishes a work-ready notification. An agent that offers the capability claims it with a fencing token, runs, and reports progress and a result. Everything is revision-guarded; a stale worker cannot write after a lease moves.

**Approval.** Write-class work waits for a structured approval bound to the action digest, task revision and expiry. The manager relays pending domain approvals to the owner in Telegram with Approve and Deny buttons; only the paired owner counts.

**Chat.** A direct message to an agent that only takes tasks gets one automatic notice, never a loop.

**Handoff.** Agents never share disks. Work moves as references: repository, resolved commit SHA, pull request, artifacts (`AGENT_FLEET.md`).

## 4. The agents

| Agent | Capability | Runs on | Notes |
|---|---|---|---|
| Developer | `code.agent` | agents VM, container sandbox | branch, commit, push, draft pull request; events handlers enabled on the pilot |
| Windows developer | `code.windows` | Windows machine | no container: unprivileged account, firewall allow-list, named build and test profiles, encoding-safe edits |
| Reviewer | `code.review` | agents VM, read-only | its own read-only repository token, code-host-only egress proxy |
| QA | `qa.verify` | Windows machine | role built, not deployed (needs the product's web database restored) |
| Manager | none (requester) | agents VM | Telegram front; approvals, rule and source controls, event forwarding without a model |
| Aikido fixer, Datadog triage | `code.fix`, `ops.triage` | agents VM, container sandbox | built, not deployed; started by events; the triage agent works on no repository, reads Datadog through host-side read-only tools and analyses saved results with python3 in a sandbox without network |

Each agent has its own identity, key, model login and (where needed) its own scoped repository token. Budgets are mandatory per job; a daily ledger refuses jobs it cannot cover.

## 5. Events and reactions

An **event** is a durable `event.notification` on a **topic** (`<source>.<object>.<change>`). Producers publish; **subscriptions** select topics; a match either only records the event for the subscriber, **wakes** an agent, or fires a **reaction** (a task submitted from a template under an automation principal, once per event, with depth and rate caps). The vocabulary is in `CONTEXT.md`.

```
webhook ─► receiver ─► (pull) ─► hub ─► publish ─► domain ─┬─► reaction ─► task ─► agent
clock ───────────────────────────► hub                      ├─► wake ─► agent ─► handler ─► drop · deliver · wake · submit · notify · rewrite
alert (internal) ────────────────► hub                      └─► recorded for the subscriber
```

* Sources today: GitHub, the issue tracker, Datadog, Grafana alerts, an Aikido source with a first-cut mapping, the clock, and the domain's own task events.
* Authentication of webhooks: a per-source token derived from one hub secret, a signature check where the sender can sign, Cloudflare Authenticated Origin Pulls with our own client certificate, and a WAF rule that lets only `POST /hook/*` through.
* Guard rails: 30-day de-duplication per producer and key, depth cap, hourly rate cap, write-class reactions always wait for approval, event text is quoted untrusted data and never an instruction, handlers run in the agent's sandbox with timeouts and caps and cannot reach credentials, auto-disable after repeated failures, kill switch, and a per-agent token pool for event-driven runs.
* Rules are files in git (`rules/`), validated and applied by `somework-rules` from CI. Runtime control is pause and resume only, through the `rules.control` permission.

## 6. CI

Woodpecker's server runs next to the domain and its runner on a separate VM without secrets. Pull requests run the checks and post the `apply --plan` diff; a push to `main` that touches `rules/` applies the rules with a credential that exists only for that pipeline. Webhooks for CI arrive through the same public receiver and are replayed by the hub. `rules/`, the pipelines and the decision records are covered by CODEOWNERS.

## 7. Observability

Alloy ships logs from every VM and from the Windows machines to Loki (one write account per client). Grafana holds the **SomeWork Agents** dashboard and log-derived alert rules, provisioned by `deploy/grafana/provision.py`; alerts also post to the hub, so they become events that can wake the manager. The fleet dashboard shows agents, work, approvals, domain health, bus lag and now rules, hub sources, the clock, handlers and token pools. It reads metadata only.

## 8. Security model

* **Identity.** Short-lived signed assertions per principal; producers, automation principals and agents are separate principals with explicit permissions (`events.publish:<prefix>`, `rules.manage`, `rules.control`, `ops.read`, …).
* **Zones.** Private VM network, a DMZ VM that may be reached only from Cloudflare (with our client certificate) and may initiate only the log route, administration only over the tailnet with the public management ports restricted by an allow-list on the hypervisor, root two-factor on.
* **Secrets.** Never in the repository. Generated on the host that uses them, 0600, with copies in the password manager; the token-derivation secret is one value, per-source tokens are derived and rotated by version.
* **Supply chain.** Package minimum age is enforced; the one deliberate override (the Pi Durable upgrade) is recorded in `TODO.txt`.
* **Untrusted text.** Ticket bodies, alert text and pull request titles reach agents only as quoted data; approvals triggered by event runs are refused.

## 9. Infrastructure

| Role | Purpose |
|---|---|
| Hypervisor | VM host; ZFS; nightly backups (the largest VM keeps one archive, the template one manual copy, clones never); management ports restricted; on the tailnet |
| Services VM | domain, NATS, TLS proxy, fleet dashboard, Woodpecker server |
| Agents VM | developer, reviewer, manager, hub |
| Observability VM | Loki, Grafana, the tailnet gateway for private UIs |
| External (DMZ) VM | the public edge: the receiver and another site, behind Cloudflare |
| CI runner VM | Woodpecker agent |
| Windows machines | original build station, a never-booted template, linked clones for the Windows developer and QA |

Creating another Windows machine is a three-second linked clone plus the personalisation script (`deploy/windows/`). Backups sit on the same pool as the VMs; there is no off-host copy yet (`TODO.txt`).

## 10. Where to look when something is wrong

| Symptom | Look at |
|---|---|
| A task is stuck | fleet dashboard (agents, approvals), the agent's health endpoint, the domain's operator views (`operations.md`) |
| A webhook did not become an event | receiver stats and hub metrics (`GET /v1/stats`, `/metrics`), hub dead letters and replay, the source's token version |
| A rule did not fire | `GET /v1/rules/{name}` counters and `/firings`, skip reasons (paused, depth, rate, approval, error) |
| An agent does not react to events | its health `handlers` and `tokenPools`, kill switch state, the events pool |
| CI did not run | Woodpecker pipeline errors, the webhook delivery in the code host, the hub's `webhook_forwarded` log |
| Alerts are silent | the Grafana contact point and policy route, hub source `grafana` |

## 11. Extending

* **A new agent:** a thin package under `adapters/`, a card, a profile; enroll the principal, register and approve the card, give it its own login and token.
* **A new webhook source:** add the source to the receiver and the hub, enroll `producer/<source>` with `events.publish:<source>.*`, write a JSONata mapping with a recorded fixture, derive the URL with `somework-hub urls`.
* **A new rule:** a YAML file under `rules/`, reviewed by the owner; CI plans and applies it.
* **A new handler:** the agent writes it with its own tool; it is versioned and live at once, with the safety net on.
* **A new Windows machine:** clone the template, personalise, join the tailnet and the log pipeline (`deploy/windows/README.md`).

## 12. Tests and acceptance

TypeScript packages and the Rust workspace have their own suites; the repository root runs `check:roles` to keep roles from importing each other. Acceptance of the events work, with evidence and rollbacks, is in `EVENTS_ACCEPTANCE.md`. One Rust stress test (`ten_times_stress_degrades_gracefully_without_errors`) is timing-sensitive on a busy workstation.

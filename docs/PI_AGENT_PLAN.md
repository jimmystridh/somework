# Pi coding agent on SomeWork: review of the research report and plan

Input: `~/Downloads/deep-research-report.md` ("Building a Long-Running Pi Coding Agent Driven by a Message Queue", dated
2026-10-04). Reviewed 2026-10-05 against the SomeWork source, the live pilot, and public package metadata.

## 1. Verdict on the report

**The architecture is sound. Its queue half is mostly redundant for us, and its code is not usable as written.**

### What I could verify
* `@earendil-works/pi-durable` exists: 1.0.2, published 2026-10-04, MIT, Node >= 22.19, SQLite/JSONL/memory storage, README
  says "Experimental. The API changes without notice between releases." (npm registry.)
* `@earendil-works/pi-coding-agent` latest is 1.0.2.
* Pi RPC: `pi --mode rpc`, strict JSONL split on LF only, `prompt` response means "accepted", `agent_settled` marks the end
  of automatic work. (pi.dev docs.)
* From the Pi Durable README: `submit({requestId})` returns the existing submission on retry; `harness.resume()` after
  reopening storage; `replay: "safe"` per tool (otherwise the model gets an interrupted-error result); `root.abort()`,
  `submission.abort()`; progress via `watchEvents()` / `viewState()`; `whenBusy: "steer" | "follow-up"`; a `beforeTool` hook
  can block a call ("Needs approval"); `ExecutionEnv` with an id per container; **one process owns a storage, no
  cross-process locking**; the README states no authentication or multi-tenant isolation guarantees.

### Not verified
Model ids in the examples (`gpt-6.1-sol`), the Cloudflare `PiHarness` beta, pricing figures, the cited provider limits
(SQS 12 h etc.; widely documented, not rechecked), and every code listing (never run).

### What is right and worth keeping
1. **Acknowledgement boundary:** accept durably, then execute independently. Do not tie a transport lease to hours of work.
2. **Three separate idempotency levels:** command (`requestId`), external side effect (derived keys), result delivery (outbox).
3. **Conversation affinity is state:** route by a stable key to a fixed logical shard, never `hash % replicas`.
4. **Retry budgets multiply** (5 x 5 x 5 x 5): let each layer retry only its own failures.
5. **Crash-boundary test matrix** with a written expected outcome per boundary.
6. **Readiness means "can accept work", liveness means "process alive"**; a provider outage must not restart pods.
7. Treat repository text, issue text and queue payloads as hostile.

### What is wrong or missing
| Issue | Where |
|---|---|
| Both examples would not run as printed: the Python listing contains a C-style comment inside code (the report admits it) | Python worker |
| TS example creates one `root` and **ignores `agentKey`**, although the whole text argues for per-key conversations (`createConversation` per key is what the README offers) | TS worker |
| `nack(requeue=true)` with no delay turns a persistent store failure into a hot loop | TS worker |
| Reconnect attempt counter never resets after a successful connection; `error` listener registered after `consume`; `prefetch 16` is far too high for expensive jobs | TS worker |
| The result **outbox is described but not implemented**; the example publishes nothing | both |
| The security section asks for sandboxing, the example runs tools on the host (`NodeExecutionEnv` with a cwd) | TS worker |
| Python: `--no-session` loses conversation state on restart; heartbeat thread swallows errors and keeps extending a lease it may have lost; SIGTERM only sets a flag and waits for the whole job | Python worker |
| No cancellation path from the producer (`abort(jobId)` exists in the interface, nothing calls it) | design |
| No approvals / human-in-the-loop, no cost or token budget per job, no workspace provisioning or cleanup, no git credential model | design |
| Single-owner storage is named but the HA/failover story is "later" | design |

## 2. What SomeWork already gives us (so we do not add a broker)

The report's stack is: broker + ingress + durable store + outbox. SomeWork already is the transport, the durable job store
and the outbox:

| Report layer | SomeWork today |
|---|---|
| Producer-supplied `jobId` idempotency | `Idempotency-Key` on `POST /v1/tasks`; task id is the durable identity |
| Durable acceptance before execution | task row + outbox committed in one SQLite transaction (`BEGIN IMMEDIATE`) |
| Broker redelivery / DLQ | wake over NATS (+ 25 s HTTP sweep); lease reaper re-queues; `republish-queued` for recovery |
| Visibility timeout / heartbeat | lease + heartbeat (default 30 s / 10 s) with **no maximum duration** |
| Stale worker protection | fencing token on every heartbeat/complete/fail |
| "Do not replay unsafe work" | side-effect classes; **irreversible work is parked for reconciliation, never retried** |
| Result outbox | task completion with result + artifacts is one transaction; events/messages go through the outbox sinks |
| Approvals | approvals bound to digest + revision (spec) |
| Cancellation | cooperative cancel seen on heartbeat, acknowledged by the worker |

So the right reading of the report for us is: **keep its Pi half (Pi Durable as the durable executor, requestId, replay
safety, sharding by key, crash matrix, security) and drop its broker half (SomeWork replaces RabbitMQ/SQS/outbox).**

One real difference: the report ACKs the queue *before* the run; SomeWork's lease stays held *during* the run. That is fine
here (heartbeat extends without a cap, fencing protects state) as long as the agent does **not** abort Pi when it loses the
lease or shuts down, see 3.2.

## 3. Design rule: the agent is independent and talks to the domain itself

Revised after review: **no process is spawned for the agent.** The Pi agent is a long-running service that holds its own
SomeWork identity and runs the worker loop itself (claim, lease heartbeat, fencing, progress, complete/fail, cancel). It
chooses how it learns about work: HTTP long-poll (`GET /v1/tasks/next?wait=`, `GET /v1/events`), NATS pull consumers, or
both. This is what the spec's "SDK" half of the collaboration sidecar means; today only the Rust SDK (`somework-client`)
exists, so the first deliverable is a **TypeScript worker SDK** with the same behaviour as the sidecar's worker runtime.
The sidecar stays what it is for MCP clients (a protocol bridge that holds their key); its `--mode worker --exec/--http`
adapters remain only for small scripts such as the pilot's demo reviewer, and nothing in this plan uses them.

What changes because the agent now holds the credential:

### 3.1 Key isolation moves from "separate process" to "separate trust plane"
A coding agent runs arbitrary shell commands. The SomeWork key and the model credentials live in the **harness** process;
tools run in an **ExecutionEnv** in a different container that has neither (Pi Durable supports this directly: the
harness and the tool environment can be different machines/containers, `env` id per container). Rules:
* the sandbox container gets only the workspace volume, a repo-scoped git token, and an egress allowlist;
* extensions, skills and prompt templates are not loaded from the workspace (`--no-extensions`-style settings, as `pi-demo`
  already does); custom tools are our own audited TypeScript running in the harness, never repository code;
* the harness never puts its credentials in the model context or in tool environments.
(Today's `pi-demo` mounts `~/.pi/agent` with model credentials read-write into the container whose tools run the model's
shell commands; the new service must not copy that.)

### 3.2 Cancellation and loss are now local decisions, not a protocol
The agent knows why it stopped and acts accordingly: requester cancel or timeout -> `submission.abort()`; lease lost or its
own shutdown -> **detach** (Pi Durable keeps the run, the re-queued task is re-attached through the same `requestId`).
No change to the Rust sidecar is needed for this.

### 3.3 Conversation affinity
SomeWork tasks carry a `conversationId` and ContextPacks. Map `agentKey = <repository>#<conversationId>` (an explicit,
validated capability input). Pi Durable keeps one conversation per key; follow-up tasks continue the same Pi session.
Within a key, serialize (`whenBusy: "follow-up"`); across keys, run concurrently up to a global cap set by provider rate
limits, not by queue depth.

### 3.4 Storage ownership and scale
One Pi Durable process per SQLite file. Start with **one agent service, one volume, many conversations** on VM102. Scale
later with fixed logical shards (e.g. 64) and an explicit shard-to-agent ownership table, one SomeWork agent id per shard
(`targetAgentId` routing already exists). Never run replicas against one file.

### 3.5 Idempotency of effects
`requestId = "somework:" + taskId` (deliberately not the attempt number, so a retry converges on the same Pi submission).
Derived keys for effects: branch `agent/<taskId>`, PR lookup by head branch before create, comment marker
`somework:<taskId>`. Capability side-effect class `write` (branch, push, PR), **never** `irreversible`: merge and deploy stay
human actions behind an approval.

## 4. Target architecture (VM102)

```
requester ──► SomeWork domain (VM105) ◄── NATS wake + short HTTP sweep (outbound only) ── pi-agent container
                                                                                     ├─ Pi Durable harness (storage volume, single owner)
                                                                                     ├─ SomeWork worker SDK (own key, own claim loop)
                                                                                     ├─ model credentials
                                                                                     └─ remote ExecutionEnv ──► sandbox container
                                                                                                                 (workspace volume, no keys, egress allowlist)
```

Capability `code.agent` v1 (side effects `write`): input `{agentKey?, repository: {url, ref}, instruction, budget:
{maxTokens, maxMinutes}}`; output `{summary, branch, commits[], prUrl?, status}`; artifacts: the final patch and a transcript
digest, never raw transcripts. Progress comes from `watchEvents()` as throttled SomeWork progress.

Crash matrix, mapped to what already exists:

| Crash point | Required outcome | Mechanism |
|---|---|---|
| Agent process dies mid-run | lease expires, task re-queued, restart re-attaches | lease reaper + `resume()` + requestId |
| Pi dies mid model call | resumes on restart | `harness.resume()` |
| Pi dies mid safe read tool | replayed | `replay: "safe"` |
| Pi dies mid write tool | model sees an interrupted error, no blind repeat | default replay policy; derived effect keys |
| Pi finished, agent dies before `complete` | retry re-attaches, gets the settled result, completes | requestId returns the same submission |
| Domain or NATS down | work continues; the result completes when reachable | HTTP fallback, fenced complete |
| Duplicate wake / double claim | one execution | claim is fenced; per-process inflight set |

## 5. Work plan

Sizes: S <= 1 day, M = 2 to 4 days, L = about a week.

| Phase | Work | Exit criteria |
|---|---|---|
| **0. Spike (S): DONE 2026-10-05, see `adapters/pi/spike/RESULTS.md`** | Scratch project with Pi Durable 1.0.2 and a **scripted fake model provider**: confirm `requestId` dedupe across a process kill, `resume()`, `watchEvents` shape, `abort`, `replay: "safe"`, conversation per key, a remote `ExecutionEnv`, memory use. Decide whether `pi-demo` (0.87.1) is upgraded or left alone | A recorded run of each claim; a written list of API gaps. Cheap exit if the experimental API is unusable |
| **1. TypeScript worker SDK (M): DONE 2026-10-05, `sdk/typescript/` (27 tests against a real domain; NATS wake with an HTTP safety net and no long polling added 2026-10-05; messages as a worker feature deferred)** | `sdk/typescript`: assertion signing (EdDSA, same claims as the Rust client), retries with idempotency keys, long-poll wake, optional NATS wake with `tls required` + CA file, 25 s task sweep, claim with lease + fencing, heartbeat, progress, complete/fail, cancel observation, lease-loss and shutdown hooks, jittered backoff everywhere. **Conformance tests run against the real domain** (spawned from Node, like the Rust integration tests): crash/lease-loss, duplicate wake, stale fencing, outage | Same behaviours as the Rust worker, proven by tests; a tiny example agent |
| **2. Pi agent service (L): DONE 2026-10-05, `adapters/pi/`** | `adapters/pi/` behind an `AgentRuntime` interface: per-key conversations, `submit(requestId)`, event translation, abort vs detach, remote ExecutionEnv, SIGTERM that detaches, `/ready` (storage open, resume done) and `/live`, schema validation, a hard budget per job (no budget, no job) | Every row of the crash matrix passes against real Pi Durable with the fake model |
| **3. Sandbox (L): DONE 2026-10-05** | Harness container (keys, no tools) and sandbox container (tools, no keys; a small RPC daemon implements Pi's ~20-operation `ExecutionEnv`, with cancellation honoured in every operation): non-root, read-only rootfs, no docker socket, egress allowlist (git host, model API), repo-scoped git token, CPU/memory/pids limits | Negative tests: the sandbox cannot read harness credentials or reach other hosts; env contains no secrets |
| **4. Deploy to VM102 (S): DONE 2026-10-05, drills passed** | Compose project next to the worker; images pinned by digest; secrets via files; same runbook style as `deploy/` | Smoke task end to end on VM102; `docker stop` and `kill -9` drills |
| **5. Real task path (M): DONE except a real GitHub repository (needs a repo and token)** | Capability card + schemas, branch/PR idempotency, patch artifact upload, requester MCP examples; optionally the Telegram bridge becomes a SomeWork requester | One real repository task, killed and retried twice, no duplicate PR |
| **6. Approvals (M): DONE (verified with the real model)** | A `beforeTool` block maps to SomeWork `input_required` / approval; merge and deploy remain human | Pi pauses, requester approves, run continues; denial ends cleanly |
| **7. Observability and cost (M): DONE; metrics scrape and dashboards written but not loaded centrally** | Metrics from events (jobs, durations, tokens, tool failures, resumes), task ids on every log line, no prompts or file contents in telemetry, per-job and daily budgets, Grafana via the existing Alloy | Dashboard, plus alerts for stuck jobs and budget burn |
| **8. Scale (later): tooling DONE (shards, routing, ownership checks), not deployed: one service is enough today** | Fixed logical shards, one agent id per shard | Only when one service is the bottleneck |

Critical path: 0 -> 1 -> 2 -> 3 -> 4. Phase 1 is independent of Pi and is valuable on its own: any agent in any TypeScript
runtime gets a first-class SomeWork worker. A Python SDK follows the same shape if wanted later.

## 6. Decisions

Taken 2026-10-05:
* **Sidecar `exec`/`http` worker adapters: keep** (small scripts and demos). The Pi agent does not use them.
* **Experimental dependency:** proceed with Pi Durable behind our own `AgentRuntime` interface, pinned exactly. Phase 0 found
  nothing that blocks it (see `adapters/pi/spike/RESULTS.md`).
* **Model access:** default provider `openai-codex`, model `gpt-5.5`, thinking `low` (the same defaults as the existing Pi).
  Only the `openai-codex` credential and those defaults were copied, into the new service's own directory on VM102
  (`~/somework-pilot/pi-agent/auth`, owned by uid 10001, mode 0600). `antigravity` (OAuth with a project id, its access token is
  already expired on both copies, refresh-only) and `opencode-go` (a static API key) are deliberately **not** copied until needed.

Still open:
1. **OAuth refresh collision (needs your action before real use).** The Codex credential is an OAuth session. The Mac's Pi, the
   running `pi-demo` and the new service now hold the *same* refresh token, and its access token expires today at 15:08. If the
   provider rotates refresh tokens, whichever instance refreshes first can invalidate the others. I did not trigger a refresh to
   find out. Recommended: give the new service its own login (a distinct refresh token) or a plain `OPENAI_API_KEY`; the staged
   copy is fine for the Phase 0 to 4 work that uses the fake model.
2. **Which repositories and which git identity** for the first real task (a repo-scoped token, not a personal one).
3. **`pi-demo` and the Telegram bridge:** leave as is, or later route Telegram requests through SomeWork tasks.
4. **What makes `antigravity` and `opencode` "special"** for the Pi service (they will need their own provider handling).
5. **VM105 memory:** the pilot fits in the current 1.8 GB with about 1 GB free and no swap. The Pi service belongs on VM102
   (15 GB), so VM105 does not need the extra RAM for this plan. A bump to 4 GB would mainly buy headroom for log shipping and
   backups and let the container limits be raised (domain 1 GB, broker 512 MB); add a little swap too.

## 7. Risks

* **Phase 0 results (verified by running):** requestId dedupe, resume, replay-safe vs unsafe tools, parallel conversations and serial
  per conversation all behave as documented. Caveats found: requestId is per conversation, no lookup by custom key, abort waits for
  non-cooperative tools, SQLite storage rides on Node's experimental `node:sqlite`.
* Pi Durable is young and its API "changes without notice between releases": mitigated by the pin, the adapter interface,
  and the phase-0 spike; the fallback is Pi RPC (`--mode rpc`, stable) with job-level retry, losing step-level recovery.
* **Credentials now live in the agent.** The model never sees them, but anything that executes in the harness process could
  read them: only our own audited tools run there; repository code runs only in the sandbox container.
* Same-host kernel sharing with `pi-demo` on VM102: acceptable for a pilot, not for untrusted repositories.
* Prompt injection through issue text: the agent has write access to a branch; keep merge/deploy human, repo-scoped tokens,
  egress allowlist.
* Cost runaway: budgets are phase 7, but a hard token cap belongs in phase 2 (a job without a budget is rejected).

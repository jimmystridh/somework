# Phase 0 spike: Pi Durable against the claims in the research report

Run 2026-10-05 on Node 22.22 with `@earendil-works/pi-durable@1.0.0`, `pi-ai@1.0.0`, `chord@1.0.0` (installed exactly pinned;
the supply-chain guard held back 1.0.2 because it was inside its minimum-age window). The model is `fauxProvider()` with a
stateless script, so every result is deterministic and no credential is involved. Reproduce:

```
cd adapters/pi/spike && npm ci --ignore-scripts
node scenario-crash.mjs slow_read     # kill -9 mid replay-safe tool, then resume + same requestId
node scenario-crash.mjs push_branch   # kill -9 mid side-effecting tool
node scenario-misc.mjs                # abort, event stream, conversation per key
node scenario-abort.mjs               # abort latency, cooperative vs non-cooperative tool
```

| Claim | Result |
|---|---|
| Same `requestId` after `kill -9` returns the existing submission | **Confirmed** (id 7 before and after) |
| `resume()` continues an interrupted run | **Confirmed**; run completed with a single final answer |
| Replay-safe tool is re-run, unsafe tool is not | **Confirmed**: `slow_read` started twice (once per process), `push_branch` started **once**; the model received `interrupted: "Tool push_branch was interrupted and may have partially run"` and finished |
| Many conversations in one harness, parallel across them | **Confirmed**: two keys with 2 s of work each took 2.03 s |
| One conversation serializes | **Confirmed**: two submissions to one conversation took 4.04 s |
| Event stream usable for progress | **Confirmed**: `run_start`, `turn_*`, `message_*`, `tool_execution_start/end`, `usage_changed`, `run_end`, `submission` |
| Abort | **Works, bounded by the tool**: a tool that ignores cancellation delayed `abort` by 7.4 s (its full runtime); a tool using `awaitWithContext(promise, context)` aborted in 4 ms, the tool result was `aborted` and the submission ended `unanswered (aborted)` |

> Correction (same day): the first version of this table said a cooperatively aborted submission still ended `done`. That came from
> calling `awaitWithContext(context, promise)` with the arguments reversed (the signature is `(promise, context)`), which threw
> immediately instead of honouring cancellation. Re-measured with the correct call; the table above is the corrected result.

## Things the report did not say
* **`requestId` is conversation-scoped** (`submissionByRequest(conversationId, requestId)`). The same id in another conversation is a
  different submission. With `agentKey` routing this is fine as long as a task always maps to the same key.
* **There is no lookup of a conversation by custom key** (`ConversationQuery` only filters by owner). The key to conversation
  index is ours: a document on the root conversation, updated in a commit (verified: same key resolves to the same
  conversation). Creating the conversation and recording the key are two commits in the spike; the window between them needs
  closing (the `init` option on `createConversation` runs in the creating commit) before this is production code.
* **Cooperative cancellation is the tool author's job.** Every tool, including the bash tool and our remote environment, must
  race its work against the call's `Context` (`awaitWithContext(promise, context)`) or abort stalls for as long as the tool runs.
* **SQLite storage uses Node's built-in `node:sqlite`, which Node still labels experimental** (a warning on every start).
  Pin the Node version and treat a Node upgrade as a storage-affecting change.
* **`ExecutionEnv` = a ~20-operation filesystem plus shell execution.** A sandbox container needs a small RPC daemon implementing
  it (the harness side is a `RemoteExecutionEnv`). That is a larger job than the plan assumed (phase 3: M -> L).
* The report's examples use a single `harness.root(...)` for all jobs and a model id I could not verify; neither is needed.

## Verdict
The experimental dependency behaves as documented for everything the plan relies on. Proceed to phase 1 (TypeScript worker
SDK). Risks carried forward: API churn between 1.0.x releases (pin exactly, keep the `AgentRuntime` interface), `node:sqlite`,
cooperative abort, and the remote environment daemon.

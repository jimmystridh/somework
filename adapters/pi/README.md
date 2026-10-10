# Pi coding agent as a SomeWork worker

An independent service: it holds its own SomeWork identity, learns about work itself (`sdk/typescript`: NATS wake with a short-HTTP safety net, no long polling), and runs **Pi Durable**
(`@earendil-works/pi-durable`, experimental, pinned exactly) as a durable coding agent. Nothing is spawned by a sidecar.

```
requester ─► domain ◄─ NATS wake / HTTPS ─ agent (harness)            sandbox                 egress proxy
                                           ├ SomeWork key            ├ tools run here        ├ host allowlist
                                           ├ model credentials       ├ no credentials        └ private ranges refused
                                           ├ Pi Durable + SQLite     ├ no route out but ─────┘
                                           └ git/PR steps ──RPC────► └ the workspace volume
```

This package is the **developer role**: `card.json` (the contract), `src/profile.ts` (the profile) and `src/main.ts` (one line: `runAgentService({ profile })`). The
runtime itself is `@somework/agent-kit` (`packages/agent-kit`, see its README for the role contract and the module list):

* `runtime` / `pi-runtime`: `AgentRuntime` is the interface everything else depends on; `pi-runtime` is the only file that knows Pi Durable.
* `handler`: the job handler (validate, capability check, budgets, shard check, prepare workspace, run, finalize, upload patch); `health`:
  `/live`, `/ready`, `/metrics`; `service`: composes it all into the running process.
* `git`: deterministic, idempotent branch / commit / push / pull request steps run by **our code, not the model**. The git token is handed to
  a single command at a time, while no model tool is running, and the credential helper answers only for the hosts in `GIT_TOKEN_HOSTS`.
* `sandbox/`: the sandbox daemon (wraps Pi's own `NodeExecutionEnv`) and `RemoteExecutionEnv`, Pi's `ExecutionEnv` over HTTP.
  `egress/`: the allowlist proxy that is the sandbox network's only exit.
* `policy`: commands that wait for a human (sudo, pipe-to-shell, `rm -rf` outside the workspace, `git push`, publish, ...).
  The model's call blocks, the task shows `input_required`, and the requester answers `{approved, reason?}`.
* `shards`, `ledger`, `metrics`, `log`, `credentials`, `config`, `skills`.

**Repository skills** are opt-in: `SKILLS_ALLOW=name,name` (and `SKILLS_OVERLAY_DIR`) make the agent read those skills and `AGENTS.md` from the
checked-out repository; with neither set nothing changes. Details in the kit README.

## The `code.agent` capability (`card.json`)
Input: `{repository: {url, ref}, instruction, budget: {maxTokens, maxMinutes}, agentKey?}`. **A job without a budget is rejected**
(schema) and budgets are clamped to the service's caps; a daily token ledger refuses jobs it cannot cover. Output: `{status, summary,
branch, commits[], prUrl?, usage}` plus the patch as an artifact. Side effects: `write` (never `irreversible`: merge and deploy stay
human). The agent and the requester must both be enrolled with `--side-effects write`.

## Model providers
| `PI_PROVIDER` | Credential in `auth.json` | Notes |
|---|---|---|
| `openai-codex` (default, `PI_MODEL=gpt-5.5`) | `{"type":"oauth", ...}` | the service needs its own login: a refresh token shared with another Pi installation can be invalidated by whichever refreshes first |
| `openai` | `{"type":"api_key","key":...}` or `OPENAI_API_KEY` | |
| `opencode-go` | `{"type":"api_key","key":...}` or `OPENCODE_API_KEY` | built into pi-ai; models such as `deepseek-v4-flash`, `kimi-k3`, `glm-5.3` (full list: `opencodeGoProvider().getModels()`) |
| `antigravity` | `{"type":"oauth","access","refresh","expires","projectId","email"}` | Google account login done with Pi on a workstation; the service never logs in. Uses the `pi-antigravity` package (pinned), loaded through `jiti` because it ships TypeScript sources; its account file lives under `$PI_STATE_DIR/antigravity`, never `~/.pi`. It only talks to `*.googleapis.com` (the package refuses other base URLs) |

`auth.json` may hold several providers; refreshes are written back to that file only. Every provider an allowed model needs is registered
at startup, and a model the provider does not offer stops the service at startup instead of failing a job.

**Per-job model.** `input.model: {provider, id}` is optional. It is accepted only if listed in `PI_ALLOWED_MODELS` (comma separated
`provider/model-id`; the default `PI_PROVIDER`/`PI_MODEL` is always allowed), otherwise the task fails with `model_not_allowed`. The
model is fixed when a conversation starts: the same `agentKey` with a different model gets its own conversation.

**Where the code goes.** Selecting `antigravity` sends the repository content the agent reads to Google through the account whose login is
installed; `opencode-go` routes it to third-party model hosts. Neither is a default: enable them deliberately (`PI_ALLOWED_MODELS`) and
only for repositories whose owners accept that.

## Behaviour under failure
`requestId = somework:<taskId>` (not the attempt number), so every retry converges on the same Pi submission.

| Event | What happens |
|---|---|
| process killed (`kill -9`, OOM, host reboot) | lease lapses, task re-queued, restart calls `harness.resume()`, the retry re-attaches; safe tools replay, side-effecting tools get an `interrupted` result |
| `docker stop` / SIGTERM | handler detaches (the run is not aborted), process exits in under a second with code 0 |
| requester cancel | run aborted, task acknowledged as cancelled |
| timeout / token budget | run aborted, failure `timeout` / `budget_exceeded` |
| lost lease | outcome discarded, the run keeps going for whoever re-claims |
| finished but outcome not committed | retry re-attaches, finalize finds the commit and the pull request: nothing is done twice |

## Conversations

Every message sent to the developer is read by its model in a run of its own, with the coding tools in a scratch directory of the conversation; it answers, or says `NO_REPLY` when there is nothing to add. A code change is a **job**: the model calls `code_agent` (the instruction, optionally `repo` and `ref`, else `CHAT_REPOSITORY_URL`/`CHAT_REPOSITORY_REF`) which starts a `code.agent` v2 job in the background and returns at once. The job works on a branch named `agent/job-…`, the branch and the pull request are made by the service as always, and the pull request and the patch (an attachment) are posted to the conversation when it is done. It runs with the role's own tools, guards and approvals; a step that needs approval is asked of an approver (the manager) in the conversation.
Settings: `CHAT_REPOSITORY_URL`, `CHAT_REPOSITORY_REF`, `CHAT_INSTRUCT_TOKENS` and `CHAT_INSTRUCT_MINUTES` (the budget of one conversation run), `CHAT_TOKEN_SHARE`, `APPROVERS`, `THREADS_MAX_CONVERSATIONS` (all optional; the full table is in `packages/agent-kit/README.md`).

## Tests
Most tests live with the code they test in `packages/agent-kit/test` (run `npm test` there); this package keeps the role-level ones (profile and card,
the service end to end against a real domain, the crash matrix). `npm test` (needs `git`, and the domain binary `dist/somework` or `SOMEWORK_BIN`) covers: sandbox (isolation, cancellation kills the process
tree), runtime (dedupe, abort, budget, detach, per-key serialization, approvals), git (local bare remote), units (shards, ledger,
credentials, metrics, redaction, GitHub client), providers (allowlist, opencode-go, antigravity wiring and OAuth write-back, per-job model), egress proxy, service end to end against a **real domain** (budget, shard, approvals,
cancel, lost outcome, metrics), and a crash matrix with **separate processes and `kill -9`**. The fake model (`@somework/agent-kit/providers/faux`,
`PI_PROVIDER=faux`) is stateless, so it behaves identically after a restart.

Deployment on VM102 and its drills: `deploy/README.md`. Plan and rationale: `docs/PI_AGENT_PLAN.md`.

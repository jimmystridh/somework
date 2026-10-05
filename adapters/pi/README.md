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

* `src/runtime.ts` `AgentRuntime`: the interface everything else depends on. `src/pi-runtime.ts` is the only file that knows Pi Durable.
* `src/service.ts`: the job handler (validate, budgets, shard check, prepare workspace, run, finalize, upload patch) plus `/live`,
  `/ready`, `/metrics`.
* `src/git.ts`: deterministic, idempotent branch / commit / push / pull request steps run by **our code, not the model**. The git token
  is handed to a single command at a time, while no model tool is running.
* `src/sandbox/`: the sandbox daemon (wraps Pi's own `NodeExecutionEnv`) and `RemoteExecutionEnv`, Pi's `ExecutionEnv` over HTTP.
* `src/egress/`: the allowlist proxy that is the sandbox network's only exit.
* `src/policy.ts`: commands that wait for a human (sudo, pipe-to-shell, `rm -rf` outside the workspace, `git push`, publish, ...).
  The model's call blocks, the task shows `input_required`, and the requester answers `{approved, reason?}`.
* `src/shards.ts`, `src/ledger.ts`, `src/metrics.ts`, `src/log.ts`, `src/credentials.ts`, `src/config.ts`, `src/main.ts`.

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

## Tests
`npm test` (needs `git`, and the domain binary `dist/somework` or `SOMEWORK_BIN`): sandbox (isolation, cancellation kills the process
tree), runtime (dedupe, abort, budget, detach, per-key serialization, approvals), git (local bare remote), units (shards, ledger,
credentials, metrics, redaction, GitHub client), providers (allowlist, opencode-go, antigravity wiring and OAuth write-back, per-job model), egress proxy, service end to end against a **real domain** (budget, shard, approvals,
cancel, lost outcome, metrics), and a crash matrix with **separate processes and `kill -9`**. The fake model (`src/fake-model.ts`,
`PI_PROVIDER=faux`) is stateless, so it behaves identically after a restart.

Deployment on VM102 and its drills: `deploy/README.md`. Plan and rationale: `docs/PI_AGENT_PLAN.md`.

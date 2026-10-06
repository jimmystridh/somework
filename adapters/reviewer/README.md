# Reviewer role (`code.review` v3)

Reviews someone else's change and returns findings. A role of the SomeWork fleet (`docs/AGENT_FLEET.md`): a card, a profile and a `main.ts`
on top of `@somework/agent-kit`, with the pieces below that are specific to reviewing. **Read-only**: it never commits, pushes, opens a pull
request, comments or approves anything. Comments it would leave come back to the requester as `draftComments`; posting one is a separate
action that the requester approves.

```
requester ── code.review@3 {repository:{url,ref}, pullRequest?, ticket?, focus?, budget} ──► agent/reviewer
                         ◄── {verdict, summary, findings[], openQuestions[], checked[], residualRisk?, draftComments?} + report.md artifact
```

## The contract (`card.json`)
* Input: `repository` (`url`, and `ref`: the **branch** to review as it exists on the remote), optional `pullRequest` (number), `ticket` (key, for the
  intent check), `focus`, `agentKey`, `model`, and a **required `budget`** (`maxTokens`, `maxMinutes`).
* Output: `verdict` (`approve` · `request_changes` · `needs_clarification`), `summary`, `findings` (each `severity` P0–P3, `file`/`line` when
  there is one, `title`, `detail` = the concrete failure mode, optional `suggestion`), `openQuestions`, `checked`, `residualRisk`, `draftComments`,
  `usage`. `truncated: true` when something was cut to the limits. The full report is attached as `<taskId>-review.md` (`text/markdown`).
* `sideEffects: read`, so the agent is enrolled with `--side-effects read` and nothing it requests needs a write permission.
* It is a new capability version (v3) next to the demo reviewer's `code.review` v1/v2, so the two never conflict in a catalog.

## How a review runs
1. The kit's handler validates (capability served, budget present, input shape), applies the budget caps and the daily ledger, and clones the
   repository in the harness; the sandbox only sees the checked-out files at `origin/<ref>`.
2. With a read-only code-host token and a `pullRequest`, `src/context.ts` adds the pull request's description, changed files, checks on the head
   commit and review threads to the instruction (marked as untrusted text; each section that cannot be read says so). Without a token the
   review is of the ref alone.
3. The model runs with `read` and `bash` only (`allowedTools`), the standing orders in `src/prompt.ts`, and the repository skills the deployment allows
   (kit skill loader, read from the ref; none unless `SKILLS_ALLOW` names them).
4. `src/review-runtime.ts` parses the answer's last fenced `json` block, validates it (`src/result.ts`) and caps sizes. If it cannot be used there
   is **one repair turn** in the same conversation with what is left of the budget; if that fails too, the task fails with `invalid_review_output`
   (not retryable) and the raw answer is attached as an artifact referenced from `failure.details.rawAnswer`.
5. `src/hooks.ts` (`result`) maps the review to the task result and uploads the Markdown report.

## What the model may run
`bash` is classified command by command (`src/commands.ts`); `;`, `&`, `|` split a command, quotes are ignored on purpose (splitting too much only
turns "allow" into "approve"):

| Class | Examples | What happens |
|---|---|---|
| allow | `git diff/log/show/blame/grep/ls-files/rev-parse`, `git branch -a`, `rg`, `grep`, `cat`, `ls`, `find` (no `-exec`/`-delete`), `sed -n '10,40p'`, `head`/`wc`/`sort`… as pipe filters, `cd`, `echo`, `2>&1` | runs |
| deny | `rm`, `mv`, `cp`, `chmod`, `tee`, any `>` redirect, `git push/commit/checkout/reset/fetch/…`, `git branch -D`, `git -c …`, `--output=`, `--pre`, `sed -i`, `curl`/`wget`/`ssh`, `sudo`, `tar` | refused at once, **nobody is asked** (the runtime answers "denied" itself) |
| approve | everything else: `npm test`, `dotnet build`, interpreters, `awk`, `xargs`, `$(…)`, backticks, `VAR=x cmd` | waits for the requester (`input_required`; answer `{approved, reason?}`); running the branch's own code is the requester's call |

The model also has no `write` or `edit` tool. This is a policy, not a kernel boundary: see "Limits" in `deploy/README.md`.

## Configuration
The kit's environment (`SOMEWORK_URL`, `SOMEWORK_KEY_FILE`, `PI_PROVIDER`/`PI_MODEL`, `PI_ALLOWED_MODELS`, `BUDGET_MAX_*`, `DAILY_TOKEN_LIMIT`, `SKILLS_*`,
`GIT_TOKEN_FILE`, `GIT_TOKEN_HOSTS`, `GITHUB_API`, …; see `packages/agent-kit/src/config.ts`). `GIT_TOKEN_FILE` here is a **read-only** token.

## Chat

The reviewer answers direct chat messages with the model (`CHAT_MODE=notice` goes back to the fixed notice). A **question** from the manager or a person
gets one bounded, read-only turn: tools `read, agent_status`, no commands, no changes, no approvals, an answer built from the service's own records
(`agent_status`) and, where it has one, a read-only checkout. An **instruction** (`instruct: ...`, from `agent/manager` only) becomes a `code.review` v3 task: optional lines `repo:`, `ref:`, `pr:`, `ticket:`, the rest is the focus. It stays read-only (the guard on commands applies), and the reply says the verdict and the findings by severity.
It runs as a job of the normal handler, with the role's own tools, guards and approvals, a chat budget of its own (150 000 tokens, 15 minutes by
default, `CHAT_INSTRUCT_TOKENS` and `CHAT_INSTRUCT_MINUTES`) and the `chat` share of the daily token limit (`CHAT_TOKEN_SHARE`); a step that needs
approval is asked of the manager in the conversation. Settings: `CHAT_MODE`, `CHAT_ALLOWED_SENDERS`, `CHAT_INSTRUCTORS`, `CHAT_REPOSITORY_URL`,
`CHAT_REPOSITORY_REF`, `CHAT_TOKEN_CAP`, `CHAT_TOKEN_SHARE`, `CHAT_INSTRUCT_TOKENS`, `CHAT_INSTRUCT_MINUTES` (all optional; the full table is in
`packages/agent-kit/README.md`).

## Files
| | |
|---|---|
| `card.json` · `src/profile.ts` · `src/main.ts` | the role contract: card, profile (read-only, `["read","bash"]`, budget required, review skills), entry point |
| `src/prompt.ts` | standing orders, the instruction from the job input, the repair instruction |
| `src/commands.ts` | the read-only command classifier and the approval patterns built from it |
| `src/result.ts` | extract, validate and cap the review; render the report |
| `src/context.ts` | read-only pull request context (REST + GraphQL), host-restricted |
| `src/review-runtime.ts` · `src/hooks.ts` | the repair turn and auto-denial; the kit hooks: PR context, instruction, task result and artifacts |
| `src/handler.ts` | builds a handler from the hooks without the service around it (used by the tests) |
| `Dockerfile` · `deploy/` | the image (agent only; the sandbox is the developer role's image), compose project, rollout and rollback |

## Tests
`npm test` in this directory (`test/*.test.ts`, Node's runner; the model is the kit's scripted model, the domain is a real one from the SDK's test harness):
command classification and the approval policy, extraction/validation/caps/report, pull request context against a stand-in code host, the profile
(read-only, tools, card consistency), and the service end to end: the card accepted by a real domain, a review returned and validated against the
card's output schema, the repair turn, `invalid_review_output`, a refused push and write (no ref on the remote, no file in the workspace, nobody
asked), an approval round trip, a missing budget, an unserved capability, the pull request context in a real run (and the token never in what the
model sees), and the skills allowlist.

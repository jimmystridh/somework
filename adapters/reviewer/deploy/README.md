# Deploying the reviewer on the agent Docker host

Two containers in their own compose project (`deploy/compose.yaml`, project `somework-reviewer`): `agent` (the harness, this role's image) and
`sandbox` (where the model's read-only tools run). Nothing is deployed by this repository: these are the steps, in order.

* **Own everything.** Own SomeWork identity (`agent/reviewer`), own model login, own sandbox volume and token, own state volume, own health
  port (`127.0.0.1:8082`). Nothing is shared with the developer role except the *image* of the sandbox daemon, which is role-agnostic (the
  read-only policy lives in the harness).
* **A narrow egress proxy.** The reviewer's bash is read-only inspection (see "What the model may run" in `../README.md`), but the kit runs
  `git clone` and `git fetch` through the sandbox, so the sandbox reaches the code host through an allow-listed proxy (default `github.com`
  and its content hosts, `EGRESS_ALLOW` in `.env` to change; private ranges are always refused). The model API is reached by the harness only.
* **No write token.** The only code-host credential is an optional read-only token (below). The role never pushes, never opens a pull
  request and never posts a comment.

Prerequisites: the domain with its TLS proxy and private CA (root `deploy/README.md`), Docker on the host, the developer role's sandbox
and egress images (`somework-pi-sandbox:<tag>` and `somework-pi-egress:<tag>`, built from `adapters/pi/Dockerfile`; or build them as in step 3).

## 1. Identity and card (on the domain host)
```bash
# on the agent host: generate the key there so it never travels; only the public key is registered
mkdir -p keys && chmod 700 keys && chown 10001:10001 keys
docker run --rm -u 10001:10001 -v $PWD/keys:/keys --entrypoint somework-sidecar somework-worker:<tag> keygen --id agent/reviewer --key-out /keys/agent.key.json

# on the domain host (`ops` as in the root deploy README)
ops admin --config /etc/somework/somework.toml enroll-agent --id agent/reviewer --public-key '<publicKey>' --side-effects read
cp card.json cards/reviewer.json                                  # adapters/reviewer/card.json, copied to the host's ./cards directory
ops admin --config /etc/somework/somework.toml register-card --card /cards/reviewer.json --approve
```
`--side-effects read` is all this agent needs: it provides one `read` capability and requests nothing. The card declares
`code.review` **version 3**. The card is an advertisement of what the agent offers; nobody needs a permission to ask it for a review: send it a message.
A published contract cannot change in place: a later change to the schemas needs `version 4`, with v3 kept in the same card until its callers have moved.

## 2. Files on the host (`./`, the compose directory)
| Path | What |
|---|---|
| `keys/agent.key.json` | the identity key (uid 10001, directory 0700) |
| `config/ca.pem` | the private CA |
| `secrets/sandbox-token` | random, mode 0440, group 10010: shared by agent and sandbox of THIS project |
| `secrets/pi/auth.json` | the model login (below), uid 10001; the directory must be writable because an OAuth refresh rewrites the file |
| `secrets/git-token` | optional read-only code-host token; the file must exist, create an empty one to run without |
| `skills-overlay/` | optional `<skill>.md` overlays (only read with `SKILLS_OVERLAY_DIR=/run/skills-overlay`) |
| `.env` | from `.env.example` |

**The model login is this role's own.** Do the device-code login for this agent separately and never copy another agent's `auth.json`: an OAuth
refresh token is rewritten on use, so two services holding the same one invalidate each other.
```bash
mkdir login && cd login                                   # a scratch directory: the login writes ./auth.json
node <repo>/node_modules/@earendil-works/pi-ai/dist/cli.js login openai-codex   # choose the device-code option, approve the code in a browser
sudo install -d -o 10001 -g 10001 -m 0700 ../secrets/pi
sudo install -o 10001 -g 10001 -m 0600 auth.json ../secrets/pi/auth.json
cd .. && rm -r login                                      # no copy stays on the workstation
```
**The code-host token** (optional) is fine-grained, limited to the repositories that will be reviewed, with *Contents: read* and
*Pull requests: read* only (checks and review threads come with those). It is used for two things: cloning private repositories and reading
the pull request context when a job names a `pullRequest`. Without it the role reviews public repositories and local refs, and ignores
`pullRequest`. The token is only ever sent to a host in `GIT_TOKEN_HOSTS` (default `github.com`), by the git credential helper and by the API
client, and it is scrubbed from logs, artifacts and results.

**Repository skills.** The profile exposes none by default; the deployment names the repository skills this role may use with `SKILLS_ALLOW=review-skill,style-skill` (for example
the repository's own review skills). If the repository under review has skills with those names (in `.agents/skills` or `.claude/skills`) they are offered to the model,
read from the checked-out ref; empty or unset means none. Overlays that adapt a skill for this agent go in `skills-overlay/<name>.md`
(see `packages/agent-kit/README.md`); company-specific skill text belongs in the repository or in that private directory, never in this repository.

## 3. Build and start
```bash
# from the repository root (the build context): the reviewer image
docker build -f adapters/reviewer/Dockerfile --target agent -t somework-reviewer:<tag> .
# and, if the host does not have it yet, the developer role's sandbox image
docker build -f adapters/pi/Dockerfile --target sandbox -t somework-pi-sandbox:<tag> .
docker build -f adapters/pi/Dockerfile --target egress -t somework-pi-egress:<tag> .

cd adapters/reviewer/deploy            # or wherever compose.yaml and .env live on the host
docker compose --profile init run --rm -T init-volumes </dev/null
docker compose up -d
docker compose ps && docker compose logs agent --tail 20      # expect service_started {"role":"reviewer", ...}
curl -s http://127.0.0.1:8082/ready
```
The reviewer image is built from the npm workspace's one lockfile with only its own, the agent kit's and the SDK's manifests; the build fails if
the service cannot import every module it runs. When building on the host, sync `package.json package-lock.json .npmrc sdk packages
adapters/reviewer` (without `node_modules`) to the build directory first.

## 4. Smoke test
Without credentials first: `PI_PROVIDER=faux` with a one-step plan whose final text ends in a `json` block (see `.env.example`), then ask the agent for a
review in a message from any principal of the domain (for example "review branch <branch> of <repository url>"); the agent starts a `review_code` job and the
result arrives as a message in the same conversation.
Then with the real model on a small branch: expect a completed job, a `verdict`, findings with file and line, and one `…-review.md` artifact. Check that
`git ls-remote` of the repository shows no new branch (nothing was pushed) and that a job whose model tries `git push` or a file write is
refused (the log shows `approval_requested` only for commands outside plain inspection).

## 5. Roll back
```bash
docker compose down                          # stops the reviewer; the domain keeps the agent enrolled but idle
ops admin --config /etc/somework/somework.toml set-agent-status --id agent/reviewer --status disabled   # the kill switch for the identity
```
Tasks that were running are re-queued when their lease lapses and fail or wait for another provider of `code.review@3`; nothing else depends
on this agent. To remove it for good, delete the `reviewer` state and workspace volumes and the `keys` directory.

## Limits
* The harness holds the credentials, so anything that could run there could read them: only audited code runs in the harness; repository code is
  only *read* in the sandbox (and anything that would run it, such as a build or a test, waits for the requester's approval).
* The read-only policy is a command classifier plus the model's tool list, not a kernel boundary: a `read` of any file in the sandbox works, and an
  approved command runs with the sandbox's own limits (non-root, read-only root, no capabilities, no network).
* `repository.ref` may be a branch, a tag, a commit SHA (name the full resolved SHA when handing work over) or `refs/pull/<n>/head`; the review is of exactly that commit, checked out detached, and the result reports it as `baseSha`.

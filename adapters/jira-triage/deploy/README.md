# Deploying the Jira triage agent on the agent Docker host

Two containers in their own compose project (`deploy/compose.yaml`, project `somework-jira-triage`): `agent` (the harness, this role's image) and `sandbox` (the developer role's sandbox image, on an internal network **alone**: no egress proxy, no route out). **Deployed on 2026-10-11 in dry-run mode** (steps 1 to 8 done by hand except Slack and the model login; the rules are in `rules/`). This file is the runbook; what the role does is in `../README.md`.

* **Own everything.** Own SomeWork identity (`agent/jira-triage`), own model login, own Jira personal access token (recommended: a new one for this agent, so that it can be revoked alone), own Slack app, own sandbox volume and token, own state volume, own health port (`127.0.0.1:8085`; 8081 developer, 8082 reviewer, 8083 Aikido fixer, 8084 Datadog triage on the same host).
* **It acts as the owner of the Jira token.** Every edit of the bot shows up in Jira as that person. That is why the loop protection is a marker label and why the bot never changes an assignee, a status or a reporter.
* **Start in a dry run.** `.env.example` sets `TRIAGE_DRY_RUN=1`: it judges and records, writes nothing to Jira, messages nobody and asks nobody. Look at the verdicts, tune, then set it to 0.

## Manual steps that remain, in order

1. **Enrol the principal** (on the domain host, `ops` as in the root `deploy/README.md`), with the key made on the agent host so that it never travels:
   ```bash
   mkdir -p keys && chmod 700 keys && chown 10001:10001 keys
   docker run --rm -u 10001:10001 -v $PWD/keys:/keys --entrypoint somework-sidecar somework-worker:<tag> keygen --id agent/jira-triage --key-out /keys/agent.key.json
   ops admin --config /etc/somework/somework.toml enroll-agent --id agent/jira-triage --public-key '<publicKey>' --publish 'agent.jira_triage.*'
   cp card.json cards/jira-triage.json        # adapters/jira-triage/card.json
   ops admin --config /etc/somework/somework.toml register-card --card /cards/jira-triage.json --approve
   ```
   *Actions.* An agent principal gets the domain's default agent permissions (`message.send`, `message.read`, `artifact.*`, `catalog.*`, ...), which is everything this role uses, plus `--publish 'agent.jira_triage.*'` for its job events (`events.publish:agent.jira_triage.*`; without it the log says `job_event_failed ... outside the caller's events.publish grants` and the dashboard shows no jobs). **A `may-invoke` grant on `agent/pi-agent` does not exist in this domain build** (ADR 0003 removed task capabilities and the `--may-invoke` and `--side-effects` options of `enroll-agent`; the older READMEs still show them): the read-only request to the developer agent is a plain message, and any agent may send one. `scripts/grant-job-events.ts --only agent/jira-triage` is the same grant for an agent that was enrolled without it.
2. **Reload the NATS broker's logins.** Right after enrolment: `docker kill -s HUP somework-domain-nats-1` on the domain host (the reloader does not load a new user by itself). Check `GET /v1/connection` as the agent first; without it the agent polls over HTTP only.
3. **The Jira webhook must send the three events.** The hub's `jira` mapping handles `jira:issue_created`, `jira:issue_updated` and `comment_created`; the QA role only needed transitions (updates). Check the webhook configured in Jira for those three events, for the triaged project(s) at least.
4. **Secrets and files on the host** (`~/somework-pilot/jira-triage`, uid 10001, secrets mode 0440/0600):
   | Path | What |
   |---|---|
   | `keys/agent.key.json` | the identity key (directory 0700) |
   | `config/ca.pem` | the private CA of the domain |
   | `secrets/sandbox-token` | random, mode 0440, group 10010: shared by agent and sandbox of THIS project |
   | `secrets/pi/auth.json` | **this role's own model login** (device-code login for this agent; never copy another agent's file: a refresh token that two services hold invalidates itself). Only the Slack conversations use the model |
   | `secrets/jira-token` | the personal access token. It needs: browse the project(s), edit issues (description, environment, labels), add comments, create issues |
   | `secrets/jira.pfx`, `secrets/jira-pfx-password` | the client certificate the Jira host demands, and its password (an empty file when it has none) |
   | `config/jira-ca.pem` | only when a private CA signed the host's certificate (`JIRA_CA_HOST=./config/jira-ca.pem`) |
   | `secrets/slack-bot-token`, `secrets/slack-app-token` | the Slack app's tokens (step 5) |
   | `.env` | from `.env.example` |
   Never paste a token into a chat or a repository: a secret that was ever there is burnt.
5. **Create the Slack app** from `slack-app-manifest.yaml` (this directory: the shared manifest plus `users:read` and `users:read.email`): api.slack.com/apps -> *Create New App* -> *From a manifest* -> YAML. Install it to the workspace (an admin may have to approve the two user scopes), copy the Bot User OAuth Token (`xoxb-...`), generate the app-level token (`xapp-...`, scope `connections:write`), find the member ids of the people the companion creates tickets for (*Copy member ID*) and set `SLACK_BOT_TOKEN_HOST`, `SLACK_APP_TOKEN_HOST` and `SLACK_ALLOWED_USER_IDS` in `.env`. The steps are those of `packages/agent-kit/README.md`, "Turning the Slack app on for one agent". **Reporters are not on that list**: they are written to and read by the triage itself (`../README.md`, "The reply path"). Without Slack the agent runs as well and asks in Jira comments.
6. **Open the health port.** Add `8085` to `HEALTH_PORTS` in `/etc/default/agent-health-firewall` on the agents VM and restart `agent-health-firewall.service` (Docker bypasses ufw; otherwise the whole private network can read it). Set `HEALTH_BIND=10.10.10.11` in `.env` if the dashboard and Alloy should reach it.
7. **Build and start** (from the repository root; or let the CI deploy do it, step 9):
   ```bash
   docker build -f adapters/jira-triage/Dockerfile --target agent -t somework-jira-triage:<tag> .
   # the developer role's sandbox image, if the host does not have it: docker build -f adapters/pi/Dockerfile --target sandbox -t somework-pi-sandbox:<tag> .
   cd ~/somework-pilot/jira-triage           # compose.yaml, .env, keys, secrets and config live here
   docker compose --profile init run --rm -T init-volumes </dev/null
   docker compose up -d
   docker compose logs agent --tail 30       # expect jira_handler_seeded, jira_triage_configured {dryRun: true, ...}, runtime_started, service_started {"role":"jira-triage"}
   curl -s http://127.0.0.1:8085/ready
   curl -s http://127.0.0.1:8085/status       # handlers: [{name: "jira", enabled: true, ...}]
   ```
8. **Apply the rules** (after step 1, because the pipeline refuses a rule whose owner does not exist): the rules now live in `rules/`; a push to `main` runs `somework-rules apply`. Until then no event reaches the agent (it still answers messages and conversations). Events flow as soon as the rules are applied: with `TRIAGE_DRY_RUN=1` they only produce verdicts. To keep a quiet window, apply the rules last, or pause one with the manager's `/pause jira-triage-created`.
9. **CI deploys it from then on.** `deploy/agents/deploy-from-ci.sh` builds `somework-jira-triage:ci-<sha>` and rolls the stack (`TRIAGE_VERSION,SANDBOX_VERSION`, health `http://10.10.10.11:8085/ready`) **only when `~/somework-pilot/jira-triage/compose.yaml` exists** on the host, so the file set can be added to the repository before the stack exists; the `.env` must hold `TRIAGE_VERSION` and `SANDBOX_VERSION`. Add `jira-triage` to the manager's `MANAGER_HOST_CONTROL` stacks list for `/suspend` (`scripts/fleet-suspend.sh` already has it).
10. **Observability.** Alloy: add `jira-triage=10.10.10.11:8085` to the `install-metrics.sh` targets (`deploy/observability/README.md`). The dashboard: add `{"id": "agent/jira-triage", "url": "http://10.10.10.11:8085/status", "logs": "{container=\"somework-jira-triage-agent-1\"}"}` to its `agents-health.json` (a file in the dashboard's secrets directory on the services VM; there is no example file in the repository), and the manager's `MANAGER_AGENT_HEALTH` list if it should show the agent in `/status`. After the agent is up the Operations console lists it and can send it a setup override (instructions for the Slack conversations).

## Smoke test

1. **Without credentials.** `PI_PROVIDER=faux` with `PI_FAUX_PLAN='["final:hello"]'`: a message to the agent gets an answer; `/profile` shows `slack.enabled` as configured.
2. **Dry run on a real ticket.** With `TRIAGE_DRY_RUN=1`, create a bare Bug in the triaged project (or ask the manager: `/ask jira-triage triage SAD-123`). Expect, in the log, `handler_decision` `submit`, `jira_triage_outcome` with `status: dry_run` and the missing items; in Jira nothing changed; no Slack message. Compare the verdict with what a person would say and note the false answers: they are the checklist heuristics to tune (`src/checklist.ts`).
3. **Live, one ticket.** `TRIAGE_DRY_RUN=0` (and restart). Create a bare Bug as a test reporter whose e-mail address is on Slack: expect `needs-info` and `triaged-by-bot`, a Slack DM with numbered questions from the bot, `jira_change_applied` log lines. Answer in the DM: within `TRIAGE_REPORTER_POLL_MINUTES` the ticket gets a "Triage notes" section, the environment field (when empty and named), the thanks, and loses `needs-info`. Then a reporter that Slack does not know: the same questions arrive as a Jira comment that mentions them; answer there.
4. **The developer agent.** A bare Bug with a technical gap: the log shows `jira_triage_developer_asked`; the developer agent's conversation with `agent/jira-triage` holds a "Read-only investigation request ..."; its answer (or the timeout after `TRIAGE_DEVELOPER_WAIT_MINUTES`) ends in `jira_triage_developer_done`. Check that the developer agent started **no job** and opened no pull request: it was asked not to, and nothing else enforces it (its own chat tools can start `code_agent`).
5. **The outage.** Block the Jira host from the container for a few minutes while a ticket is created: expect `jira_triage_pass_failed`, a `retry` outcome with the pause, and the ticket taken up again when Jira is back, with no second question.
6. **The companion.** In a DM with the bot: "make a ticket: the invoice total is wrong". It should search, ask for what is missing, and create the ticket with both labels and the line that names you.

## Operate

* Health: `127.0.0.1:8085/ready`, `/status` (handlers and token pools) and `/profile`. In a conversation (`!status` on Slack) the agent states its queue: waiting for a pass, for the developer agent, for a reporter, finished, given up.
* Pause the event path without stopping the agent: the manager's `/pause jira-triage-created` (and `-updated`, `-comment`), or `/kill agent/jira-triage jira` (the handler). Both fail open: events are recorded for a person.
* Change a project or a limit: edit `.env`, restart with `JIRA_RESEED_HANDLER=1` once (a new version of the handler is saved; the earlier ones stay in the state volume under `handlers/.versions/jira/`). The labels, languages and wait times are read at start.
* **Revert a change by hand.** Ask the agent in a conversation (`triage_changes SAD-123`), or read `changes.jsonl` in the state volume (`jira-triage/changes.jsonl`, one JSON line per state of a change, with the value before and after). Put the old value back in Jira; the next edit by a person is judged as any other.
* A ticket given up (`gave_up`, the manager was told): `triage_ticket SAD-123` starts it over once Jira is back. `docker compose exec agent` is not needed: the queue is `jira-triage/tickets.json` in the state volume (do not edit it while the agent runs).
* Rotate the Jira token: write the new one into `secrets/jira-token` and restart. The mutual-TLS certificate likewise.

## Roll back

```bash
docker compose down                      # stops the agent; events wait in its inbox, nothing is lost
ops admin --config /etc/somework/somework.toml set-agent-status --id agent/jira-triage --status disabled   # the kill switch for the identity
```
Remove the rules (`rules/jira-triage-*.yaml`; the pipeline's `apply` deletes them) so that no more events wake it. Labels, notes and comments it wrote stay: remove `triaged-by-bot` and `needs-info` with a JQL bulk edit if you want them gone (`labels = triaged-by-bot`). To remove it for good: delete the `state` and `workspace` volumes and the `keys` directory, revoke the Jira token and the Slack app.

## Limits

* The harness holds the credentials, so only audited code runs in the harness; nothing of the model's runs next to them, and the profile refuses every shell command and file write the model asks for.
* The agent acts as the owner of the Jira token: whoever reads the audit trail of a ticket sees that person, not the bot. The marker labels, the anchored comments and `changes.jsonl` are how the bot's edits are told apart.
* `conversations.history` and `users.lookupByEmail` need the scopes above; a workspace that hides e-mail addresses or has not approved `users:read.email` makes every question a Jira comment (the log says `jira_triage_slack_fallback` with the Slack error code).
* The developer agent's answer is read from the shared conversation by the id of the request; an answer from an older build that sets no `replyTo` is taken only when it names the ticket.

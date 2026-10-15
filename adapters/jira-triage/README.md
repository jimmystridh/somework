# Jira triage agent (`jira.triage` v1, `jira.ticket.create` v1)

By default (`TRIAGE_MODE=labels`) it waits ten minutes after a new ticket was created and then checks the ticket's area labels (Backend, Frontend, Infrastructure, Security) with the developer agent, correcting them and giving a ticket with no component the fitting one(s); that is the one thing it does to a ticket. In `TRIAGE_MODE=checklist` it checks every new Jira ticket of the triaged projects against a fixed checklist for its issue type, asks the reporter for what is missing, and helps people in Slack to create good tickets in the first place. Built on `@somework/agent-kit` like the other roles; **built and tested, not deployed**. The runbook, with the steps only a person can do, is `deploy/README.md`.

```
Jira webhook -> receiver -> hub (mappings/jira.jsonata) -> jira.issue.created | .updated | jira.comment.created
                                                              |  rules (deploy/rules/*.yaml: owner agent/jira-triage, wake)
                                                              v
                       the agent's event handler (handlers/jira.mjs, in the sandbox: project filter, dedupe, daily cap)
                                                              |  submit: one jira.triage job for itself
                                                              v
   job (hooks.ts: ends before any model call) --> TriageEngine (engine.ts): a state machine over a durable record per ticket
        fetch ticket (Jira REST, mTLS + PAT) -> checklist.ts -> complete? -> marker label
                                                    |
                    technical item missing -------> developer agent (read-only request, answer or timeout, folded into "Triage notes")
                                                    |
                    still missing ----------------> reporter: Slack DM (found by e-mail) | Jira comment   <-- answers read by the agent itself
                                                    |
                                                    v
                          answer -> notes + empty environment field -> judged again -> done | next round (at most 2) | no answer: ends, says what is open
```

**The mode.** `TRIAGE_MODE=labels` (the default) makes the label check below the **only** thing the agent does to a ticket: the checklist, the questions to the reporter and the comments about them are off (`TRIAGE_MODE=checklist` brings that triage back, everything under "The checklist" and "The triage, step by step" is that mode). Either way a new ticket first sits through the **quiet time**.

## The quiet time and the area labels (`TRIAGE_MODE=labels`)

* **Quiet time.** A new ticket is left alone for `TRIAGE_QUIET_MINUTES` (10) after its creation, so that the reporter can finish it. The time is fixed: **edits do not restart it**, and the handler drops every edit and comment, because a ticket is looked at **once** (so the bot never fights a person over a label). `0` looks at the ticket at once.
* **The question.** After the quiet time the engine asks the developer agent (`TRIAGE_DEVELOPER_AGENT`, `agent/pi-agent`) one read-only `chat.message` (`areaRequest` in `src/questions.ts`): which of `TRIAGE_AREA_LABELS` (`Backend,Frontend,Infrastructure,Security`, any combination or none) does the work touch? The agent may look in its checkout; it must answer with a line `AREAS: Backend, Security` (or `AREAS: none`) and a line `WHY: ...`. An answer without a line that names only known areas is not guessed at.
* **Components.** A ticket that has **no component** also gets one to three of the project's own (`GET /project/<key>/components`, offered by name and description in the same question; the answer adds a line `COMPONENTS: Name; Name`). Only exact names of the project count, anything else is dropped, and a ticket that has a component already keeps it and is not asked about it. If the list cannot be read or the answer names none, the labels are still done. `TRIAGE_COMPONENTS=0` turns it off.
* **The result.** The ticket's area labels (and component, if it had none) are made to match: missing ones are added, **wrong ones are taken away** (the only labels the bot removes besides its own), every other label stays. The marker label is set, and when something changed one comment says what and why (so a person can see it and undo it; every change is also in the journal with the values before and after). Labels that are right get the marker and nothing else.
* **When it cannot.** No answer within `TRIAGE_DEVELOPER_WAIT_MINUTES` or an answer that is not understood: nothing is written, the manager is told once, and `triage_ticket` (or asking the manager) starts it over. The developer agent not reachable at all is a retry like Jira being down.
* **Dry run** (`TRIAGE_DRY_RUN=1`) still asks the developer agent (a question writes nothing) and records what it **would** do in the log and the ticket's record; nothing is written to Jira.

A triage is **code, not a model run**. The model of this role only takes part in conversations (the Slack companion). That is deliberate: the verdict must come from the checklist, the questions are fixed texts, and a ticket flood costs no tokens.

## The checklist (`src/checklist.ts`, pure functions, hard-coded)

| Issue type | Items |
|---|---|
| Bug, Defect, Bugg, Fel | steps to reproduce; expected versus actual result; environment and version (the field, or a version or environment word); affected company or customer; a screenshot or attachment **when the ticket is about the user interface** |
| Story, Task, Sub-task, Improvement, New Feature (and their Swedish names) | why it is wanted (the goal); acceptance criteria |
| anything else (Epic, Support, ...) | a summary that says what it is about; a description |

The detection is text heuristics in English and Swedish (a numbered list, a "steps to reproduce" heading with content, a sentence of actions; an expected cue and an actual cue; a version number or an environment word; "customer", "kund", "bolag", an organisation number; ...). It is advice with a polite question behind it, not a gate: a false "missing" costs the reporter one question, a false "ok" costs nothing. The fixtures in `test/fixtures.ts` are invented tickets; **tune the heuristics on the first real tickets** (`TRIAGE_DRY_RUN=1` shows the verdicts without asking anyone). The model may help phrase a question in a conversation, but what is missing is decided here, and the operator's instructions from Operations (ADR 0004) cannot change it: they are appended to the standing orders, the checklist is code.

## The triage, step by step (`src/engine.ts`)

One durable record per ticket (`<state>/jira-triage/tickets.json`) with a phase: `queued`, `awaiting_developer`, `awaiting_reporter`, `done`, `gave_up`.

1. **A new ticket.** The handler starts a `jira.triage` job; the job calls the engine, which fetches the ticket itself (the event carries only the key, 200 characters of summary, type, project and actor). A ticket that already carries the marker label is left alone.
2. **Complete:** the marker label `triaged-by-bot` is set. Nothing else: no comment, nobody is asked.
3. **A technical item is missing** (steps, environment) and enrichment is on: a read-only request goes to `agent/pi-agent` (below) and the triage waits `TRIAGE_DEVELOPER_WAIT_MINUTES` (10). The answer is folded into the ticket's own marked section; an explicit `FINDING reproduction-steps: ...` line closes that item. Then the reporter is asked for **whatever is still missing**.
4. **Asking the reporter.** On Slack: the reporter's e-mail address comes from the Jira user API (the hub strips addresses from events), `users.lookupByEmail` finds the person, `conversations.open` gives the DM, the numbered questions go out. If Slack does not know the person, has no scope, or the post fails, the same questions are written as a Jira comment that mentions the reporter. The labels `triaged-by-bot` and `needs-info` are set. A reporter who is gone or inactive cannot be asked: a plain comment says what is missing and the triage ends.
5. **The answer** (Slack or a Jira comment by the reporter) goes into the notes, an empty `environment` field is filled from a line of it that names the environment, and the ticket is judged again with the answer counted as part of it. Complete: thanks (Slack and a comment), `needs-info` removed. Still incomplete: a second round (`TRIAGE_MAX_ROUNDS`, 2), then the triage ends with a comment that lists what is open. No answer within `TRIAGE_REPORTER_WAIT_HOURS` (48): the triage ends the same way.
6. **Later edits.** A person who changes the type, summary, description, environment or attachments of a ticket the agent triaged makes it worth judging again; the agent compares the ticket with a **fingerprint** of what it last saw (including what it wrote itself) and acts only on a real difference.

### Loop protection

Every edit of the bot appears in Jira as the owner of the token, so the actor of an event says nothing. Three things keep the bot from triaging its own work:

* the marker label: a ticket that carries it is not triaged when it is created or seen again; the tickets the Slack companion creates get it (and `created-by-bot`) from the start;
* the fingerprint: it covers type, summary, description **without the bot's marked section**, environment and attachment ids, and is updated before the bot writes. The bot's labels, comments and notes never change it; a person's label edit never counts (events whose only changed fields are labels, comments or other fields the checklist does not read are dropped by the handler without reading the ticket);
* every comment of the bot starts with an anchor (`{anchor:tb-...}`, invisible in Jira): the hub's 500-character excerpt shows it, so the handler drops the bot's own comment events, and the engine never counts a comment with the anchor or an id it posted as an answer, even when the reporter is the token's owner.

### Jira being down (retries)

A failed pass is not lost: the record exists before the first Jira call, a failed pass sets `nextAttemptAt` with a growing pause (`TRIAGE_RETRY_MINUTES`, default `2,5,15,30,60,120,240,480`, the last repeats, +-10%), and the agent's clock (`TRIAGE_TICK_SECONDS`, 15) takes the ticket up again. The Jira client itself retries reads and idempotent writes four times first. After `TRIAGE_MAX_ATTEMPTS` (12) failed first passes the ticket is `gave_up` and the manager is told once; asking for it again (`triage_ticket`) starts it over. What the bot decided to write sits in the record (the *outbox*) until it is done, and every item is safe to repeat: a label is a difference against the ticket as it is now, a note carries its own anchor, a comment its own token (a comment is looked for before it is written again, because a POST that was lost after it was sent may have been applied). A question that was sent is never sent twice when a later write fails (a crash exactly between the Slack post and saving the record can still send one question twice).

## What the bot may write, and never

The owner's choice is the broad option: the bot may fill empty fields and overwrite the fields the checklist concerns (**description, labels, components, priority, environment**) and add comments. In practice today it writes: the description (only inside its marked "Triage notes" section, never the reporter's own text), the labels `triaged-by-bot`, `needs-info` (only the ones it added are taken away), the `environment` field when it is empty and an answer names it, and comments. Components and priority are inside the authority and supported by the tested helper but nothing decides to change them.

**It never changes an assignee, a status/transition or a reporter**, although the owner did not exclude them. Three locks: `changes.ts` refuses the field before anything is recorded or sent (`assertWritable`); `jira/client.ts` has no method for them and refuses a payload that names one; the tests assert that no flow touches them and that no tool of the conversations has such a name. The guardrail is stated in the card.

**Every change is recorded first** (`changes.ts`, `ChangeJournal`): `<state>/jira-triage/changes.jsonl`, append-only, one line per state (`planned` before the call, then `applied` or `failed`) with the ticket, field, reason, **the value before and after**. When a record cannot be written, nothing is written to Jira. The log line has sizes and a hash, never the values. To revert by hand: `triage_changes SAD-123` in a conversation shows the entries (or read the file), and `revertOf(record)` is the same field with the two values swapped. A dry run (`TRIAGE_DRY_RUN=1`) writes nothing and asks nobody.

**Triage notes.** The developer agent's findings and the reporter's answers go into one section at the end of the description, between two invisible anchors, with an invisible anchor per entry (so the same entry is never added twice), the text escaped so that it cannot open a macro, a link or a mention, at most 6000 characters (the oldest entries go first). The section is not part of what a triage judges.

## The developer agent (read-only enrichment)

When a technical item is missing, `developer.ts` sends **one plain `chat.message`** (trigger mode `directed`, label `jiraTriage=<ticket>`) to `agent/pi-agent`: no capability, no repository, no artifact. The text says first that it is a request to *look and answer in text*: no job (not `code_agent`), nothing changed, committed, pushed or opened, no write to Jira. The ticket is inside random markers as data. This role asks for no write; the developer agent decides for itself, as every agent does (ADR 0003), so the guarantee is the wording and that this agent never sends anything else. The answer is found in the conversation by the id of the request (`replyTo`/`causationId`: the conversation with the developer is shared by every ticket), with a fallback for an answer that names the ticket and came after the request. The developer agent's reply also wakes this agent's own model; the standing orders say to answer `NO_REPLY` (one cheap run per answer).

## Slack

* **Reporters.** The same bot token (`SLACK_BOT_TOKEN_FILE`) writes the direct messages: scopes `users:read.email` and `users:read` (find the person by e-mail, a display name), `im:write`, `chat:write`, `im:history`. `deploy/slack-app-manifest.yaml` is the shared manifest plus the two user scopes; the shared one is unchanged, so other roles are unaffected. The agent asks on Slack only when the kit's Slack channel is on (both tokens and an allow-list); otherwise every question is a Jira comment.
* **The reply path, and why it is not the kit's allow-list.** The kit's Slack channel answers only `SLACK_ALLOWED_USER_IDS` and ignores everyone else, and that must not change. A reporter is not on that list. The agent therefore **reads the reply itself**: for a ticket it asked about, every poll (`TRIAGE_REPORTER_POLL_MINUTES`, 5) it calls `conversations.history` of **that DM only**, since its own question, and takes the messages written by **that one person**. What the reporter wrote is handled by code, never by a model: it goes into the notes and into the checklist, so nobody outside the allow-list can instruct the agent, call a tool or start a job. A reporter who is also on the allow-list is served by the kit as before (a conversation with the model) *and* read by the triage; the Jira comment path is always open as well. The cost is up to five minutes of delay, and no change in the kit.
* **The companion** (allow-listed people, a DM or a mention in an allowed channel): the tools `ticket_search`, `ticket_check`, `ticket_create`, `triage_changes` and the job tool `triage_ticket`. It searches for similar tickets first and says when one is clearly the same; drafts from the conversation (nothing invented); `ticket_check` runs the draft through **the same checklist** and returns the questions to ask; when the check passes (or the person says to create it as it is: `createAnyway`) `ticket_create` creates the ticket **at once**, with no confirmation step, in a triaged project (the first is the default) as an allowed type (`TRIAGE_CREATE_TYPES`). The ticket gets `triaged-by-bot` and `created-by-bot`, and the description ends with a line naming who asked (member id and display name) and what was still lacking. A ticket created a moment ago with the same summary is returned instead of a second one. A screenshot cannot be asked for in Slack (the kit reads text only), so it is advice, and the ticket says it is still wanted. `requestedBy` is given by the model from the sender line of the message and checked against `SLACK_ALLOWED_USER_IDS`; it is attribution, not authority.
* The conversation's **standing orders** are `CHAT_INSTRUCTIONS` in `src/prompt.ts`; the kit appends the operator's addendum from Operations to new conversations. The projects, the labels, the checklist and the write authority are not settable from there.

## Events, rules and the handler

Three rules, one per selector (the rule model takes one): `jira.issue.created`, `jira.issue.updated`, `jira.comment.created`, owner `agent/jira-triage`, always `wake`. They sit in `deploy/rules/` **held**, not in `rules/`: the rules pipeline refuses a rule whose owner does not exist yet (the Datadog rule was held for the same reason, commit e7caf56), so they move into `rules/` after the agent is enrolled. Recorded samples of the three topics are in `rules/samples/`.

The handler (`handlers/jira.mjs`, seeded on the first start, versioned, runs in the sandbox with no credentials): ignores other projects (`JIRA_PROJECTS`), handles a delivery once, starts a triage for a created ticket, **and for an update or a comment only on a ticket it saw created** in the last 30 days, only when a field the checklist reads changed, never for the bot's own comments, and stops at `TRIAGE_DAILY_CAP` jobs a day. Event text is data: only the key, the event key, field names (cut) and a comment's author and id reach the job.

A job ends before the model runs (`beforeWorkspace` returns `blocked`, the `result` hook reports the real outcome in `{status, ticket, summary, via?, missing?}`), so the kit's `somework_pi_jobs_total` counts these jobs as `blocked`; the result and the journal say what happened. Each job still sends the manager one notice when it ends (`EVENTS_NOTIFY_TO`, one per ticket the handler started a job for): useful in the pilot, noisy at volume. Set `EVENTS_NOTIFY_TO` to another principal to move them.

## Settings

| Environment | Default | |
|---|---|---|
| `JIRA_URL`, `JIRA_TOKEN_FILE`, `JIRA_PFX_FILE`, `JIRA_PFX_PASSWORD_FILE`, `JIRA_CA_FILE` | | the ticket system, the same names as the QA role: the personal access token (acts as its owner) and the client certificate the host demands; files only; an empty file (`/dev/null`) is no file |
| `JIRA_PROJECTS` | `SAD` | project keys triaged and created in; events of other projects are ignored |
| `JIRA_TRIAGE_LABEL`, `JIRA_NEEDS_INFO_LABEL`, `JIRA_BOT_CREATED_LABEL` | `triaged-by-bot`, `needs-info`, `created-by-bot` | |
| `JIRA_BOT_USER` | empty | the user name of the token's owner **when it is a service account**: the handler drops updates made by it (the bot's own echo, which would otherwise start a job that finds nothing changed). Leave it empty for a person's token: that person's own edits must still count |
| `TRIAGE_MODE`, `TRIAGE_QUIET_MINUTES`, `TRIAGE_AREA_LABELS`, `TRIAGE_COMPONENTS` | `labels`, `10`, `Backend,Frontend,Infrastructure,Security`, `1` | see "The quiet time and the area labels" |
| `TRIAGE_DRY_RUN` | `0` | `1`: judge and record only |
| `TRIAGE_LANGUAGE` | `en` | `en` or `sv`: the language of the questions to reporters |
| `TRIAGE_ENRICH`, `TRIAGE_DEVELOPER_AGENT`, `TRIAGE_DEVELOPER_WAIT_MINUTES`, `TRIAGE_DEVELOPER_POLL_SECONDS` | `1`, `agent/pi-agent`, `10`, `20` | the read-only look |
| `TRIAGE_REPORTER_WAIT_HOURS`, `TRIAGE_REPORTER_POLL_MINUTES`, `TRIAGE_MAX_ROUNDS` | `48`, `5`, `2` | |
| `TRIAGE_RETRY_MINUTES`, `TRIAGE_MAX_ATTEMPTS`, `TRIAGE_TICK_SECONDS` | `2,5,15,30,60,120,240,480`, `12`, `15` | |
| `TRIAGE_CREATE_TYPES`, `TRIAGE_DAILY_CAP` | `Bug,Story,Task,Improvement`, `200` | |
| `JIRA_RESEED_HANDLER` | `0` | `1`: save the shipped handler again, with these settings, as a new version |
| `EVENTS_NOTIFY_TO`, `SLACK_ALLOWED_USER_IDS`, ... | | the kit's own (`packages/agent-kit/README.md`) |

## Layout and tests

`card.json`, `src/` (`checklist` `wiki` `snapshot` `changes` `questions` `store` `engine` `create` `chat` `hooks` `seed` `settings` `profile` `prompt` `worker` `slack` `developer` `jira/client`), `handlers/jira.mjs`, `deploy/`. Tests (`npm test -w @somework/jira-triage`): the checklist on fixtures in two languages, the notes section, the fingerprint, the change journal and the guardrail, the questions, the store, the Jira client against an HTTPS fake that demands a client certificate and a token (`test/fake-jira.ts`, copied from the QA role's helper and extended: roles never import each other, and sharing it would have meant moving QA's client into the kit), the engine over an in-memory ticket system with an outage switch (every branch above), the handler as the sandbox runs it, the job through the kit's real `createHandler`, the conversation tools, the deployment files, and an end-to-end test with the real service process, a real domain, a real sandbox daemon and the mutual-TLS Jira fake (including the developer agent's answer over the domain). The Slack API is tested against a fake `fetch`, never against slack.com.

## Limits and open decisions

* The heuristics are tuned on invented fixtures; run the dry run on real tickets first.
* The Slack API, the real Jira and the developer agent's real behaviour were never run live (the Slack calls are tested against a fake `fetch`, Jira against an HTTPS fake that demands a client certificate and a token).
* The handler's watch window (30 days) means an old ticket that a person edits is left alone; so is a ticket created while the agent was down and never seen (a manual `triage_ticket` covers it).
* One manager notice per triage job that the handler starts (see above).
* At most one duplicate question after a crash between the Slack post and saving the record.
* The Jira client and its fake are copies of the QA role's, extended (roles never import each other); moving the client into the kit would remove the duplication but touches QA.
* A reporter that Slack does not know, or a workspace that has not approved the user scopes, makes every question a Jira comment (logged as `jira_triage_slack_fallback`).

<!-- base-sha256: 7b9e2f690c7badfb4f85084ebb8c5e062e46f8ad3c92e6384f88f8f293b6ab88 -->
# Differences for this agent (SomeWork QA on a Windows machine, local mode)

You run ONE ticket per task, given in your brief with the repository and the revision. Everything below overrides the skill where they differ; everything else in the skill stays, including every hard rule.

## What does not apply
- Batch Loop, Jira Selection (JQL queries, the run ledger, refreshing the query), Company Coverage across tenants, and Output per ticket. The ticket key was already checked against `^SAD-[0-9]+$` by the harness; an unlisted key never reaches you.
- Repository Setup steps 3 to 8 and the worktree/port-range handling: the revision is already checked out in your working directory at the resolved commit (`git rev-parse HEAD` gives the SHA), and the application is already running from it in **local mode** (no identity provider, local back end on this machine) at the addresses in your brief. Do not run `bun install`, do not start or stop a dev server, do not select a port, do not touch other checkouts.
- Playwriter, `recording.start/stop`, `createDemoVideo`, ffmpeg/ffprobe and the Jira MCP. They do not exist here.

## What replaces them
- Browser: the `qa-browser` command named in your brief (open, snapshot, click, fill, press, wait, screenshot, errors, video-start, video-stop). Observe -> act -> observe still applies; refs stay valid until the page changes, so snapshot again after navigation. It can only reach the application's own addresses.
- Video: `video-start` / `video-stop` produce the final `.webm` in `videos/` of the evidence folder (about 10 s target: prepare the starting state first, record only the decisive path, reload inside the recording when persistence is the point). No transcoding step. A screenshot is not a video. Without a recorded video the result is not `verified`, and the harness downgrades it to `blocked`.
- Ticket system: only the `jira_*` tools. Read tools run freely. Writes (`jira_attach`, `jira_comment`, `jira_add_label`, `jira_remove_label`, `jira_transition_to_in_progress_and_reassign`) may wait for the requester's approval (the hand-back always does) and can be refused; accept a refusal and do not look for another way. Each write re-reads the ticket first and refuses when it is no longer in Test and unassigned. Call `qa_record_verdict` before the first write.
  - Verified: `jira_attach` the video, `jira_comment`, then `jira_add_label` with `AgentTested`, in that order. The ticket stays in Test, unassigned.
  - Not fixed: one call to `jira_transition_to_in_progress_and_reassign` with the full comment (it comments, removes a stale `AgentTested`, moves the ticket to In Progress and gives it back to the previous assignee; without a findable previous assignee it only comments).
  - Blocked: `jira_comment` only.
  - Nothing moves a ticket to Done, and you must not try.

## Data and companies
- This machine's company list holds 238 names, but only these 29 are set up and open; every other company fails with "Fel vid företagsbyte" (company switch failed). That is this environment, not a finding about the ticket, so never report it as the result. Search the name in "Välj företag".
  - Prefer the one that matches the ticket's area: InkopLeverantorerDel1, InkopInkommandeFoljesedlar, InkopBestallningarDel1, InkopBestallningarDel2, UtskrifterAllaUtskrifterDel1, UtskrifterAllaUtskrifterDel2, ArtiklarLagerManuellaInOchUtLeveranserDel1, ArtiklarLagerManuellaInOchUtLeveranserDel2, BokforingProjekt, BokforingIngaendeBalans, BokforingBalansbudget, BokforingResultatprognos, BokforingVerifikationVerifikationsregistreringDel1, BokforingVerifikationVerifikationsregistreringDel2, ForsaljningKundfakturor, ForsaljningOffert, ForsaljningOrder, ForsaljningKundRabatter, ForsaljningAvtalDel1, OvrigtAutoGiro, OvrigtOffertOrderKundfaktura, OvrigtPaketartiklar, Order.
  - Without a better match use **SmokeTestSteg1** (a general practice company; SmokeTestSteg2 to SmokeTestSteg5 are the same kind).
- Local mode connects to practice companies only. Build the fixture there, through the application, with the issue marker in a free-text field; never use or alter data of a real customer company, and never go looking for one.
- The staging contract and the fixture assertions stay, but report them in the final JSON (`fixtures`, `acceptanceChecks`) and in the ticket comment rather than in a ledger.

## What to report
- In the ticket comment name the **front-end revision** (the full commit SHA of your checkout) and the **back-end revision** when your brief or the application tells it, plus the video's file name, the fixtures with their keys, and the acceptance checks you ran.
- Finish with the single fenced JSON report described in your standing orders.

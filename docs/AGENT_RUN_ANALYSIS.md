# Agent run analysis (2026-10-05 to 2026-10-06)

> Historical (2026-10-05/06): the tasks, claim loop and reactions this document talks about were replaced by messages, events and background jobs on 2026-10-10 (`docs/adr/0003-messages-and-events-replace-tasks.md`).

Scope: every run of the QA, Aikido fixer, developer, reviewer and Windows developer agents since the event hub went live, plus the rules, the hub, CI and the hypervisor jobs those runs depend on. Evidence comes from the domain's task and rule counters, Loki, the hub and receiver stats, Woodpecker runs and the backup logs. Host names and credentials are left out on purpose.

Legend: severity P1 (broken or unsafe), P2 (wrong or wasteful), P3 (hygiene). "Repo" means fixable by a change in this repository; "config" means a deployment or owner action.

## Findings

| # | Sev | Area | Finding | Root cause | Fix | Where |
|---|---|---|---|---|---|---|
| 1 | P1 | QA | Every `qa-on-ticket` firing failed before the agent started. | The rule input has no `app` (the profile name `qa.verify` requires), and the hub's Jira default ref was `refs/heads/main` while the repository's default branch is not `main`. The QA git token was also missing at the time (installed since). | Add `app: local` to the rule input; make the hub example config use `HEAD`; keep the token. | repo + config |
| 2 | P1 | Fixer | The fixer concluded `no_fix` for `ws` although the vulnerable version was in `bun.lock`. | The event carries only an issue id and a title. The fixer lacked `affected_file`, `installed_version` and `patched_versions`, so it searched the wrong lockfile. | The handler passes the group's `issues[]` detail (file, installed and patched versions) into the task input and the prompt. | repo |
| 3 | P1 | Hypervisor | The web UI port was open to everyone for about 15 minutes after a misread instruction. One unauthenticated `GET /` returned 200 from an unknown source in that window. | Human error, no guard in the firewall script. | Already restored. Proposed: the host firewall script (kept on the hypervisor, not in this repository) refuses a rule set that opens a management port to everyone unless a flag says so. | config |
| 4 | P2 | Aikido mapping | `type` is treated as the change, and the key is issue id plus type, so one issue produces many events and a different `type` string creates a new key. | The first-cut mapping was written before a real payload existed. | Key on the issue id and a normalised change; map unknown types to `aikido.issue.updated`; keep `type` as data. | repo |
| 5 | P2 | Fixer handler | The daily cap counted tasks that were skipped, and attempts were keyed on raw issue ids. | Counting happened before the decision; ids from the group and the issue differ. | Count only started tasks; key attempts on the normalised issue id. | repo |
| 6 | P2 | CI | Pushes to `main` that touch code run no checks; `check.yaml` only runs on pull requests and `deploy.yaml` only for `rules/` paths. | Pipelines were designed around the rules deployment. | Run `check.yaml` on push to `main` as well. | repo |
| 7 | P2 | Chat | Developer chat averaged about 100 s per answer against 7 to 13 s for the others, and two sender rate limits were hit silently. INSTRUCT messages failed on artifacts (404, no task for the chat job). | The developer starts its full runtime for each answer; the rate limit gave no reply. | Chat defect fixes are in the repository but not deployed. Deploy them. | repo (deploy pending) |
| 8 | P2 | Token burn | A real "token burn" alert fired at 09:49 UTC. | Not verified. The timing is close to the fixer retries during the PR test, when limits were temporarily raised. | Limits are back at the defaults; count only started tasks (finding 5). | repo |
| 9 | P3 | Dashboard | `/handlers` returns 500 when an agent is unreachable. Windows and QA `/status` are not reachable by the fleet dashboard. | The aggregation does not tolerate a failing agent. | Return per-agent errors; add the QA agent to the dashboard config. | repo + config |
| 10 | P3 | Hypervisor | VMs 101 and 102 have no QEMU guest agent. The VM 103 backup (04:00 UTC, 41 minutes) overlaps domain slow statements. | Image setup; backup schedule. | Install the agent; move the VM 103 job away from the domain's busy window. | config |
| 11 | P3 | Test data | Acceptance data remains: 172 events, 163 failed tasks, `producer/aikido-dryrun`. | Not cleaned after acceptance. | Remove or ignore in dashboards. | config |

## Status of the fixes

| # | State |
|---|---|
| 1 | Fixed in the repository: `app: local` in `rules/qa-on-ticket.yaml`, `HEAD` in the hub example config and README. Live: the hub config already uses `HEAD`; the rule needs the next CI apply. |
| 2 | Fixed in the repository: the client reads the group's open issues (`/issues/export` filtered by group) and the prompt lists every file, package and version. Needs a fixer deployment. |
| 3 | Open: host firewall guard (hypervisor, owner action). |
| 4 | Fixed in the repository: an issue kind such as `open_source` in `type` is no longer a change; an id without a change keys on the payload hash. Needs a hub deployment. |
| 5 | Fixed in the repository: the handler's own daily count is a flood guard at five times the cap; the host ledger stays authoritative and counts only started attempts. Needs `AIKIDO_RESEED_HANDLER=1`. |
| 6 | Fixed in the repository: `check.yaml` also runs on pushes to `main`. |
| 7 | Chat fixes are in the repository since the previous round; deployment pending. |
| 8 | No code change; limits are back at the defaults. |
| 9 | Fixed in the repository: the manager answers 502 naming the unreachable service. Dashboard config for QA and Windows is open. |
| 10, 11 | Open (configuration). |

## What went well

- The fixer opened a real, non-draft PR (#5229) with a correct change after the kit fixes (empty `GITHUB_API`, non-fast-forward retry).
- Reviewer, fixer, QA and Windows developer all answered chat; fixer, QA and Windows developer within about 7 to 9 s.
- No secrets were found in logs, events or artifacts in the scan.
- Grafana alerts reach the hub and the manager (11 fired, 9 resolved).

## Summary (machine readable)

```json
{
  "p1": [1, 2, 3],
  "p2": [4, 5, 6, 7, 8],
  "p3": [9, 10, 11],
  "repoFixable": [1, 2, 4, 5, 6, 7, 8, 9],
  "needsConfigOrOwner": [1, 3, 9, 10, 11]
}
```

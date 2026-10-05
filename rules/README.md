# Rules

One file per rule: `rules/<name>.yaml`. A rule is a subscription to events, optionally with a reaction that submits a task. The files are the only way rules are created; the domain refuses nothing else but nothing else is deployed. How they reach the domain is in `docs/RULES.md`, the design is in `docs/EVENTS.md`.

```yaml
name: pr-review-opened              # must equal the file name
description: Review every pull request that is opened ready for review.
owner: automation/pr-review         # reaction -> an automation principal; agent subscription -> the agent
selector: github.pull_request.opened    # glob over the topic; * matches any run of characters, dots included
where:                              # all must hold; typed equality against JSON pointers into the event payload
  - path: /data/draft
    equals: false
wake: false                         # always stated: does a match wake the owner?
reaction:                           # leave out for an agent subscription (then wake: true)
  capability: { id: code.review, version: 3 }
  input:                            # the task input, with ${/pointer} references into the event payload
    repository:
      url: ${/data/repository/cloneUrl}
      ref: refs/pull/${/data/number}/head
    pullRequest: ${/data/number}
    budget: { maxTokens: 200000, maxMinutes: 20 }
  budget: { maxTokens: 200000, maxMinutes: 20 }   # the cap of the reaction; input.budget may not exceed it
  maxDepth: 3                       # default 3, at most 5 here
  maxFiringsPerHour: 20             # default 30, at most 120 here
# status: paused                    # leave out unless you mean it, see below
```

## The event payload

`${/pointer}` and `where.path` read the event as the domain stores it:

| Pointer root | Content |
|---|---|
| `/data/...` | the fields the producer's mapping chose to carry |
| `/topic`, `/source`, `/key` | topic, producer source, stable event key |
| `/classification`, `/verified` | classification level; whether the receiver verified the sender |
| `/depth`, `/causedByTask`, `/publishedBy` | loop depth, the task that caused the event (if any), the producer principal |

A string that is exactly `${/pointer}` becomes the typed value (a number stays a number, a list a list). A reference inside a longer string becomes text. A pointer that finds nothing fails that firing; nothing is submitted with a hole in it. There is no escape for a literal `${`.

## Safety

* **Event text is untrusted data.** Titles, descriptions, comments and alert texts are written by people outside the platform. Put them into task input only where the capability treats that field as data (never as an instruction), and prefer identifiers (numbers, keys, URLs) over prose. Every field a mapping does not list is dropped before it reaches an event; list prose fields only when a rule needs them.
* A rule with a reaction fires on every matching event, up to `maxFiringsPerHour`. Narrow it with `where`; a wildcard selector without `where` is a warning.
* A reaction runs under its automation principal with that principal's allow-list of capabilities. A write-class capability (for example `qa.verify`) waits for approval at every firing.
* `status`: the domain owns whether a rule is currently paused (pause and kill are runtime controls). Leave `status` out and `apply` keeps whatever the domain has, even when it replaces the rule. `status: paused` creates or keeps it paused; `status: active` resumes it at **every** apply, which silently undoes a pause made in an emergency, so validation warns about it.
* One selector per rule. "Opened or ready for review" is two rules.

## Checking a rule

```
node packages/rules-cli/src/main.ts validate --card adapters      # schema, contract, conventions, rendered inputs
node packages/rules-cli/src/main.ts plan --card adapters          # what apply would change (needs SOMEWORK_URL and a key)
```

`--card adapters` renders every reaction's `input` against the recorded sample events in `rules/samples/` (one file per topic, the full event payload) and validates the result against the capability's `inputSchema` on its card. A reaction without a sample for its selector is an error: record one (copy a real payload through the producer's mapping) so the input can be checked.

# Rules

One file per rule: `rules/<name>.yaml`. A rule is a subscription: events that match wake the agent that owns it, and the agent's own event handler decides what to do with each one (drop it, tell the owner, ask someone, or start a job). A rule never starts work by itself. The files are the only way rules are created; the domain refuses nothing else but nothing else is deployed. How they reach the domain is in `docs/RULES.md`, the design is in `docs/EVENTS.md` and `docs/adr/0003-messages-and-events-replace-tasks.md`.

```yaml
name: aikido-fixer                  # must equal the file name
description: Every Aikido event wakes the Aikido fixer, whose own handler decides what is worth a fix.
owner: agent/aikido-fixer           # the agent that is woken
selector: aikido.*                  # glob over the topic; * matches any run of characters, dots included
where:                              # optional: all must hold; typed equality against JSON pointers into the event payload
  - path: /data/draft
    equals: false
wake: true                          # always stated, always true
# status: paused                    # leave out unless you mean it, see below
```

## The event payload

`where.path` reads the event as the domain stores it:

| Pointer root | Content |
|---|---|
| `/data/...` | the fields the producer's mapping chose to carry |
| `/topic`, `/source`, `/key` | topic, producer source, stable event key |
| `/classification`, `/verified` | classification level; whether the receiver verified the sender |
| `/depth`, `/publishedBy` | hop depth, the producer principal |

## Safety

* **Event text is untrusted data.** Titles, descriptions, comments and alert texts are written by people outside the platform. The agent's handler treats them as data, never as instructions; every field a producer's mapping does not list is dropped before it reaches an event.
* A wildcard selector without `where` is normal for a subscription: the agent's handler filters. Narrow it with `where` when the agent should not be woken (and billed) for events it will always drop.
* `status`: the domain owns whether a rule is currently paused (pause and kill are runtime controls). Leave `status` out and `apply` keeps whatever the domain has, even when it replaces the rule. `status: paused` creates or keeps it paused; `status: active` resumes it at **every** apply, which silently undoes a pause made in an emergency, so validation warns about it.
* One selector per rule. The agent's handler can tell event types apart, so a wildcard rule is often simpler than several.

## Checking a rule

```
node packages/rules-cli/src/main.ts validate      # schema, contract, conventions, where paths against the recorded samples
node packages/rules-cli/src/main.ts plan          # what apply would change (needs SOMEWORK_URL and a key)
```

`validate` checks every `where` path against the recorded sample events in `rules/samples/` (one file per topic, the full event payload): a path that resolves in none of the samples for the rule's selector is a warning, because the filter probably never holds. Record a sample (copy a real payload through the producer's mapping) when you add a rule with a `where`.

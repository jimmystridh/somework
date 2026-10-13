# The hub holds watches on pull requests; rules still create every subscription

Status: accepted (2026-10-13)

An agent that opened or reviewed a pull request wants to hear about that one pull request ("events on PR #1234"), not about every pull request of the repository. A **watch** is a standing request kept by the event hub: the agent asks for one repository and number, and the hub re-publishes the matching GitHub events (new actions, reviews, comments, check runs) under one topic of that agent, `github.watch.<agent>.event`. The agent's one git rule subscribes it to that topic, exactly as the timer rule does for `clock.timer.<agent>.due`. A watch narrows what an existing, reviewed subscription delivers; it never creates a subscription. That keeps ADR 0001's line (runtime control is pause and kill, creation only through git) intact while letting the agent choose *which pull request* at runtime.

## Considered options

- **A watch is a domain subscription the agent creates at runtime.** Rejected: it breaks "subscriptions come only from reviewed rules", and an agent could aim a subscription at any topic its principal can read, including other agents' events.
- **A rule per pull request in git.** Rejected: a commit and a CI run per watched pull request, for something that lives hours or days.
- **The agent subscribes to `github.pull_request.*` and filters by number itself.** Rejected: every pull request of every watched repository wakes the agent (and spends its budget) before it can decline.

## Consequences

- The topic and payload (`{ watchId, topic, repository, number, event }`, with the sender inside `event`) are a contract agents depend on. The hub only relays what the `github` mappings already carry.
- The hub is told who is asking by a per-agent token derived from the hub secret (as for timers), with no list of agents and no repository allow-list: any agent may watch any repository the webhook delivers events for. A token can create watches for its own agent only.
- Watches are kept in the hub's SQLite store with a lifecycle (renewal, 30 days of inactivity, end on merge) rather than as domain objects, so the domain stays unaware of them.
- The hub has no GitHub credential and sends no snapshot: the agent reads current pull request state itself and only gets events from the moment it asks.

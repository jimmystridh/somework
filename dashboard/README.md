# Fleet dashboard ("Agent operations")

The dashboard of the agent cluster: hypervisor machines, the SomeWork section (agents, work, approvals, events, rules, hub, token pools) and, per agent, how it is set up. A Rust workspace of its own (`shared`, `server`, `ui`; Dioxus web UI, axum server), kept outside the root workspace. The design and the data it may show are in `docs/FLEET_DASHBOARD.md`: metadata only, every value is picked by name through a restricted reader.

## Agent setup

Each agent serves `/profile` next to `/status` on its health port (`packages/agent-kit/README.md`, "/profile"). The dashboard reads it for every entry of `agents-health.json` whose address ends in `/status`, passes it through `server/src/setup.rs` (names, restricted alphabets, length limits; unread fields never reach the page) and shows one card per agent under "Agent setup": role, image tag, setup hash and when it last changed, capabilities, model, budgets, tools and approval patterns, repository access (credential kind, GitHub identity, token expiry note), skills, chat and event settings, and the system prompt text with its hash. The prompt is operator wording: the page is only reachable through the private gateway.

`agents-health.json` entries may carry `"logs": "{container=\"somework-pi-agent-1\"}"` (a stream selector of one to three matchers); with `GRAFANA_URL` set (plain https, no path) the page links each agent to its logs in Grafana Explore. Only plain selectors and addresses are accepted.

## Work history and model usage

Each agent also serves `/history` next to `/status` (its job record: the latest 500 jobs with what each was about, how it ended, duration, tokens by kind, cost, pull request and a short redacted summary). The dashboard reads up to 200 per agent through `server/src/history.rs` (names, restricted alphabets, the summary as plain text) and shows them under "Work history": one tab per agent (Aikido fixer and QA first), the outcomes as filter chips, a row per job that opens to its details. The jobs are the ones an agent has recorded since it runs a version with the extended record.

"Model usage and cost" reads the central Prometheus through the read-only Grafana endpoint (`server/src/usage.rs`): the agents' `somework_llm_tokens_total` and `somework_llm_cost_usd_total` as increases over 24 hours, 7 days and 30 days per agent, provider and model. It needs `METRICS_URL` (https, for example `https://10.10.10.13:9444`) and, in the secrets directory, `metrics-token` (a Viewer token: `deploy/grafana/provision-reader.py --name somework-fleet-reader`) and `metrics-ca.pem`; the Grafana host must allow the dashboard's address. Without them the section says it is not available. The numbers are read once a minute.

The old heartbeat card of the "Pi" demo agent is gone from the page (the `/ingest/pi` endpoint still accepts heartbeats and is unused).

## Build

```
cargo test                                         # server and UI unit tests
rm -rf target/dx/fleet-ui/release/web/public   # stale hashed files would be bundled too
dx bundle --release --platform web --package fleet-ui
rm -rf bundle && cp -R target/dx/fleet-ui/release/web/public bundle && cp public/style.css bundle/style.css
docker build -t agent-cluster-fleet:<version> .    # Dockerfile compiles the server and copies bundle/
```

`compose.yaml` runs it on the services VM (TLS port 9444 behind the tailnet gateway; secrets directory with the domain key, CA, `agents-health.json`, hub admin token).

The code keeps the pilot's host names as defaults (the TLS name its healthcheck verifies, the hypervisor address); change them with the environment (`compose.yaml`) before using the dashboard elsewhere. This repository is private.

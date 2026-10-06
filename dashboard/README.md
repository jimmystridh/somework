# Fleet dashboard ("Agent operations")

The dashboard of the agent cluster: hypervisor machines, the SomeWork section (agents, work, approvals, events, rules, hub, token pools) and, per agent, how it is set up. A Rust workspace of its own (`shared`, `server`, `ui`; Dioxus web UI, axum server), kept outside the root workspace. The design and the data it may show are in `docs/FLEET_DASHBOARD.md`: metadata only, every value is picked by name through a restricted reader.

## Agent setup

Each agent serves `/profile` next to `/status` on its health port (`packages/agent-kit/README.md`, "/profile"). The dashboard reads it for every entry of `agents-health.json` whose address ends in `/status`, passes it through `server/src/setup.rs` (names, restricted alphabets, length limits; unread fields never reach the page) and shows one card per agent under "Agent setup": role, image tag, setup hash and when it last changed, capabilities, model, budgets, tools and approval patterns, repository access (credential kind, GitHub identity, token expiry note), skills, chat and event settings, and the system prompt text with its hash. The prompt is operator wording: the page is only reachable through the private gateway.

## Build

```
cargo test                                         # server and UI unit tests
dx bundle --release --platform web --package fleet-ui
rm -rf bundle && cp -R target/dx/fleet-ui/release/web/public bundle && cp public/style.css bundle/style.css
docker build -t agent-cluster-fleet:<version> .    # Dockerfile compiles the server and copies bundle/
```

`compose.yaml` runs it on the services VM (TLS port 9444 behind the tailnet gateway; secrets directory with the domain key, CA, `agents-health.json`, hub admin token).

The code keeps the pilot's host names as defaults (the TLS name its healthcheck verifies, the hypervisor address); change them with the environment (`compose.yaml`) before using the dashboard elsewhere. This repository is private.

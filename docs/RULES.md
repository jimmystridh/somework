# Writing and deploying rules

A **rule** (see `CONTEXT.md`) is one file under `rules/` that becomes a wake-only subscription (reactions were removed by ADR 0003). This page is the workflow; the syntax, the payload pointers and the safety notes are in `rules/README.md`, the design in `docs/EVENTS.md`.

## Day to day

1. Write or change `rules/<name>.yaml`. One selector per rule.
2. Make sure `rules/samples/` has a recorded event for its selector (the full payload, `{topic, source, key, data, classification, verified, occurredAt, publishedBy}`).
3. `node packages/rules-cli/src/main.ts validate --card adapters --strict`.
4. Open a pull request. CI posts the plan as a comment: which rules would be created, replaced or deleted, and which fields differ.
5. The owner reviews (`rules/` is covered by CODEOWNERS) and merges. A push to `main` that touches `rules/` runs `apply`.

## The tool

`somework-rules` (`packages/rules-cli`):

| Command | Does |
|---|---|
| `validate` | YAML 1.2 parse (duplicate keys and aliases refused), JSON-schema check against `rules/schema.json`, then the conventions: name equals file name, subscriptions have `wake: true`, pointers start at a payload field (the CLI in `packages/rules-cli` still validates reaction fields until it is updated for the cut-over) |
| `plan` | `validate`, then compare with `GET /v1/rules`: create, replace, delete, pause, resume, unchanged. Markdown for the pull request (`--out`), JSON for tools (`--json-out`). Exit 0 with changes, 1 for invalid files, 2 for operational failures |
| `apply` | `validate`, then create and replace, correct pause state, delete the rules no file declares. `--dry-run` shows the plan. Exit 2 if any change failed or the domain does not match afterwards |
| `comment` | posts or updates the plan comment on a pull request (`GITHUB_TOKEN`) |

`apply` refuses to run when it finds no rule files while the domain has rules (a failed checkout must not wipe the automation; `--allow-empty` overrides) and when it would delete more than 5 rules at once (`--allow-delete-many`). `--no-prune` leaves undeclared rules alone.

Configuration: `SOMEWORK_URL`, `SOMEWORK_RULES_KEY_FILE` (a principal key file; `rules.manage` to apply, `ops.read` is enough to plan), `SOMEWORK_CA_FILE`, `SOMEWORK_REQUIRE_TLS=1`.

## CI (Woodpecker)

* `.woodpecker/check.yaml`, on pull requests: install, `npm run check:roles`, the unit tests that need no domain binary, `validate --strict`, `plan` (read-only key) and the plan comment.
* `.woodpecker/deploy.yaml`, on a push to `main` that changed `rules/`: `validate --strict`, then `apply`.
* `.woodpecker/full.yaml`, started by hand: builds the domain, runs the Rust and the whole TypeScript test suites (they need the built binary and a NATS server).

Secrets, set in Woodpecker and restricted to the events named: `somework_url`, `somework_ca` and `somework_rules_read_key` (pull requests, a principal with `ops.read` only); `github_token` (pull requests: write, only to comment); `somework_rules_key` (**push events on `main` only**, a principal with `rules.manage`). Do not enable pull requests from forks. Anything that can change the pipeline definition on a branch can read the secrets that branch's events may use, which is why `.woodpecker/` and `rules/` are in CODEOWNERS and why the key that can change rules exists only for pushes to `main`.

## What the shipped rules assume about event data

The producers' mappings decide the `data` of each topic. The shipped rules and samples rely on:

| Topic | `data` fields used |
|---|---|
| `github.pull_request.opened`, `.ready_for_review` | `number`, `draft`, `repository.cloneUrl` (also carried: `repository.fullName`, `htmlUrl`, `headSha`, `headRef`, `baseRef`, `author`, `title`, `htmlUrl`) |
| `jira.issue.transitioned` | `issue.key`, `to`, `from`, `repository.cloneUrl`, `repository.ref` (the mapping fills the repository and revision under test from its per-project configuration; the webhook itself carries neither) |
| `clock.nightly_digest.tick` | `name`, `scheduledFor` (schedule names use underscores: a topic segment may not contain a hyphen) |
| `grafana.alert.firing` | `alert`, `uid`, `severity`, `summary`, `url` |
| `datadog.monitor.alert` | `monitorId`, `monitor`, `transition`, `priority`, `tags`, `url` |

Change a mapping and these samples together.

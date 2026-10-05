# Woodpecker CI deploys the rules; its runner is on a separate VM

Status: accepted (2026-10-05)

Rules (files in git) are applied to the domain by a Woodpecker CI pipeline: on every pull request it validates the rules and mappings and posts the output of `apply --plan`; on merge to `main` it runs `apply`. The Woodpecker server runs on the services VM; the runner runs on its own small VM that holds no SomeWork secrets, because a runner executes arbitrary containers through the Docker socket (root-equivalent) and the services VM holds the domain's master key and canonical database. GitHub webhooks for Woodpecker enter through the same public receiver as every other event and are replayed unchanged by the hub, so the private network keeps a single public door.

## Considered options

- **Separate rules repository.** Recommended and rejected by the owner: rules live in the agents' repository, under `rules/`. Because the developer agent opens pull requests against that repository, the apply credential must be reachable only from the deploy pipeline on `main`, `rules/` must be covered by CODEOWNERS requiring the owner's review, and no agent token may merge.
- **Manual `apply` by the owner.** Fine for a first step, rejected as the target: no review gate and no plan on the pull request.
- **Runner on the services VM.** Rejected: 1.8 GB of memory and the wrong trust boundary.

## Consequences

- Woodpecker needs a GitHub OAuth application created by an organisation owner; its UI is reachable on the tailnet only.
- The hub must replay a webhook byte for byte with its original signature headers; Woodpecker verifies the forge signature itself.

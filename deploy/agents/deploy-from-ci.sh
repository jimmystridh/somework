#!/bin/sh
# The only thing the CI deploy key may run on the agents VM (authorized_keys: command="/home/js/somework-pilot/bin/deploy-from-ci.sh",restrict,from="10.10.10.15").
#
#   tar czf - REPOSITORY | ssh deploy-key-host deploy COMMIT_SHA
#
# It unpacks the repository from stdin, builds the event hub and every agent image as ci-<short sha> and rolls the hub, then the agent stacks, one
# after the other with roll-agent.sh (backup, wait for /ready, automatic restore). A stack that does not exist on the host yet (the Jira triage one, until it is
# set up by hand) is skipped, with a line saying so: its image is not built and nothing is rolled. The hub goes first: agents may use what a new hub offers. It stops at the first stack that does not become ready; that stack is back on its old
# version, the ones before it stay on the new one. Each agent stack drains while it is replaced (no new jobs, so the wait for its running jobs has an end); when
# $pilot/smoke.inventory exists the run ends with scripts/smoke-cluster.sh against it (exit status 5 when a check fails, the deployment stays). Install on the host by hand (a deploy key that could replace this file could run anything).
set -eu

pilot=${PILOT_DIR:-$HOME/somework-pilot}
host=${AGENTS_HOST:-10.10.10.11}

command=${SSH_ORIGINAL_COMMAND:-}
sha=${command#deploy }
case "$command" in "deploy "*) ;; *) echo "only 'deploy COMMIT_SHA' is allowed" >&2; exit 2;; esac
case "$sha" in *[!0-9a-f]*|"") echo "the commit must be lower-case hex" >&2; exit 2;; esac
[ "${#sha}" -eq 40 ] || { echo "the commit must be the full 40 characters" >&2; exit 2; }
tag=ci-$(echo "$sha" | cut -c1-7)

# the owner's kill switch (scripts/fleet-suspend.sh) leaves this file: a deployment rolls with `docker compose up -d`, which would start the stopped agents again
if [ -e "$pilot/SUSPENDED" ]; then echo "the fleet is suspended ($pilot/SUSPENDED exists): nothing was deployed; run scripts/fleet-suspend.sh --resume and deploy again" >&2; exit 4; fi

mkdir -p "$pilot/ci"
exec 9> "$pilot/ci/lock"
flock -n 9 || { echo "another deployment is running" >&2; exit 3; }

src=$pilot/ci/src
rm -rf "$src"
mkdir -p "$src"
tar -xzf - -C "$src" --no-same-owner
cd "$src"
echo "deploying $sha as $tag"

export DOCKER_BUILDKIT=1
build() { docker build -q -f "$1" --target "$2" -t "$3:$tag" ${4:+--build-arg "$4"} . >/dev/null && echo "built $3:$tag"; }
build packages/events-hub/Dockerfile hub somework-events-hub
for target in agent sandbox egress; do build adapters/pi/Dockerfile "$target" "somework-pi-$target"; done
build adapters/reviewer/Dockerfile agent somework-reviewer
build adapters/aikido-fixer/Dockerfile agent somework-aikido-fixer
build adapters/datadog-triage/Dockerfile agent somework-datadog-triage
build adapters/datadog-triage/Dockerfile sandbox somework-datadog-triage-sandbox "SANDBOX_BASE=somework-pi-sandbox:$tag"
# optional stacks: the host has to set the stack up first (adapters/jira-triage/deploy/README.md, adapters/product-manager/deploy/README.md); until then nothing about it is built or rolled
present() { [ -f "$pilot/$1/compose.yaml" ] || { echo "$1: no stack on this host yet, skipped"; return 1; }; }
if present jira-triage; then build adapters/jira-triage/Dockerfile agent somework-jira-triage; fi
if present product-manager; then build adapters/product-manager/Dockerfile agent somework-product-manager; fi

# the agent stacks run the kit in their compose service `agent`, which drains while it is replaced (roll-agent.sh); the hub is not an agent and does not
roll() { DRAIN_SERVICE=${5:+agent} "$pilot/bin/roll-agent.sh" "$pilot/$1" "$2" "$tag" "$3" "$src/$4/deploy/compose.yaml"; }
roll events-hub HUB_VERSION "http://$host:8090/healthz" packages/events-hub
roll datadog-triage DATADOG_VERSION "http://$host:8084/ready" adapters/datadog-triage drain
roll reviewer REVIEWER_VERSION,SANDBOX_VERSION "http://$host:8082/ready" adapters/reviewer drain
roll aikido-fixer FIXER_VERSION,SANDBOX_VERSION "http://$host:8083/ready" adapters/aikido-fixer drain
if present jira-triage; then roll jira-triage TRIAGE_VERSION,SANDBOX_VERSION "http://$host:8085/ready" adapters/jira-triage drain; fi
if present product-manager; then roll product-manager PRODUCT_MANAGER_VERSION,SANDBOX_VERSION "http://$host:8086/ready" adapters/product-manager drain; fi
roll pi-agent PI_VERSION "http://$host:8081/ready" adapters/pi drain

# the smoke test of what was just rolled, when the host has an inventory for it (deploy/README.md, "Smoke test"): the deployment stays as it is, a failing check only fails this command (status 5)
inventory=$pilot/smoke.inventory
if [ -f "$inventory" ]; then
  sh "$src/scripts/smoke-cluster.sh" "$inventory" --version "$tag" || { echo "deployed $tag, but the smoke test failed" >&2; exit 5; }
else
  echo "no smoke inventory at $inventory: smoke test skipped"
fi
echo "deployed $tag"

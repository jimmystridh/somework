#!/bin/sh
# The only thing the CI deploy key may run on the agents VM (authorized_keys: command="/home/js/somework-pilot/bin/deploy-from-ci.sh",restrict,from="10.10.10.15").
#
#   tar czf - REPOSITORY | ssh deploy-key-host deploy COMMIT_SHA
#
# It unpacks the repository from stdin, builds every agent image as ci-<short sha> and rolls the four agent stacks one after the other with
# roll-agent.sh (backup, wait for /ready, automatic restore). It stops at the first stack that does not become ready; that stack is back on its old
# version, the ones before it stay on the new one. Install on the host by hand (a deploy key that could replace this file could run anything).
set -eu

pilot=${PILOT_DIR:-$HOME/somework-pilot}
host=${AGENTS_HOST:-10.10.10.11}

command=${SSH_ORIGINAL_COMMAND:-}
sha=${command#deploy }
case "$command" in "deploy "*) ;; *) echo "only 'deploy COMMIT_SHA' is allowed" >&2; exit 2;; esac
case "$sha" in *[!0-9a-f]*|"") echo "the commit must be lower-case hex" >&2; exit 2;; esac
[ "${#sha}" -eq 40 ] || { echo "the commit must be the full 40 characters" >&2; exit 2; }
tag=ci-$(echo "$sha" | cut -c1-7)

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
for target in agent sandbox egress; do build adapters/pi/Dockerfile "$target" "somework-pi-$target"; done
build adapters/reviewer/Dockerfile agent somework-reviewer
build adapters/aikido-fixer/Dockerfile agent somework-aikido-fixer
build adapters/datadog-triage/Dockerfile agent somework-datadog-triage
build adapters/datadog-triage/Dockerfile sandbox somework-datadog-triage-sandbox "SANDBOX_BASE=somework-pi-sandbox:$tag"

roll() { "$pilot/bin/roll-agent.sh" "$pilot/$1" "$2" "$tag" "http://$host:$3/ready" "$src/adapters/$4/deploy/compose.yaml"; }
roll datadog-triage DATADOG_VERSION 8084 datadog-triage
roll reviewer REVIEWER_VERSION,SANDBOX_VERSION 8082 reviewer
roll aikido-fixer FIXER_VERSION,SANDBOX_VERSION 8083 aikido-fixer
roll pi-agent PI_VERSION 8081 pi
echo "deployed $tag"

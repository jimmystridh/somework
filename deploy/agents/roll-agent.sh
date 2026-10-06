#!/bin/sh
# Rolls one agent stack to a new image tag and undoes it when the agent does not become ready.
#
#   roll-agent.sh STACK_DIR VERSION_VARIABLE TAG [READY_URL] [NEW_COMPOSE_FILE]
#
#   STACK_DIR         the directory with compose.yaml and .env of the stack (for example ~/somework-pilot/reviewer)
#   VERSION_VARIABLE  the .env variable that holds the image tag (PI_VERSION, REVIEWER_VERSION, FIXER_VERSION, ...); several, comma separated, when a stack
#                     runs images of more than one tag (REVIEWER_VERSION,SANDBOX_VERSION)
#   TAG               the new tag, built beforehand (docker image must exist)
#   READY_URL         the agent's /ready address; without it only "the containers are running" is checked
#   NEW_COMPOSE_FILE  a compose file from the repository to install first
#
# Before it changes anything it keeps compose.yaml and .env as *.before-TAG (an earlier backup of the same tag is kept as it is). A rollout
# that does not report ready within READY_SECONDS (default 90) puts both files back and starts the old version again; the exit status is then 1.
# Extra settings for one start only (for example AIKIDO_RESEED_HANDLER=1) go in the environment of this command.
set -eu

[ "$#" -ge 3 ] || { sed -n 2,17p "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }
dir=$1
variable=$2
tag=$3
ready_url=${4:-}
new_compose=${5:-}
ready_seconds=${READY_SECONDS:-90}

case "$variable" in *[!A-Z0-9_,]*|""|,*|*,|*,,*) echo "the version variable must be an upper-case .env name (several separated by commas)" >&2; exit 2;; esac
case "$tag" in *[!A-Za-z0-9._-]*|"") echo "the tag may only hold letters, digits, dot, underscore and hyphen" >&2; exit 2;; esac
cd "$dir"
[ -f compose.yaml ] && [ -f .env ] || { echo "$dir has no compose.yaml and .env" >&2; exit 2; }
for name in $(echo "$variable" | tr , ' '); do grep -q "^$name=" .env || { echo "$name is not set in $dir/.env" >&2; exit 2; }; done
first=${variable%%,*}
previous=$(sed -n "s/^$first=//p" .env | head -n 1)

[ -f "compose.yaml.before-$tag" ] || cp compose.yaml "compose.yaml.before-$tag"
[ -f ".env.before-$tag" ] || cp .env ".env.before-$tag"
[ -z "$new_compose" ] || cp "$new_compose" compose.yaml
for name in $(echo "$variable" | tr , ' '); do sed "s/^$name=.*/$name=$tag/" .env > .env.next && cat .env.next > .env && rm -f .env.next; done

wait_ready() {
  waited=0
  while [ "$waited" -lt "$ready_seconds" ]; do
    if [ -n "$ready_url" ]; then
      curl -fsS -m 5 "$ready_url" >/dev/null 2>&1 && return 0
    else
      [ -z "$(docker compose ps --status exited --status restarting --status dead -q 2>/dev/null)" ] && [ -n "$(docker compose ps --status running -q 2>/dev/null)" ] && return 0
    fi
    sleep 3
    waited=$((waited + 3))
  done
  return 1
}

docker compose up -d
if wait_ready; then
  echo "rolled $dir: $variable $previous -> $tag"
  exit 0
fi

echo "$dir did not become ready within ${ready_seconds}s: going back to $previous" >&2
cp "compose.yaml.before-$tag" compose.yaml
cp ".env.before-$tag" .env
docker compose up -d
exit 1

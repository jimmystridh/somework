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
#
# DRAIN_SERVICE=agent drains the agent first: the file `drain` is made in the state directory of that compose service (DRAIN_STATE_DIR, default /state), the
# agent then starts no new job, and the wait for its running jobs ends when those are done. The file is removed again as soon as the new container runs and
# on every way out of this script (the state is a volume: left behind, it would keep the new agent drained). Without DRAIN_SERVICE nothing is drained.
set -eu

[ "$#" -ge 3 ] || { sed -n 2,19p "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }
dir=$1
variable=$2
tag=$3
ready_url=${4:-}
new_compose=${5:-}
ready_seconds=${READY_SECONDS:-90}
drain_service=${DRAIN_SERVICE:-}
drain_file=${DRAIN_STATE_DIR:-/state}/drain
drained=0

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

# a restart ends the jobs the agent runs (a verification or a fix takes minutes): wait for them, up to IDLE_SECONDS (default 600), then roll anyway
# because the agent takes its unfinished jobs up again when it starts
wait_idle() {
  [ -n "$ready_url" ] || return 0
  metrics_url=${ready_url%/ready}/metrics
  idle_waited=0
  while [ "$idle_waited" -lt "${IDLE_SECONDS:-600}" ]; do
    running=$(curl -fsS -m 5 "$metrics_url" 2>/dev/null | awk '/^somework_jobs\{[^}]*state="running"/ { n += $NF } END { print n + 0 }') || running=0
    [ "${running:-0}" = 0 ] && return 0
    [ "$idle_waited" -eq 0 ] && echo "$dir: the agent runs $running job(s): waiting up to ${IDLE_SECONDS:-600}s for them to finish" >&2
    sleep 10
    idle_waited=$((idle_waited + 10))
  done
  echo "$dir: jobs are still running: rolling anyway, the agent takes them up again when it starts" >&2
}

start_drain() {
  [ -n "$drain_service" ] || return 0
  if docker compose exec -T "$drain_service" touch "$drain_file" >/dev/null 2>&1; then
    drained=1
    echo "$dir: draining: the agent starts no new job until the roll is done" >&2
  else
    echo "$dir: could not drain ($drain_service is not running?): only waiting for its jobs" >&2
  fi
}

stop_drain() {
  [ "$drained" = 1 ] || return 0
  drain_tries=0
  until docker compose exec -T "$drain_service" rm -f "$drain_file" >/dev/null 2>&1; do
    drain_tries=$((drain_tries + 1))
    [ "$drain_tries" -lt 10 ] || break
    sleep 3
  done
  if [ "$drain_tries" -ge 10 ]; then
    docker compose run --rm --no-deps -T --entrypoint rm "$drain_service" -f "$drain_file" >/dev/null 2>&1 \
      || echo "$dir: the drain file $drain_file could not be removed: remove it by hand, the agent starts no new job while it exists" >&2
  fi
  drained=0
}

trap stop_drain EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

start_drain
wait_idle
docker compose up -d
stop_drain
if wait_ready; then
  echo "rolled $dir: $variable $previous -> $tag"
  exit 0
fi

echo "$dir did not become ready within ${ready_seconds}s: going back to $previous" >&2
cp "compose.yaml.before-$tag" compose.yaml
cp ".env.before-$tag" .env
docker compose up -d
exit 1

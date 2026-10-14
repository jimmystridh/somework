#!/bin/sh
# Manual repository deployment AFTER owner review, approved secrets/license and
# verified owner-only ingress. Invoke with host_exec; never bypass tool approvals.
set -eu
cd "$(dirname "$0")"
[ "$#" -eq 1 ] || { echo 'usage: deploy.sh REVIEWED_FULL_COMMIT' >&2; exit 2; }
case "$1" in *[!0-9a-f]*|'') exit 2;; esac
[ "${#1}" -eq 40 ] && [ "$(git rev-parse HEAD)" = "$1" ] || { echo 'reviewed commit mismatch' >&2; exit 2; }
git diff --quiet && git diff --cached --quiet || { echo 'checkout has tracked edits' >&2; exit 2; }
# The established repo uses flock for deployments. This NEW Services lock only
# coordinates operators using this script: it is not proof of fleet reservations.
mkdir -p "$HOME/somework-pilot/plane"
exec 9> "$HOME/somework-pilot/plane/lock"
flock -n 9 || { echo 'another Plane script deployment holds the lock' >&2; exit 3; }
ENV_FILE=${PLANE_ENV_FILE:-/srv/plane/plane.env}
[ -f /srv/plane/minio.license ] || { echo 'owner-installed AIStor license required' >&2; exit 4; }
[ -f "$ENV_FILE" ] || { echo 'approved host-local environment required' >&2; exit 4; }
pc() { docker compose --project-directory "$PWD" --env-file "$ENV_FILE" -f upstream/compose.yaml -f compose.yaml "$@"; }
headroom() {
 available=$(awk '/^MemAvailable:/{print int($2/1024)}' /proc/meminfo)
 [ "$available" -ge "$1" ] || { echo "insufficient measured headroom: ${available} MiB available" >&2; exit 5; }
}
pc config --quiet
headroom 4800
pc pull
pc up -d --wait --wait-timeout 240 plane-db plane-redis plane-mq plane-minio
headroom 3072
# Recreate migration container each release; do not reuse an old exited success.
pc up -d --no-deps --force-recreate migrator
id=$(pc ps -a -q migrator)
[ -n "$id" ] || exit 6
result=$(timeout 900 docker wait "$id")
[ "$result" = 0 ] || { echo 'migration failed; keep ingress unavailable and inspect safely' >&2; exit 6; }
headroom 3072
pc up -d --no-deps --wait --wait-timeout 300 api
for component in worker beat-worker web space admin live proxy; do
 headroom 1024
 pc up -d --no-deps "$component"
done
curl --fail --silent --output /dev/null http://127.0.0.1:8090/api/instances/
pc ps -a
# Output container state only, not environment/config/logs that may hold secrets.
for id in $(pc ps -q); do docker inspect --format '{{.Name}} restart={{.RestartCount}} oom={{.State.OOMKilled}} status={{.State.Status}}' "$id"; done
echo 'Local Plane startup passed; external access, bootstrap, storage, migrations and persistence still require verification.'

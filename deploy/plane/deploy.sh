#!/bin/sh
# Manual repository deployment AFTER review of the EXACT commit, owner storage
# decision and approved secret operations. Invoke with host_exec; never bypass
# tool approvals. Ingress must remain unavailable until local verification.
set -eu
cd "$(dirname "$0")"
[ "$#" -ge 1 ] && [ "$#" -le 3 ] || { echo 'usage: deploy.sh REVIEWED_FULL_COMMIT [aistor|garage] [application|storage]' >&2; exit 2; }
storage=${2:-aistor}
phase=${3:-application}
case "$storage:$phase" in aistor:application|garage:application|garage:storage) ;; *) echo 'unsupported storage or phase' >&2; exit 2;; esac
case "$1" in *[!0-9a-f]*|'') exit 2;; esac
[ "${#1}" -eq 40 ] && [ "$(git rev-parse HEAD)" = "$1" ] || { echo 'reviewed commit mismatch' >&2; exit 2; }
git diff --quiet && git diff --cached --quiet || { echo 'checkout has tracked edits' >&2; exit 2; }
# The established repo uses flock for deployments. This NEW Services lock only
# coordinates operators using this script: it is not proof of fleet reservations.
mkdir -p "$HOME/somework-pilot/plane"
exec 9> "$HOME/somework-pilot/plane/lock"
flock -n 9 || { echo 'another Plane script deployment holds the lock' >&2; exit 3; }
ENV_FILE=${PLANE_ENV_FILE:-/srv/plane/plane.env}
[ -f "$ENV_FILE" ] || { echo 'approved host-local environment required' >&2; exit 4; }
if [ "$storage" = aistor ]; then
 [ -f /srv/plane/minio.license ] || { echo 'owner-installed AIStor license required' >&2; exit 4; }
else
 # Reads the private env: this whole invocation requires host_exec approval.
 # Validate before ANY container mutation, without rendering config or values.
 command -v python3 >/dev/null || { echo 'Python 3 required for Garage provisioning' >&2; exit 4; }
 python3 storage/garage/provision.py "$ENV_FILE" --check || exit 4
fi
pc() {
 if [ "$storage" = garage ]; then
  docker compose --project-directory "$PWD" --env-file "$ENV_FILE" -f upstream/compose.yaml -f compose.yaml -f storage/garage/production.compose.yaml "$@"
 else
  docker compose --project-directory "$PWD" --env-file "$ENV_FILE" -f upstream/compose.yaml -f compose.yaml "$@"
 fi
}
headroom() {
 available=$(awk '/^MemAvailable:/{print int($2/1024)}' /proc/meminfo)
 [ "$available" -ge "$1" ] || { echo "insufficient measured headroom: ${available} MiB available" >&2; exit 5; }
}
pc config --quiet
headroom 4800
if [ "$phase" = storage ]; then
 # Fresh Garage is unhealthy until an operator assigns an explicit layout.
 # This phase starts ONLY storage; no DB, migrations, app or proxy can start.
 pc pull plane-minio
 pc up -d --no-deps plane-minio
 echo 'Garage started only; initialize an approved explicit layout before application deployment.'
 exit 0
fi
pc pull
pc up -d --wait --wait-timeout 240 plane-db plane-redis plane-mq plane-minio
if [ "$storage" = garage ]; then
 # Health requires initialized layout. Never infer capacity or alter existing
 # layout/data here. Provision private bucket/key only AFTER layout is healthy.
 storage_id=$(pc ps -q plane-minio)
 [ -n "$storage_id" ] || exit 4
 python3 storage/garage/provision.py "$ENV_FILE" "$storage_id" || exit 4
fi
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
# Proxy starts asynchronously; bounded retries, never mistake container creation
# for a responding loopback application. Suppress response bodies entirely.
curl --fail --silent --output /dev/null --retry 30 --retry-delay 2 --retry-connrefused --max-time 10 --retry-max-time 120 http://127.0.0.1:8090/api/instances/
pc ps -a
# Output container state only, not environment/config/logs that may hold secrets.
for id in $(pc ps -q); do docker inspect --format '{{.Name}} restart={{.RestartCount}} oom={{.State.OOMKilled}} status={{.State.Status}}' "$id"; done
echo 'Local Plane startup passed; external access, bootstrap, storage, migrations and persistence still require verification.'

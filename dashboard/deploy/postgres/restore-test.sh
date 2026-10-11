#!/usr/bin/env bash
# Proves that a backup can be restored: loads a dump (default: the newest) into a throwaway Postgres container, checks the schema and the
# revision history, and removes the container again. It never touches the running database.
#   restore-test.sh [dump file]       env: BACKUP_DIR, POSTGRES_IMAGE (same image as compose.yaml), CONTAINER (the live one, for comparison)
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/srv/agent-cluster-postgres/backups}"
IMAGE="${POSTGRES_IMAGE:-postgres:17.11-bookworm@sha256:3645570cccdfa447589da9f57dd740faa29b30938e861289a5574b6ca6b03826}"
LIVE="${CONTAINER:-operations-postgres}"
dump="${1:-$(ls -1 "$BACKUP_DIR"/operations-*.dump 2>/dev/null | sort | tail -n 1)}"
[ -n "$dump" ] && [ -f "$dump" ] || { echo "no dump to test in $BACKUP_DIR" >&2; exit 1; }

if [ -f "$dump.sha256" ]; then
  (cd "$(dirname "$dump")" && sha256sum --check --quiet "$(basename "$dump").sha256") || { echo "checksum of $dump does not match" >&2; exit 1; }
fi

name="operations-restore-test-$$"
trap 'docker rm -f "$name" > /dev/null 2>&1 || true' EXIT
docker run -d --name "$name" -e POSTGRES_PASSWORD=restore-test -e POSTGRES_HOST_AUTH_METHOD=trust --network none "$IMAGE" > /dev/null
for _ in $(seq 1 60); do
  docker exec "$name" pg_isready --username=postgres > /dev/null 2>&1 && break
  sleep 1
done
docker exec "$name" pg_isready --username=postgres > /dev/null || { echo "the test database did not start" >&2; exit 1; }

docker exec "$name" psql --username=postgres --command='CREATE ROLE operations LOGIN' --command='CREATE DATABASE operations OWNER operations' > /dev/null
docker exec -i "$name" pg_restore --username=postgres --dbname=operations --no-owner --exit-on-error < "$dump"

query() { docker exec "$name" psql --username=postgres --dbname=operations --tuples-only --no-align --command="$1"; }
migrations="$(query 'SELECT max(version) FROM schema_migrations')"
[ -n "$migrations" ] || { echo "restore failed: schema_migrations is empty" >&2; exit 1; }
echo "restored $(basename "$dump"): schema version $migrations"
for table in users agent_setup_revisions catalog_revisions library_revisions fleet_limits_revisions audit_log; do
  restored="$(query "SELECT count(*) FROM $table")"
  live="$(docker exec -u postgres "$LIVE" psql --dbname=operations --tuples-only --no-align --command="SELECT count(*) FROM $table" 2>/dev/null || echo '?')"
  echo "  $table: $restored rows in the backup, $live in the live database"
done
# the history must still be append-only after a restore
[ "$(query "SELECT count(*) FROM pg_trigger WHERE tgname = 'audit_log_append_only'")" = "1" ] || { echo "restore failed: the audit log lost its append-only trigger" >&2; exit 1; }
echo "restore test passed"

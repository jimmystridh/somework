#!/usr/bin/env bash
# Nightly dump of Operations' database, kept for 14 days. Run by operations-postgres-backup.timer on VM104 as root.
#   BACKUP_DIR (default /srv/agent-cluster-postgres/backups), KEEP_DAYS (default 14), CONTAINER (default operations-postgres)
# The dump is checked (the archive's table of contents must read back) before it replaces anything, and old dumps are only deleted after a
# good new one exists, so a failing backup never eats the retention.
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/srv/agent-cluster-postgres/backups}"
KEEP_DAYS="${KEEP_DAYS:-14}"
CONTAINER="${CONTAINER:-operations-postgres}"
DATABASE="${DATABASE:-operations}"

umask 077
mkdir -p "$BACKUP_DIR"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
partial="$BACKUP_DIR/.operations-$stamp.dump.partial"
final="$BACKUP_DIR/operations-$stamp.dump"
trap 'rm -f "$partial"' EXIT

docker exec -u postgres "$CONTAINER" pg_dump --format=custom --no-owner --dbname="$DATABASE" > "$partial"
[ -s "$partial" ] || { echo "backup failed: the dump is empty" >&2; exit 1; }
docker exec -i "$CONTAINER" pg_restore --list < "$partial" > /dev/null || { echo "backup failed: the dump does not read back" >&2; exit 1; }

mv "$partial" "$final"
trap - EXIT
(cd "$BACKUP_DIR" && sha256sum "$(basename "$final")" > "$(basename "$final").sha256")
echo "backup written: $final ($(wc -c < "$final") bytes)"

# retention: dumps (and their checksums) older than KEEP_DAYS days
find "$BACKUP_DIR" -maxdepth 1 -type f \( -name 'operations-*.dump' -o -name 'operations-*.dump.sha256' \) -mtime "+$KEEP_DAYS" -print -delete

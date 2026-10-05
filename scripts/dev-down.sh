#!/usr/bin/env bash
# Stops the local instance started by dev-up.sh (data in run/ is kept).
cd "$(dirname "$0")/../run" 2>/dev/null || exit 0
for f in worker.pid server.pid; do
  [ -f "$f" ] && kill "$(cat "$f")" 2>/dev/null; rm -f "$f"
done
echo stopped

#!/usr/bin/env bash
# Starts a local SomeWork instance under run/: server on 127.0.0.1:8080 plus a demo reviewer worker. Idempotent.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUN="$ROOT/run"; BIN="$ROOT/dist"
mkdir -p "$RUN/data" "$RUN/logs"
cd "$RUN"

if [ ! -f somework.toml ]; then
  cat > somework.toml <<TOML
[domain]
id = "development"
db = "$RUN/data/somework.db"
listen = "127.0.0.1:8080"
public_url = "http://127.0.0.1:8080"

[objects]
dir = "$RUN/data/objects"

[ui]
dir = "$ROOT/ui"
dev_token_login = true   # local only: paste the token printed by scripts/console-token.sh
TOML
fi
adm() { "$BIN/somework" admin --config somework.toml "$@"; }
[ -f root.key.json ]     || adm bootstrap --key-out root.key.json
[ -f reviewer.key.json ] || { adm enroll-agent --id agent/reviewer --key-out reviewer.key.json
                              adm register-card --card "$ROOT/examples/reviewer-card.json" --approve; }
[ -f author.key.json ]   || adm enroll-agent --id agent/author --may-invoke 'code.*' --key-out author.key.json

alive() { [ -f "$1" ] && kill -0 "$(cat "$1")" 2>/dev/null; }
if ! alive server.pid; then
  nohup "$BIN/somework" serve --config somework.toml > logs/server.log 2>&1 & echo $! > server.pid
fi
for _ in $(seq 1 40); do curl -sf http://127.0.0.1:8080/healthz >/dev/null && break; sleep 0.5; done
if ! alive worker.pid; then
  nohup "$BIN/somework-sidecar" run --domain-url http://127.0.0.1:8080 --key-file reviewer.key.json --mode worker \
    --exec "python3 $ROOT/examples/reviewer-agent.py" > logs/worker.log 2>&1 & echo $! > worker.pid
fi
echo "SomeWork is up: http://127.0.0.1:8080/ui/   (login token: scripts/console-token.sh)"

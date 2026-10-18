#!/bin/sh
# Points one agent stack at the fleet's codex-proxy, or puts it back. It changes files only: the agent is restarted by the caller (docker compose up -d), so
# that nothing here starts or stops an agent.
#
#   codex-proxy-switch.sh status   STACK_DIR
#   codex-proxy-switch.sh apply    STACK_DIR KEY_NAME [PROXY_URL]
#   codex-proxy-switch.sh rollback STACK_DIR
#
#   STACK_DIR  the directory with compose.yaml, .env and secrets/pi/auth.json of the stack (for example ~/somework-pilot/reviewer)
#   KEY_NAME   the agent's own proxy key, the file KEYS_DIR/KEY_NAME (default KEYS_DIR ~/somework-pilot/codex-proxy/agent-keys), made with POST /admin/client-keys
#   PROXY_URL  default CODEX_PROXY_URL_DEFAULT or http://10.10.10.11:8095
#
# apply keeps auth.json and .env as *.before-codex-proxy (an earlier backup is kept as it is), sets CODEX_PROXY_URL in .env and replaces the stack's openai-codex
# entry in auth.json with {"type":"api_key","key":<the agent's proxy key>}; the other providers in the file stay. The key is read from its file and never printed.
# rollback puts both files back. The agent's model, effort and allowlist are not touched: the kit serves the same openai-codex/<model> from the proxy.
set -eu

action=${1:-}
dir=${2:-}
[ -n "$action" ] && [ -n "$dir" ] || { sed -n 2,16p "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }
cd "$dir"
[ -f compose.yaml ] && [ -f .env ] || { echo "$dir has no compose.yaml and .env" >&2; exit 2; }
auth=secrets/pi/auth.json
sudo test -f "$auth" || { echo "$dir/$auth does not exist" >&2; exit 2; }
keys_dir=${KEYS_DIR:-$HOME/somework-pilot/codex-proxy/agent-keys}

describe() {
	url=$(sed -n 's/^CODEX_PROXY_URL=//p' .env | head -n 1)
	kind=$(sudo python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); e=d.get("openai-codex"); print(e.get("type","?") if isinstance(e,dict) else "none")' "$auth")
	echo "$dir: CODEX_PROXY_URL=${url:-<not set>} openai-codex credential=$kind"
}

case "$action" in
status)
	describe
	;;
apply)
	name=${3:?the name of the key of this agent}
	url=${4:-${CODEX_PROXY_URL_DEFAULT:-http://10.10.10.11:8095}}
	case "$name" in *[!a-z0-9-]*|"") echo "the key name may only hold lower-case letters, digits and hyphen" >&2; exit 2;; esac
	case "$url" in http://*|https://*) ;; *) echo "the proxy URL must be http or https" >&2; exit 2;; esac
	[ -s "$keys_dir/$name" ] || { echo "no proxy key for $name in $keys_dir" >&2; exit 2; }
	sudo test -e "$auth.before-codex-proxy" || sudo cp -p "$auth" "$auth.before-codex-proxy"
	[ -e .env.before-codex-proxy ] || cp -p .env .env.before-codex-proxy
	KEY_FILE="$keys_dir/$name" sudo --preserve-env=KEY_FILE python3 - "$auth" <<'PY'
import json, os, sys
path = sys.argv[1]
key = open(os.environ["KEY_FILE"]).read().strip()
data = json.load(open(path))
data["openai-codex"] = {"type": "api_key", "key": key}
tmp = path + ".tmp"
mode = os.stat(path).st_mode & 0o777
with open(tmp, "w") as out:
    json.dump(data, out, indent=2)
os.chmod(tmp, mode)
st = os.stat(path)
os.chown(tmp, st.st_uid, st.st_gid)
os.replace(tmp, path)
PY
	if grep -q '^CODEX_PROXY_URL=' .env; then sed -i "s|^CODEX_PROXY_URL=.*|CODEX_PROXY_URL=$url|" .env; else printf 'CODEX_PROXY_URL=%s\n' "$url" >> .env; fi
	describe
	echo "restart it to take effect: (cd $dir && docker compose up -d)"
	;;
rollback)
	sudo test -e "$auth.before-codex-proxy" && sudo cp -p "$auth.before-codex-proxy" "$auth" || echo "no auth.json backup: left as it is" >&2
	[ -e .env.before-codex-proxy ] && cp -p .env.before-codex-proxy .env || echo "no .env backup: left as it is" >&2
	describe
	echo "restart it to take effect: (cd $dir && docker compose up -d)"
	;;
*)
	echo "unknown action $action" >&2
	exit 2
	;;
esac

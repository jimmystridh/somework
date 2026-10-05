#!/usr/bin/env bash
# Proves the sandbox's containment from the inside. Run on the Docker host after `docker compose up -d`; exits non-zero on the first failure.
#   deploy/verify-sandbox.sh [compose project dir]
set -uo pipefail
cd "${1:-$(dirname "$0")}"
fail=0
in_sandbox() { docker compose exec -T sandbox bash -c "$1"; }
check() { # description, expectation (ok|fail), command
  if in_sandbox "$3" >/tmp/verify.out 2>&1; then got=ok; else got=fail; fi
  if [ "$got" = "$2" ]; then printf 'PASS  %s\n' "$1"; else printf 'FAIL  %s (expected %s, got %s)\n      %s\n' "$1" "$2" "$got" "$(head -c 300 /tmp/verify.out)"; fail=1; fi
}
check "runs as a non-root user" ok '[ "$(id -u)" != 0 ]'
check "root filesystem is read-only" fail 'touch /rootfs-write-test'
check "the workspace volume is writable" ok 'touch /workspace/.verify && rm /workspace/.verify'
# what the model's commands see is what the daemon gives them (its own environment is never inherited): run `env` through it
env_seen=$(docker compose exec -T sandbox node - <<'JS'
const fs = require("node:fs");
const token = fs.readFileSync(process.env.SANDBOX_TOKEN_FILE, "utf8").trim();
fetch("http://127.0.0.1:7070/exec", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ command: "env" }) })
  .then((r) => r.text())
  .then((body) => console.log(body.split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((l) => l.t === "out").map((l) => l.d).join("")));
JS
)
if echo "$env_seen" | grep -qiE "token|secret|password|api_?key|authorization|SANDBOX_|PI_|SOMEWORK"; then
  printf 'FAIL  commands run through the sandbox daemon see a credential-like or service variable\n'; fail=1
else printf 'PASS  commands run through the sandbox daemon see no credentials or service variables (only: %s)\n' "$(echo "$env_seen" | cut -d= -f1 | tr '\n' ' ')"; fi
check "SomeWork key, model credentials and CA are not visible" fail 'ls /run/somework /run/secrets/pi 2>/dev/null | grep .'
check "no route to the internet without the proxy" fail 'curl --noproxy "*" -sS -m 6 -o /dev/null https://example.com'
check "a host off the allowlist is refused by the proxy" fail 'curl -sS -m 10 -o /dev/null https://example.com'
check "a private address (the domain host) is refused by the proxy" fail 'curl -sS -m 10 -o /dev/null https://10.0.0.5:8443/healthz'
check "cloud metadata is unreachable" fail 'curl -sS -m 6 -o /dev/null http://169.254.169.254/'
check "an allowlisted host is reachable through the proxy" ok 'curl -sS -m 20 -o /dev/null -I https://github.com'
check "capabilities are dropped" ok 'grep -q "^CapEff:\s*0000000000000000" /proc/self/status'
check "no new privileges" ok 'grep -q "^NoNewPrivs:\s*1" /proc/self/status'
[ "$fail" = 0 ] && echo "sandbox containment verified" || { echo "containment check FAILED"; exit 1; }

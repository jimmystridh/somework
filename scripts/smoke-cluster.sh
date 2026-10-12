#!/bin/sh
# Checks that a deployed cluster answers, and lists every check that failed.
#
#   scripts/smoke-cluster.sh INVENTORY [--version TAG | --sha COMMIT] [--wait SECONDS] [--help]
#
#   INVENTORY        the addresses to check, one per line (see deploy/README.md, "Smoke test"):
#                      agent      NAME URL [version=skip]   /ready answers 200 with "ready": true; /profile reports the expected version
#                      manager    NAME URL                  /status answers 200 with a JSON object
#                      hub        NAME URL                  the URL (the event hub's /healthz) answers 200
#                      operations NAME URL token_file=PATH [ca_file=PATH]   /fleet/api/ops/me answers 200 for that service token
#   --version TAG    the image tag every agent has to report as its version (ci-0123456)
#   --sha COMMIT     the same, from the commit that was deployed: ci- and its first 7 characters, as deploy-from-ci.sh tags the images
#   --wait SECONDS   keep trying a failing check this long before it counts as failed (default 30)
#
# Without --version or --sha the agents' versions are not compared. Exit status: 0 when every check passed, 1 when any failed, 2 for a bad call or inventory.
set -eu

usage() { sed -n 2,16p "$0" | sed 's/^# \{0,1\}//'; }

inventory=""
expected=""
wait_seconds=30
while [ "$#" -gt 0 ]; do
    case "$1" in
        --help|-h) usage; exit 0 ;;
        --version) [ "$#" -ge 2 ] || { echo "--version needs a TAG" >&2; exit 2; }; expected=$2; shift 2 ;;
        --sha) [ "$#" -ge 2 ] || { echo "--sha needs a COMMIT" >&2; exit 2; }
            case "$2" in *[!0-9a-f]*|"") echo "the commit must be lower-case hex" >&2; exit 2;; esac
            [ "${#2}" -eq 40 ] || { echo "the commit must be the full 40 characters" >&2; exit 2; }
            expected=ci-$(echo "$2" | cut -c1-7); shift 2 ;;
        --wait) [ "$#" -ge 2 ] || { echo "--wait needs SECONDS" >&2; exit 2; }
            case "$2" in *[!0-9]*|"") echo "--wait takes a whole number of seconds" >&2; exit 2;; esac
            wait_seconds=$2; shift 2 ;;
        -*) echo "unknown option $1" >&2; usage >&2; exit 2 ;;
        *) [ -z "$inventory" ] || { echo "only one INVENTORY is allowed" >&2; exit 2; }; inventory=$1; shift ;;
    esac
done
[ -n "$inventory" ] || { usage >&2; exit 2; }
[ -r "$inventory" ] || { echo "cannot read the inventory $inventory" >&2; exit 2; }
case "$expected" in *[!A-Za-z0-9._-]*) echo "the version may only hold letters, digits, dot, underscore and hyphen" >&2; exit 2;; esac

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
checks=$work/checks
: > "$checks"

invalid() { echo "$inventory line $1: $2" >&2; bad_inventory=1; }
bad_inventory=0
line_number=0
while IFS= read -r line || [ -n "$line" ]; do
    line_number=$((line_number + 1))
    set -f
    # shellcheck disable=SC2086
    set -- $line
    set +f
    [ "$#" -gt 0 ] || continue
    case "$1" in "#"*) continue;; esac
    kind=$1
    [ "$#" -ge 3 ] || { invalid "$line_number" "expected: KIND NAME URL [options]"; continue; }
    name=$2
    url=$3
    shift 3
    case "$kind" in agent|manager|hub|operations) ;; *) invalid "$line_number" "unknown kind $kind (agent, manager, hub or operations)"; continue;; esac
    case "$name" in *[!A-Za-z0-9._/-]*) invalid "$line_number" "the name may only hold letters, digits, dot, underscore, slash and hyphen"; continue;; esac
    case "$url" in http://*|https://*) ;; *) invalid "$line_number" "the URL must start with http:// or https://"; continue;; esac
    case "$url" in *[!A-Za-z0-9._~:/?=\&%@+,-]*) invalid "$line_number" "the URL holds a character that is not allowed"; continue;; esac
    version_check=yes
    token_file=""
    ca_file=""
    for option in "$@"; do
        case "$option" in
            version=skip) version_check=no ;;
            token_file=?*) token_file=${option#token_file=} ;;
            ca_file=?*) ca_file=${option#ca_file=} ;;
            *) invalid "$line_number" "unknown option $option"; continue 2 ;;
        esac
    done
    if [ "$kind" = operations ] && [ -z "$token_file" ]; then invalid "$line_number" "operations needs token_file=PATH"; continue; fi
    printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$kind" "$name" "${url%/}" "$version_check" "${token_file:--}" "${ca_file:--}" >> "$checks"
done < "$inventory"
[ "$bad_inventory" = 0 ] || exit 2
[ -s "$checks" ] || { echo "$inventory lists nothing to check" >&2; exit 2; }

reason=""
detail=""
body=$work/body

fetch() {
    # fetch URL [curl options]: sets code and leaves the answer in $body
    fetch_url=$1
    shift
    : > "$body"
    code=$(curl -sS -m 10 -o "$body" -w '%{http_code}' "$@" "$fetch_url" 2>/dev/null) || code=000
    [ "$code" != 000 ] || reason="no answer from $fetch_url"
}

answer() { tr -d '\n' < "$body"; }

check_agent() {
    url=$1
    fetch "$url/ready"
    [ "$code" != 000 ] || return 1
    [ "$code" = 200 ] || { reason="/ready answered $code, not 200"; return 1; }
    answer | grep -Eq '"ready"[[:space:]]*:[[:space:]]*true' || { reason="/ready answered 200 but not \"ready\": true: $(answer | cut -c1-200)"; return 1; }
    fetch "$url/profile"
    [ "$code" != 000 ] || return 1
    [ "$code" = 200 ] || { reason="/profile answered $code, not 200"; return 1; }
    reported=$(answer | sed -n 's/^{[^{}]*"version":"\([^"]*\)".*/\1/p')
    [ -n "$reported" ] || { reason="/profile does not report a version"; return 1; }
    if [ "$version_check" = yes ] && [ -n "$expected" ] && [ "$reported" != "$expected" ]; then
        reason="/profile reports version $reported, expected $expected"
        return 1
    fi
    detail="ready, version $reported"
    [ "$version_check" = yes ] && [ -n "$expected" ] || detail="$detail (not compared)"
}

check_manager() {
    fetch "$1/status"
    [ "$code" != 000 ] || return 1
    [ "$code" = 200 ] || { reason="/status answered $code, not 200"; return 1; }
    answer | grep -Eq '^[[:space:]]*\{' || { reason="/status did not answer a JSON object"; return 1; }
    detail="/status answers"
}

check_hub() {
    fetch "$1"
    [ "$code" != 000 ] || return 1
    [ "$code" = 200 ] || { reason="answered $code, not 200"; return 1; }
    detail="answers"
}

check_operations() {
    [ -r "$token_file" ] || { reason="cannot read the token file $token_file"; return 1; }
    token=$(tr -d '\r\n' < "$token_file")
    [ -n "$token" ] || { reason="the token file $token_file is empty"; return 1; }
    ( umask 077; printf 'x-operations-service-token: %s\n' "$token" > "$work/header" )
    if [ -n "$ca_file" ]; then fetch "$1/fleet/api/ops/me" -H "@$work/header" --cacert "$ca_file"; else fetch "$1/fleet/api/ops/me" -H "@$work/header"; fi
    rm -f "$work/header"
    [ "$code" != 000 ] || return 1
    [ "$code" = 200 ] || { reason="/fleet/api/ops/me answered $code, not 200 (the service token is refused or not accepted yet)"; return 1; }
    answer | grep -Eq '"role"[[:space:]]*:' || { reason="/fleet/api/ops/me did not describe the caller"; return 1; }
    detail="service token accepted as $(answer | sed -n 's/.*"email":"\([^"]*\)".*/\1/p') ($(answer | sed -n 's/.*"role":"\([^"]*\)".*/\1/p'))"
}

attempts=$((wait_seconds / 3 + 1))
failures=$work/failures
: > "$failures"
total=0
failed=0
while IFS="$(printf '\t')" read -r kind name url version_check token_file ca_file; do
    [ "$token_file" != "-" ] || token_file=""
    [ "$ca_file" != "-" ] || ca_file=""
    total=$((total + 1))
    attempt=1
    while :; do
        reason=""
        detail=""
        if "check_$kind" "$url"; then
            echo "ok   $name: $detail"
            break
        fi
        if [ "$attempt" -ge "$attempts" ]; then
            echo "FAIL $name: $reason"
            echo "$name ($url): $reason" >> "$failures"
            failed=$((failed + 1))
            break
        fi
        attempt=$((attempt + 1))
        sleep 3
    done
done < "$checks"

if [ "$failed" -gt 0 ]; then
    echo "$failed of $total checks failed:" >&2
    sed 's/^/  /' "$failures" >&2
    exit 1
fi
echo "all $total checks passed"

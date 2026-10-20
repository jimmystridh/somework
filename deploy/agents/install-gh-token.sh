#!/bin/sh
# Installs a READ-ONLY GitHub token for the `gh` command in one agent stack's sandbox, checks it, and says what to restart.
#   install-gh-token.sh STACK_NAME OWNER/REPO            (the token is typed at the prompt or piped on stdin: never an argument)
# STACK_NAME is the directory under ~/somework-pilot (aikido-fixer, pi-agent, reviewer, cluster-dev, ...). The token must be a fine-grained one for the repository
# with Pull requests, Contents, Actions, Checks, Commit statuses and Metadata: read, and nothing that writes: the model's shell can read it, so it must not be the
# token that pushes. The file is written next to the stack's other secrets, GH_READ_TOKEN_HOST is set in its .env, and only the HTTP status of the check is printed.
set -eu
stack="${1:?usage: install-gh-token.sh STACK_NAME OWNER/REPO}"
repo="${2:?usage: install-gh-token.sh STACK_NAME OWNER/REPO}"
dir="$HOME/somework-pilot/$stack"
[ -d "$dir" ] || { echo "no stack directory $dir" >&2; exit 1; }
case "$repo" in */*) ;; *) echo "the repository is OWNER/REPO" >&2; exit 1 ;; esac
if [ -t 0 ]; then
  printf 'read-only GitHub token for %s (not shown): ' "$repo" >&2
  stty -echo
  read -r token
  stty echo
  echo >&2
else
  read -r token
fi
[ ${#token} -ge 20 ] || { echo "that does not look like a token" >&2; exit 1; }
umask 077
mkdir -p "$dir/secrets"
file="$dir/secrets/gh-read-token"
printf '%s\n' "$token" > "$file.new"
chmod 0444 "$file.new"
code=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $token" -H 'Accept: application/vnd.github+json' "https://api.github.com/repos/$repo/pulls?per_page=1" || true)
write=$(curl -s -H "Authorization: Bearer $token" -H 'Accept: application/vnd.github+json' "https://api.github.com/repos/$repo" | grep -o '"push": *true' | head -1 || true)
if [ "$code" != "200" ]; then rm -f "$file.new"; echo "GitHub answered $code for pull requests of $repo: nothing installed" >&2; exit 1; fi
if [ -n "$write" ]; then rm -f "$file.new"; echo "this token can push to $repo: use a read-only one; nothing installed" >&2; exit 1; fi
mv "$file.new" "$file"
if grep -q '^GH_READ_TOKEN_HOST=' "$dir/.env" 2>/dev/null; then sed -i 's#^GH_READ_TOKEN_HOST=.*#GH_READ_TOKEN_HOST=./secrets/gh-read-token#' "$dir/.env"; else printf 'GH_READ_TOKEN_HOST=./secrets/gh-read-token\n' >> "$dir/.env"; fi
echo "installed $file (pull requests of $repo: HTTP $code, no push right). Recreate the sandbox to use it: cd $dir && docker compose up -d sandbox"

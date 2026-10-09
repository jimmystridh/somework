#!/usr/bin/env python3
"""Creates a read-only Grafana service account: the one the agents' observe tools use, or (--name) another reader such as the fleet dashboard's. Standard library only; idempotent.

  python3 deploy/grafana/provision-reader.py --url https://grafana.example --token-out secrets/grafana-token [--token ADMIN_TOKEN | --admin-password-file FILE] [--name somework-fleet-reader]

The account is a Viewer named somework-agents-reader unless --name says otherwise. Each run adds a fresh token to it and writes that token to --token-out (mode 0600);
earlier tokens of the account are deleted so there is one live token. Mount the file into each agent host and point GRAFANA_TOKEN_FILE at it.
The token never goes into the sandbox: the agent service reads it, the model only sees query results.
"""
import argparse
import base64
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request

NAME = "somework-agents-reader"
NAME_PATTERN = r"^[a-z0-9][a-z0-9-]{2,60}$"


def call(base, token, method, path, body=None):
    headers = {"accept": "application/json"}
    if token and token.startswith("basic "):
        headers["authorization"] = "Basic " + token[len("basic "):]
    elif token:
        headers["authorization"] = f"Bearer {token}"
    data = None
    if body is not None:
        headers["content-type"] = "application/json"
        data = json.dumps(body).encode()
    request = urllib.request.Request(base + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            text = response.read().decode()
    except urllib.error.HTTPError as error:
        raise SystemExit(f"{method} {path} failed: {error.code} {error.read().decode()[:200]}")
    return json.loads(text) if text else {}


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--url", required=True)
    parser.add_argument("--token", default=os.environ.get("GRAFANA_ADMIN_TOKEN", ""), help="admin token, if the front end does not authenticate you")
    parser.add_argument("--token-out", required=True)
    parser.add_argument("--name", default=NAME, help="the service account's name (default %(default)s)")
    parser.add_argument("--admin-password-file", help="file with the Grafana admin password, used with the user admin when no admin token is given")
    args = parser.parse_args()
    base = args.url.rstrip("/")
    if not re.match(NAME_PATTERN, args.name):
        raise SystemExit("--name must be lowercase letters, digits and hyphens")
    name = args.name
    if args.admin_password_file and not args.token:
        with open(args.admin_password_file) as handle:
            args.token = "basic " + base64.b64encode(f"admin:{handle.read().strip()}".encode()).decode()

    found = call(base, args.token, "GET", "/api/serviceaccounts/search?query=" + urllib.parse.quote(name))
    account = next((a for a in found.get("serviceAccounts", []) if a.get("name") == name), None)
    if account is None:
        account = call(base, args.token, "POST", "/api/serviceaccounts", {"name": name, "role": "Viewer", "isDisabled": False})
    elif account.get("role") != "Viewer":
        call(base, args.token, "PATCH", f"/api/serviceaccounts/{account['id']}", {"role": "Viewer"})
    account_id = account["id"]

    old = call(base, args.token, "GET", f"/api/serviceaccounts/{account_id}/tokens")
    created = call(base, args.token, "POST", f"/api/serviceaccounts/{account_id}/tokens", {"name": f"{'observe' if name == NAME else name}-{len(old) + 1}"})
    for token in old:
        call(base, args.token, "DELETE", f"/api/serviceaccounts/{account_id}/tokens/{token['id']}")

    descriptor = os.open(args.token_out, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "w") as handle:
        handle.write(created["key"])
    os.chmod(args.token_out, 0o600)
    print(f"service account {name} (Viewer) ready; token written to {args.token_out}")


if __name__ == "__main__":
    main()

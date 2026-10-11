#!/usr/bin/env bash
# Registers the service principal `operations` in the SomeWork domain with exactly what Operations needs to send setup documents:
#   message.send    send the chat.message that carries a document
#   artifact.write  upload the document as an application/json artifact
#   artifact.read   the domain checks the sender may read an artifact it attaches to a message (without it the send is a 403 PolicyDenied)
# Nothing else (no read of messages, no admin action).
#
# The signing key is made on the Operations host and never travels; only its public key comes here:
#   on the services VM:   docker run --rm -v /etc/agent-cluster-fleet:/out <fleet image> /app/fleet-server --operations-keygen --domain <domain id> --out /out/operations-key.json
#                         (prints {"publicKey": "..."}; the file stays in the secrets directory, mode 0600)
#   on the domain host:   register-operations-principal.sh '<publicKey>' [--apply]
# Without --apply it only prints the command. The admin command is the one the other adapters use (`ops admin ... enroll-service`); set
# SOMEWORK_ADMIN to change how it is called. To withdraw the access later: remove operations-key.json from the Operations host (nothing is
# sent without it) and PATCH the principal's permissions to an empty action list through the admin API.
set -euo pipefail

public_key="${1:-}"
apply="${2:-}"
[ -n "$public_key" ] || { echo "usage: $0 '<public key>' [--apply]" >&2; exit 2; }
case "$public_key" in
  *[!A-Za-z0-9_-]*) echo "the public key must be base64url (letters, digits, - and _)" >&2; exit 2 ;;
esac
[ "${#public_key}" -eq 43 ] || { echo "an Ed25519 public key is 43 base64url characters; got ${#public_key}" >&2; exit 2; }

admin="${SOMEWORK_ADMIN:-ops admin --config /etc/somework/somework.toml}"
command="$admin enroll-service --id operations --action message.send --action artifact.write --action artifact.read --public-key $public_key"

if [ "$apply" = "--apply" ]; then
  eval "$command"
  echo "operations registered. Check with: GET /v1/admin/principals (service:operations, actions message.send and artifact.write)"
else
  echo "dry run, nothing changed. Run again with --apply to run:"
  echo "  $command"
fi

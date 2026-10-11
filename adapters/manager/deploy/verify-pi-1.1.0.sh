#!/usr/bin/env bash
# Checks that the Pi on this host is 1.1.0 (the first release with an MCP client) and that it lists a harmless stdio MCP server from an mcp.json.
# Run it on the host where the upgraded Pi is installed, before the Manager is cut over (see README.md, "Upgrading Pi"). It points Pi at a scratch
# agent folder with PI_CODING_AGENT_DIR, so ~/.pi/agent, the Manager and its container are not touched. Nothing is deployed or restarted.
#   ./verify-pi-1.1.0.sh                     # pi on the PATH
#   PI="/path/to/pi" ./verify-pi-1.1.0.sh    # another binary (one command, no quoting inside)
set -euo pipefail

EXPECTED_VERSION="1.1.0"
PI="${PI:-pi}"
SERVER_NAME="verify-ping"

scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
export PI_CODING_AGENT_DIR="$scratch/agent"
mkdir -p "$PI_CODING_AGENT_DIR"

fail() {
	echo "FAIL: $*" >&2
	exit 1
}

command -v node >/dev/null || fail "node is not on the PATH (the stub MCP server needs it)"
# shellcheck disable=SC2086
command -v ${PI%% *} >/dev/null || fail "pi is not on the PATH (set PI=/path/to/pi)"

# shellcheck disable=SC2086
version="$($PI --version 2>&1 | tail -n 1)"
echo "pi --version: $version"
echo "$version" | grep -Eq "(^|[^0-9.])${EXPECTED_VERSION//./\\.}([^0-9.]|$)" || fail "expected Pi $EXPECTED_VERSION, found: $version"

cat >"$scratch/stub-mcp-server.mjs" <<'STUB'
// A minimal MCP server over stdio (newline-delimited JSON-RPC): one tool, no side effects.
import { createInterface } from "node:readline";

const reply = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
const refuse = (id, message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message } })}\n`);

createInterface({ input: process.stdin }).on("line", (line) => {
	let request;
	try {
		request = JSON.parse(line);
	} catch {
		return;
	}
	if (request.id === undefined) return;
	switch (request.method) {
		case "initialize":
			return reply(request.id, { protocolVersion: request.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "verify-ping", version: "1.0.0" } });
		case "tools/list":
			return reply(request.id, { tools: [{ name: "ping", description: "Answers pong.", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } }] });
		case "tools/call":
			return reply(request.id, { content: [{ type: "text", text: "pong" }] });
		case "ping":
			return reply(request.id, {});
		default:
			return refuse(request.id, `unknown method ${request.method}`);
	}
});
STUB

cat >"$PI_CODING_AGENT_DIR/mcp.json" <<JSON
{
  "mcpServers": {
    "$SERVER_NAME": {
      "command": "node",
      "args": ["$scratch/stub-mcp-server.mjs"],
      "description": "Harmless stub used by verify-pi-1.1.0.sh",
      "timeout": 20
    }
  }
}
JSON

# shellcheck disable=SC2086
listing="$($PI mcp list 2>&1)" || fail "pi mcp list exited with an error:
$listing"
echo "$listing"
echo "$listing" | grep -q "$SERVER_NAME" || fail "pi mcp list does not show the server $SERVER_NAME"
echo "$listing" | grep -Eqi "ping" || fail "pi mcp list does not show the tool ping of $SERVER_NAME"

echo "OK: Pi $EXPECTED_VERSION lists the stdio MCP server $SERVER_NAME with its tool."

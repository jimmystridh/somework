// A tiny MCP server over stdio for the tests: newline-delimited JSON-RPC, a few tools.
import { createInterface } from "node:readline";

const tools = [
	{ name: "echo", description: "Echoes its text argument", inputSchema: { type: "object", properties: { text: { type: "string" } } }, annotations: { readOnlyHint: true } },
	{ name: "write_thing", description: "Changes something", inputSchema: { type: "object" } },
	{ name: "env_keys", description: "The names of the environment variables of this process", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
	{ name: "env_value", description: "One environment variable", inputSchema: { type: "object", properties: { name: { type: "string" } } } },
	{ name: "pid", description: "The process id", inputSchema: { type: "object" } },
	{ name: "slow", description: "Never answers", inputSchema: { type: "object" } },
	{ name: "crash", description: "Exits", inputSchema: { type: "object" } },
	{ name: "fail", description: "Reports an error", inputSchema: { type: "object" } },
	{ name: "leak", description: "Returns a token-like string", inputSchema: { type: "object" } },
];

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const text = (value, isError = false) => ({ content: [{ type: "text", text: value }], ...(isError ? { isError: true } : {}) });

createInterface({ input: process.stdin }).on("line", (line) => {
	const message = JSON.parse(line);
	if (message.id === undefined) return;
	switch (message.method) {
		case "initialize":
			return reply(message.id, { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } });
		case "tools/list":
			// two pages, to exercise the cursor
			return message.params?.cursor ? reply(message.id, { tools: tools.slice(4) }) : reply(message.id, { tools: tools.slice(0, 4), nextCursor: "page2" });
		case "tools/call": {
			const { name, arguments: args = {} } = message.params;
			process.stderr.write(`call ${name}\n`);
			if (name === "echo") return reply(message.id, text(String(args.text ?? "")));
			if (name === "write_thing") return reply(message.id, text("done"));
			if (name === "env_keys") return reply(message.id, text(Object.keys(process.env).sort().join(",")));
			if (name === "env_value") return reply(message.id, text(process.env[args.name] ?? "unset"));
			if (name === "pid") return reply(message.id, text(String(process.pid)));
			if (name === "fail") return reply(message.id, text("it broke", true));
			if (name === "leak") return reply(message.id, text("here is a token ghp_abcdefghijklmnopqrstuvwxyz0123456789 for you"));
			if (name === "crash") process.exit(3);
			return; // slow: no answer
		}
		default:
			return send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "no such method" } });
	}
});

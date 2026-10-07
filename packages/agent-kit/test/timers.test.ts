import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, it } from "node:test";
import { TimersClient, TimersError } from "../src/timers/client.ts";
import { resolveTimers } from "../src/timers/config.ts";
import { defaultTimerKey } from "../src/timers/tools.ts";

interface Seen {
	method: string;
	path: string;
	headers: IncomingMessage["headers"];
	body: any;
}

const servers: Server[] = [];
afterEach(async () => {
	for (const server of servers.splice(0)) await new Promise((r) => { server.closeAllConnections(); server.close(r); });
});

/** A stand-in for the hub that records the request and answers what the test says. */
async function hub(answer: (seen: Seen) => { status: number; body: unknown }) {
	const seen: Seen[] = [];
	const server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			const text = Buffer.concat(chunks).toString("utf8");
			const record: Seen = { method: req.method ?? "", path: req.url ?? "", headers: req.headers, body: text ? JSON.parse(text) : undefined };
			seen.push(record);
			const { status, body } = answer(record);
			res.writeHead(status, { "content-type": "application/json" });
			res.end(typeof body === "string" ? body : JSON.stringify(body));
		});
	});
	servers.push(server);
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	return { seen, client: new TimersClient({ url, agentId: "agent/aikido-fixer", token: () => "secret-token-value" }) };
}

describe("the timers client", () => {
	it("asks for a timer with the agent's identity and token, and returns what the hub stored", async () => {
		const { seen, client } = await hub(() => ({ status: 201, body: { id: "tmr_1", key: "pr:7", dueAt: "2026-10-07T08:15:00.000Z", note: "look" } }));
		const timer = await client.request({ delaySeconds: 900, note: "look", key: "pr:7" });
		assert.equal(timer.id, "tmr_1");
		assert.equal(seen[0]!.method, "POST");
		assert.equal(seen[0]!.path, "/v1/timers");
		assert.equal(seen[0]!.headers.authorization, "Bearer secret-token-value");
		assert.equal(seen[0]!.headers["x-somework-agent"], "agent/aikido-fixer");
		assert.deepEqual(seen[0]!.body, { delaySeconds: 900, note: "look", key: "pr:7" });
	});

	it("lists and cancels, and tells a missing timer from a failure", async () => {
		const { seen, client } = await hub((req) => (req.method === "GET" ? { status: 200, body: { timers: [{ id: "tmr_1", key: "k", dueAt: "x", note: "n" }] } } : req.path.endsWith("/known") ? { status: 200, body: { cancelled: true } } : { status: 404, body: { error: "no_such_pending_timer" } }));
		assert.equal((await client.list())[0]!.key, "k");
		assert.equal(await client.cancel("known"), true);
		assert.equal(await client.cancel("pr:7/odd key"), false);
		assert.equal(seen[2]!.path, "/v1/timers/pr%3A7%2Fodd%20key");
	});

	it("passes on the hub's reason when it refuses, and never the token", async () => {
		const { client } = await hub(() => ({ status: 400, body: { error: "a timer must be at least 60 seconds away" } }));
		await assert.rejects(client.request({ delaySeconds: 5, note: "x" }), (error: unknown) => error instanceof TimersError && error.status === 400 && /at least 60 seconds/.test(error.message) && !error.message.includes("secret-token-value"));
	});

	it("reports an unreachable or confused hub in one sentence", async () => {
		const down = new TimersClient({ url: "http://127.0.0.1:9", agentId: "agent/x", token: () => "secret-token-value", timeoutMs: 500 });
		await assert.rejects(down.list(), /could not be reached/);
		const { client } = await hub(() => ({ status: 200, body: "<html>" }));
		await assert.rejects(client.list(), /not JSON/);
	});
});

describe("timer settings and keys", () => {
	it("are off without TIMERS_URL, and need a token file when on", () => {
		assert.deepEqual(resolveTimers({}), { enabled: false });
		assert.throws(() => resolveTimers({ TIMERS_URL: "https://hub:8091" }), /TIMERS_TOKEN_FILE/);
		assert.deepEqual(resolveTimers({ TIMERS_URL: "https://hub:8091", TIMERS_TOKEN_FILE: "/t", TIMERS_CA_FILE: "/ca" }), { enabled: true, url: "https://hub:8091", tokenFile: "/t", caFile: "/ca" });
	});

	it("give the same note and delay the same key, so a replayed call moves one timer", () => {
		assert.equal(defaultTimerKey("check PR 7", 900), defaultTimerKey("check PR 7", 900));
		assert.notEqual(defaultTimerKey("check PR 7", 900), defaultTimerKey("check PR 8", 900));
		assert.match(defaultTimerKey("x", 60), /^ask:[0-9a-f]{16}$/);
	});
});

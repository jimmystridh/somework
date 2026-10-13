import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, it } from "node:test";
import { WatchesClient, WatchesError } from "../src/watches/client.ts";
import { resolveWatches } from "../src/watches/config.ts";
import { createWatchTools, WATCH_TOOL_NAMES } from "../src/watches/tools.ts";

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
	return { seen, client: new WatchesClient({ url, agentId: "agent/reviewer", token: () => "secret-token-value" }) };
}

const view = (number: number, extra: object = {}) => ({ id: `wch_${number}`, repository: "o/r", number, topic: "github.watch.reviewer.event", status: "active", createdAt: "2026-10-13T08:00:00.000Z", lastActivityAt: "2026-10-13T08:00:00.000Z", expiresAt: "2026-11-12T08:00:00.000Z", ...extra });

describe("the watches client", () => {
	it("watches with the agent's identity and token, and tells a new watch from a renewal", async () => {
		const { seen, client } = await hub((req) => (req.body.number === 7 ? { status: 201, body: { ...view(7), created: true, note: "n" } } : { status: 200, body: { ...view(8), created: false, note: "n" } }));
		assert.equal((await client.watch({ repository: "o/r", number: 7 })).created, true);
		assert.equal((await client.watch({ repository: "o/r", number: 8 })).created, false);
		assert.equal(seen[0]!.method, "POST");
		assert.equal(seen[0]!.path, "/v1/watches");
		assert.equal(seen[0]!.headers.authorization, "Bearer secret-token-value");
		assert.equal(seen[0]!.headers["x-somework-agent"], "agent/reviewer");
		assert.deepEqual(seen[0]!.body, { repository: "o/r", number: 7 });
	});

	it("lists and cancels, and tells a missing watch from a failure", async () => {
		const { seen, client } = await hub((req) => (req.method === "GET" ? { status: 200, body: { watches: [view(7)] } } : req.path.endsWith("wch_7") ? { status: 200, body: { cancelled: true } } : { status: 404, body: { error: "no_such_active_watch" } }));
		assert.equal((await client.list())[0]!.number, 7);
		assert.equal(await client.cancel("wch_7"), true);
		assert.equal(await client.cancel("o/r#8"), false);
		assert.equal(seen[2]!.path, "/v1/watches/o%2Fr%238");
	});

	it("passes on the hub's reason when it refuses, and never the token", async () => {
		const { client } = await hub(() => ({ status: 429, body: { error: "50 watches are active already" } }));
		await assert.rejects(client.watch({ repository: "o/r", number: 1 }), (error: unknown) => error instanceof WatchesError && error.status === 429 && /50 watches/.test(error.message) && !error.message.includes("secret-token-value"));
	});

	it("reports an unreachable or confused hub in one sentence", async () => {
		const down = new WatchesClient({ url: "http://127.0.0.1:9", agentId: "agent/x", token: () => "secret-token-value", timeoutMs: 500 });
		await assert.rejects(down.list(), (error: unknown) => error instanceof WatchesError && /could not be reached/.test(error.message));
		const { client } = await hub(() => ({ status: 200, body: "<html>" }));
		await assert.rejects(client.list(), /not JSON/);
	});
});

describe("the watch tools", () => {
	it("watch, list and stop, and say what the hub refused", async () => {
		const { seen, client } = await hub((req) =>
			req.method === "POST" ? (req.body.number === 99 ? { status: 400, body: { error: "repository must be owner/name" } } : { status: 201, body: { ...view(req.body.number ?? 7), created: true, note: "n" } })
			: req.method === "GET" ? { status: 200, body: { watches: [view(7), view(8, { status: "ended", endReason: "merged", endedAt: "2026-10-13T09:00:00.000Z", expiresAt: undefined })] } }
			: { status: 200, body: { cancelled: true } },
		);
		const { extension, toolNames } = createWatchTools(client);
		assert.deepEqual(toolNames, [...WATCH_TOOL_NAMES]);
		const tools = new Map<string, any>((extension as any).tools.map((tool: any) => [tool.name, tool]));
		const watched = await tools.get("watch_pull_request").execute({ url: "https://github.com/o/r/pull/7" });
		assert.match(watched.content[0].text, /watching o\/r#7.*github\.watch\.reviewer\.event/);
		assert.deepEqual(seen[0]!.body, { url: "https://github.com/o/r/pull/7" });
		const refused = await tools.get("watch_pull_request").execute({ repository: "nope", number: 99 });
		assert.equal(refused.isError, true);
		assert.match(refused.content[0].text, /owner\/name/);
		const listed = await tools.get("list_pull_request_watches").execute();
		assert.match(listed.content[0].text, /o\/r#7: active until[\s\S]*o\/r#8: ended \(merged\)/);
		assert.match((await tools.get("unwatch_pull_request").execute({ watch: "o/r#7" })).content[0].text, /stopped watching/);
	});
});

describe("watch settings", () => {
	it("are off without WATCH_URL, and need a token file when on", () => {
		assert.deepEqual(resolveWatches({}), { enabled: false });
		assert.throws(() => resolveWatches({ WATCH_URL: "https://hub:8091" }), /WATCH_TOKEN_FILE/);
		assert.deepEqual(resolveWatches({ WATCH_URL: "https://hub:8091", WATCH_TOKEN_FILE: "/t", WATCH_CA_FILE: "/ca" }), { enabled: true, url: "https://hub:8091", tokenFile: "/t", caFile: "/ca" });
	});
});

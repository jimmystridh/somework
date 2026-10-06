import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { DatadogClient, DatadogError, readCredentials } from "../src/datadog/client.ts";

interface Seen {
	method: string;
	url: string;
	headers: IncomingMessage["headers"];
	body: string;
}

const keys = { apiKey: "a".repeat(32), appKey: "b".repeat(40) };
let server: Server;
let base: string;
let seen: Seen[] = [];
let reply: (request: Seen) => { status: number; body?: unknown; raw?: string; redirect?: string; delayMs?: number } = () => ({ status: 200, body: {} });

before(async () => {
	server = createServer(async (req, res) => {
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(chunk as Buffer);
		const request = { method: req.method!, url: req.url!, headers: req.headers, body: Buffer.concat(chunks).toString("utf8") };
		seen.push(request);
		const answer = reply(request);
		if (answer.delayMs) await new Promise((resolve) => setTimeout(resolve, answer.delayMs));
		if (answer.redirect) return void res.writeHead(302, { location: answer.redirect }).end();
		res.writeHead(answer.status, { "content-type": "application/json" }).end(answer.raw ?? JSON.stringify(answer.body ?? {}));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(() => void server.close());
afterEach(() => {
	seen = [];
	reply = () => ({ status: 200, body: {} });
});

const client = (extra: Record<string, unknown> = {}) => new DatadogClient({ apiBase: base, credentials: keys, ...extra });
const range = { from: Date.parse("2026-10-06T09:00:00Z"), to: Date.parse("2026-10-06T10:00:00Z") };

describe("the Datadog client", () => {
	it("sends the keys as headers and reads one monitor", async () => {
		reply = () => ({ status: 200, body: { id: 5, name: "cpu" } });
		assert.deepEqual(await client().getMonitor(5), { id: 5, name: "cpu" });
		assert.equal(seen[0]!.method, "GET");
		assert.equal(seen[0]!.url, "/api/v1/monitor/5");
		assert.equal(seen[0]!.headers["dd-api-key"], keys.apiKey);
		assert.equal(seen[0]!.headers["dd-application-key"], keys.appKey);
		assert.ok(!seen[0]!.url.includes(keys.apiKey), "keys are never in a URL");
	});

	it("makes the read requests the tools need and no others", async () => {
		const c = client();
		await c.searchMonitors("status:alert", 10);
		await c.queryMetrics({ query: "avg:system.cpu.user{*}", range });
		await c.listIncidents(5);
		await c.searchLogs({ query: "service:web", range, limit: 20 });
		await c.searchEvents({ query: "*", range, limit: 7 });
		assert.deepEqual(
			seen.map((s) => `${s.method} ${s.url.split("?")[0]}`),
			["GET /api/v1/monitor/search", "GET /api/v1/query", "GET /api/v2/incidents", "POST /api/v2/logs/events/search", "POST /api/v2/events/search"],
		);
		assert.match(seen[0]!.url, /query=status%3Aalert&per_page=10/);
		assert.match(seen[1]!.url, /from=1791277200&to=1791280800/);
		assert.deepEqual(JSON.parse(seen[3]!.body), { filter: { query: "service:web", from: "2026-10-06T09:00:00.000Z", to: "2026-10-06T10:00:00.000Z" }, sort: "-timestamp", page: { limit: 20 } });
		assert.equal(JSON.parse(seen[4]!.body).page.limit, 7);
	});

	it("refuses an id that is not a whole number before any request", async () => {
		await assert.rejects(() => client().getMonitor("12/../../x"), (error: DatadogError) => error.kind === "not_found");
		await assert.rejects(() => client().getMonitor("abc"), DatadogError);
		assert.equal(seen.length, 0);
	});

	it("pins the host: another host, plain http and redirects are refused", async () => {
		const remote = new DatadogClient({ site: "datadoghq.eu", credentials: keys, fetch: (async (url: URL) => (assert.equal(url.host, "api.datadoghq.eu"), assert.equal(url.protocol, "https:"), new Response("{}"))) as never });
		await remote.getMonitor(1);
		reply = () => ({ status: 302, redirect: "http://127.0.0.1:1/elsewhere" });
		await assert.rejects(() => client().getMonitor(1), (error: DatadogError) => error.kind === "unavailable");
		assert.equal(seen.length, 1, "the redirect was not followed");
		const plain = new DatadogClient({ apiBase: "http://api.example.com", credentials: keys, fetch: (async () => assert.fail("must not be called")) as never });
		await assert.rejects(() => plain.getMonitor(1), /only reached over https/);
	});

	it("builds the API host from the site and takes nothing else from configuration", () => {
		const urls: string[] = [];
		const eu = new DatadogClient({ site: "datadoghq.eu", credentials: keys, fetch: (async (url: URL) => (urls.push(url.href), new Response("{}"))) as never });
		const us = new DatadogClient({ site: "us5.datadoghq.com", credentials: keys, fetch: (async (url: URL) => (urls.push(url.href), new Response("{}"))) as never });
		return Promise.all([eu.getMonitor(1), us.getMonitor(2)]).then(() => assert.deepEqual(urls, ["https://api.datadoghq.eu/api/v1/monitor/1", "https://api.us5.datadoghq.com/api/v1/monitor/2"]));
	});

	it("posts searches only: nothing else can be posted", async () => {
		const c = client() as unknown as { "#send"?: unknown } & Record<string, unknown>;
		const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(c)).filter((name) => name !== "constructor");
		assert.deepEqual(methods.sort(), ["getMonitor", "listIncidents", "queryMetrics", "searchEvents", "searchLogs", "searchMonitors"]);
	});

	it("maps errors to kinds and never leaks a key or a body", async () => {
		const cases: [number, string, boolean][] = [
			[401, "unauthorized", true],
			[403, "unauthorized", true],
			[404, "not_found", true],
			[400, "bad_request", true],
			[429, "rate_limited", false],
			[500, "unavailable", false],
			[503, "unavailable", false],
		];
		for (const [status, kind, permanent] of cases) {
			reply = () => ({ status, body: { errors: [`secret ${keys.apiKey} in a body`] } });
			const error = await client().getMonitor(1).then(() => assert.fail("expected an error"), (e: DatadogError) => e);
			assert.deepEqual([error.kind, error.permanent, error.status], [kind, permanent, status], String(status));
			assert.ok(!error.message.includes(keys.apiKey) && !error.message.includes(keys.appKey), `${status}: ${error.message}`);
		}
	});

	it("keeps a short redacted Datadog message for a rejected query, so the model can correct it", async () => {
		reply = () => ({ status: 400, body: { errors: ["Invalid query: unexpected token 'AND' (api_key=abcdefghijklmnop)"] } });
		const error = await client().searchLogs({ query: "x AND", range, limit: 5 }).then(() => assert.fail("expected an error"), (e: DatadogError) => e);
		assert.match(error.message, /Invalid query: unexpected token 'AND'/);
		assert.doesNotMatch(error.message, /abcdefghijklmnop/);
	});

	it("caps the size of an answer and the time it may take", async () => {
		reply = () => ({ status: 200, raw: JSON.stringify({ data: "x".repeat(2000) }) });
		await assert.rejects(() => client({ maxBytes: 1000 }).getMonitor(1), /more than 1000 bytes/);
		reply = () => ({ status: 200, body: {}, delayMs: 300 });
		await assert.rejects(() => client({ timeoutMs: 50 }).getMonitor(1), (error: DatadogError) => error.kind === "unavailable");
	});

	it("refuses an answer that is not a JSON object", async () => {
		reply = () => ({ status: 200, raw: "<html>nope</html>" });
		await assert.rejects(() => client().getMonitor(1), (error: DatadogError) => error.kind === "bad_response");
		reply = () => ({ status: 200, raw: "[1]" });
		assert.deepEqual(await client().getMonitor(1).catch(() => "rejected"), [1], "an array is still an object to JSON; the summaries ignore what they do not know");
	});

	it("reads the keys again for every request, so a rotated file is picked up", async () => {
		let current = { apiKey: "1".repeat(32), appKey: "2".repeat(40) };
		const rotating = new DatadogClient({ apiBase: base, credentials: () => current });
		await rotating.getMonitor(1);
		current = { apiKey: "3".repeat(32), appKey: "4".repeat(40) };
		await rotating.getMonitor(1);
		assert.deepEqual(seen.map((s) => s.headers["dd-api-key"]), ["1".repeat(32), "3".repeat(32)]);
	});
});

describe("the key file", () => {
	const write = (content: string) => {
		const file = join(mkdtempSync(join(tmpdir(), "dd-keys-")), "keys.json");
		writeFileSync(file, content, { mode: 0o600 });
		return file;
	};
	it("reads both spellings", () => {
		assert.deepEqual(readCredentials(write(JSON.stringify(keys))), keys);
		assert.deepEqual(readCredentials(write(JSON.stringify({ api_key: keys.apiKey, app_key: keys.appKey }))), keys);
	});
	it("fails with a message that does not quote the file", () => {
		assert.throws(() => readCredentials(write(`{"apiKey": "${keys.apiKey}", oops`)), (error: Error) => /not valid JSON/.test(error.message) && !error.message.includes(keys.apiKey));
		assert.throws(() => readCredentials(write(JSON.stringify({ apiKey: keys.apiKey }))), /needs apiKey and appKey/);
		assert.throws(() => readCredentials(write(JSON.stringify({ apiKey: "", appKey: "x" }))), /needs apiKey and appKey/);
		assert.throws(() => readCredentials("/nonexistent/keys.json"), /cannot be read: ENOENT/);
	});
});

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it } from "node:test";
import { githubSignature, hookToken, signingSecret } from "../src/derive.ts";
import { startHarness, SECRET, type Harness } from "./helpers.ts";

const open: Harness[] = [];
const start = async (options?: Parameters<typeof startHarness>[0]) => {
	const harness = await startHarness(options);
	open.push(harness);
	return harness;
};
afterEach(async () => {
	while (open.length) await open.pop()!.stop();
});

const post = (url: string, body: string | Uint8Array, headers: Record<string, string> = {}) => fetch(url, { method: "POST", body, headers });

describe("accepting webhooks", () => {
	it("stores the raw body byte for byte and only allow-listed headers", async () => {
		const h = await start();
		const body = Buffer.from([0x7b, 0x22, 0xc3, 0xa5, 0x22, 0x3a, 0x31, 0x7d, 0x0a, 0x00, 0xff]);
		const response = await post(h.hook("jira"), body, { "content-type": "application/json", "x-atlassian-webhook-identifier": "abc", cookie: "session=1", authorization: "Bearer leaked", "x-forwarded-for": "9.9.9.9", "cf-connecting-ip": "203.0.113.5" });
		assert.equal(response.status, 202);
		const { id } = (await response.json()) as { id: string };
		const { items } = await h.pull();
		assert.equal(items.length, 1);
		assert.equal(items[0].id, id);
		assert.equal(items[0].source, "jira");
		assert.deepEqual(Buffer.from(items[0].bodyBase64, "base64"), body);
		assert.deepEqual(items[0].headers, { "content-type": "application/json", "user-agent": "node", "x-atlassian-webhook-identifier": "abc", "cf-connecting-ip": "203.0.113.5" });
	});

	it("rejects a missing, forged or another source's token", async () => {
		const h = await start();
		assert.equal((await post(`${h.publicUrl}/hook/jira/${"x".repeat(43)}`, "{}")).status, 401);
		assert.equal((await post(`${h.publicUrl}/hook/jira`, "{}")).status, 404);
		const jiraToken = hookToken(SECRET, "jira", 1);
		assert.equal((await post(`${h.publicUrl}/hook/datadog/${jiraToken}`, "{}")).status, 401);
		assert.equal((await post(`${h.publicUrl}/hook/datadog/${hookToken(SECRET, "datadog", 1)}`, "{}")).status, 401, "the old version of a rotated source no longer works");
		assert.equal((await post(`${h.publicUrl}/hook/nosuch/${jiraToken}`, "{}")).status, 404);
		assert.equal((await h.pull()).items.length, 0);
	});

	it("only accepts POST", async () => {
		const h = await start();
		assert.equal((await fetch(h.hook("jira"))).status, 405);
	});

	it("requires a valid signature for github-hmac sources, in addition to the token", async () => {
		const h = await start();
		const body = JSON.stringify({ action: "opened" });
		const key = signingSecret(SECRET, "github", 1);
		assert.equal((await post(h.hook("github"), body)).status, 401);
		assert.equal((await post(h.hook("github"), body, { "x-hub-signature-256": githubSignature("wrong-key", Buffer.from(body)) })).status, 401);
		assert.equal((await post(h.hook("github"), body + " ", { "x-hub-signature-256": githubSignature(key, Buffer.from(body)) })).status, 401, "a signature of a different body");
		assert.equal((await post(h.hook("github"), body, { "x-hub-signature-256": githubSignature(key, Buffer.from(body)), "x-github-delivery": "d-1", "x-github-event": "pull_request" })).status, 202);
		assert.equal((await h.pull()).items[0].headers["x-github-delivery"], "d-1");
	});

	it("caps the body at 1 MiB, declared or not", async () => {
		const h = await start({ config: { limits: { maxBodyBytes: 1024 } } });
		assert.equal((await post(h.hook("jira"), Buffer.alloc(2048, 97))).status, 413);
		const streamed = await fetch(h.hook("jira"), { method: "POST", body: new ReadableStream({ start(c) { c.enqueue(Buffer.alloc(700, 97)); c.enqueue(Buffer.alloc(700, 97)); c.close(); } }), duplex: "half" } as RequestInit);
		assert.equal(streamed.status, 413);
		assert.equal((await post(h.hook("jira"), Buffer.alloc(1024, 97))).status, 202);
		assert.equal((await post(h.hook("jira"), "")).status, 400);
	});

	it("rate limits per source and globally", async () => {
		const h = await start({ config: { limits: { perSource: { ratePerSecond: 1, burst: 3 }, global: { ratePerSecond: 1, burst: 5 } } } });
		const statuses: number[] = [];
		for (let i = 0; i < 4; i++) statuses.push((await post(h.hook("jira"), "{}")).status);
		assert.deepEqual(statuses, [202, 202, 202, 429]);
		assert.equal((await post(h.hook("datadog"), "{}")).status, 202, "another source has its own bucket");
		assert.equal((await post(h.hook("datadog"), "{}")).status, 429, "the global bucket (5) is now empty");
		h.clock.now += 5000;
		assert.equal((await post(h.hook("jira"), "{}")).status, 202, "buckets refill with time");
	});

	it("blocks a client that keeps guessing tokens, even for the right token afterwards", async () => {
		const h = await start({ config: { limits: { authFailuresPerMinute: 3 } } });
		for (let i = 0; i < 3; i++) assert.equal((await post(`${h.publicUrl}/hook/jira/${"y".repeat(43)}`, "{}", { "cf-connecting-ip": "198.51.100.7" })).status, 401);
		assert.equal((await post(h.hook("jira"), "{}", { "cf-connecting-ip": "198.51.100.7" })).status, 429);
		assert.equal((await post(h.hook("jira"), "{}", { "cf-connecting-ip": "198.51.100.8" })).status, 202, "other clients are unaffected");
		h.clock.now += 61_000;
		assert.equal((await post(h.hook("jira"), "{}", { "cf-connecting-ip": "198.51.100.7" })).status, 202);
	});

	it("treats a paused source as unknown and accepts again after resume", async () => {
		const h = await start();
		assert.equal((await fetch(`${h.privateUrl}/v1/sources/jira/pause`, { method: "POST", headers: h.authorized() })).status, 200);
		assert.equal((await post(h.hook("jira"), "{}")).status, 404);
		assert.equal((await fetch(`${h.privateUrl}/v1/sources/jira/resume`, { method: "POST", headers: h.authorized() })).status, 200);
		assert.equal((await post(h.hook("jira"), "{}")).status, 202);
		assert.equal((await fetch(`${h.privateUrl}/v1/sources/nosuch/pause`, { method: "POST", headers: h.authorized() })).status, 404);
	});

	it("never writes a body, a header value or a token to the log", async () => {
		const h = await start();
		await post(h.hook("jira"), "SECRET-BODY-CANARY", { "x-atlassian-webhook-identifier": "HEADER-CANARY" });
		await post(`${h.publicUrl}/hook/jira/${"z".repeat(43)}`, "SECRET-BODY-CANARY");
		const log = h.logs.join("\n");
		assert.ok(log.includes("hook_accepted") && log.includes("hook_rejected"));
		for (const canary of ["SECRET-BODY-CANARY", "HEADER-CANARY", hookToken(SECRET, "jira", 1), "zzzzzzzzzz"]) assert.ok(!log.includes(canary), `log leaked ${canary}`);
	});
});

describe("path suffix and query string", () => {
	const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJmb3JnZSI6MX0.Zm9vYmFyYmF6cXV4";

	it("stores the suffix and the query verbatim and hands them back", async () => {
		const h = await start();
		const query = `access_token=${jwt}&redirect=a%2Bb%3D`;
		assert.equal((await post(h.hook("woodpecker", 1, `/api/hook?${query}`), JSON.stringify({ zen: 1 }), { "x-github-event": "push", "x-hub-signature-256": "sha256=abc" })).status, 202);
		const [item] = (await h.pull()).items;
		assert.equal(item.path, "/api/hook");
		assert.equal(item.query, query, "not decoded, not reordered");
		assert.equal(item.headers["x-github-event"], "push");
	});

	it("keeps the query of a source without suffix too, and an empty path", async () => {
		const h = await start();
		await post(h.hook("jira", 1, "?foo=bar"), "{}");
		await post(h.hook("jira"), "{}");
		const items = (await h.pull()).items;
		assert.deepEqual(items.map((i) => [i.path, i.query]), [["", "foo=bar"], ["", ""]]);
	});

	it("rejects a suffix other than the configured one", async () => {
		const h = await start();
		for (const [source, rest] of [["jira", "/api/hook"], ["woodpecker", "/other"], ["woodpecker", ""], ["woodpecker", "/api/hook/extra"], ["jira", "/"]] as const) {
			assert.equal((await post(h.hook(source, 1, rest), "{}")).status, 404, `${source}${rest}`);
		}
		assert.equal((await post(`${h.publicUrl}/hook/woodpecker/${hookToken(SECRET, "woodpecker", 1)}/api%2Fhook`, "{}")).status, 404, "an encoded slash is not a path separator");
		const raw = (path: string) => new Promise<number>((resolve, reject) => {
			const req = httpRequest({ host: "127.0.0.1", port: new URL(h.publicUrl).port, path, method: "POST" }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
			req.on("error", reject);
			req.end("{}");
		});
		const base = `/hook/woodpecker/${hookToken(SECRET, "woodpecker", 1)}`;
		for (const rest of ["/api/../hook", "/api/./hook", "/./api/hook", "/api//hook"]) assert.equal(await raw(`${base}${rest}`), 404, `a raw request for ${rest} is not normalised into the configured suffix`);
		assert.equal((await h.pull()).items.length, 0);
		assert.equal((await post(h.hook("woodpecker", 1, "/api/hook"), "{}")).status, 202);
	});

	it("still checks the token before looking at the suffix, and counts guessing", async () => {
		const h = await start({ config: { limits: { authFailuresPerMinute: 2 } } });
		assert.equal((await post(`${h.publicUrl}/hook/woodpecker/${"q".repeat(43)}/api/hook?access_token=x`, "{}")).status, 401);
		assert.equal((await post(`${h.publicUrl}/hook/woodpecker/${"q".repeat(43)}/api/hook?access_token=x`, "{}")).status, 401);
		assert.equal((await post(h.hook("woodpecker", 1, "/api/hook?access_token=x"), "{}")).status, 429);
	});

	it("refuses an absurdly long query", async () => {
		const h = await start();
		assert.equal((await post(h.hook("jira", 1, `?${"a".repeat(5000)}`), "{}")).status, 414);
		assert.equal((await post(h.hook("jira", 1, `?${"a".repeat(4096)}`), "{}")).status, 202);
	});

	it("never writes the suffix or the query to the log", async () => {
		const h = await start();
		await post(h.hook("woodpecker", 1, `/api/hook?access_token=${jwt}`), "{}");
		await post(h.hook("woodpecker", 1, `/nope?access_token=${jwt}`), "{}");
		await post(`${h.publicUrl}/hook/woodpecker/${"z".repeat(43)}/api/hook?access_token=${jwt}`, "{}");
		const log = h.logs.join("\n");
		assert.ok(log.includes("hook_accepted") && log.includes("hook_rejected"));
		for (const secret of [jwt, "access_token", "/api/hook", "/nope"]) assert.ok(!log.includes(secret), `log leaked ${secret}`);
	});

	it("survives a restart, and opens a queue written before these columns existed", async () => {
		const dir = mkdtempSync(join(tmpdir(), "receiver-columns-"));
		try {
			const old = new DatabaseSync(join(dir, "queue.sqlite"));
			old.exec("CREATE TABLE items (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, source TEXT NOT NULL, received_at INTEGER NOT NULL, headers TEXT NOT NULL, body BLOB NOT NULL); CREATE TABLE source_state (name TEXT PRIMARY KEY, paused INTEGER NOT NULL);");
			old.prepare("INSERT INTO items(id, source, received_at, headers, body) VALUES ('a', 'jira', 1, '{}', x'7b7d')").run();
			old.close();
			const first = await start({ dir });
			assert.deepEqual((await first.pull()).items.map((i) => [i.id, i.path, i.query]), [["a", "", ""]]);
			await post(first.hook("woodpecker", 1, `/api/hook?access_token=${jwt}`), "{}");
			await first.stop();
			open.pop();
			const second = await start({ dir });
			const items = (await second.pull()).items;
			assert.deepEqual(items.map((i) => [i.path, i.query]), [["", ""], ["/api/hook", `access_token=${jwt}`]]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("the private pull side", () => {
	it("requires the pull bearer token", async () => {
		const h = await start();
		assert.equal((await fetch(`${h.privateUrl}/v1/pull`)).status, 401);
		assert.equal((await fetch(`${h.privateUrl}/v1/pull`, { headers: { authorization: "Bearer nope" } })).status, 401);
		assert.equal((await fetch(`${h.privateUrl}/v1/stats`)).status, 401);
		assert.equal((await fetch(`${h.privateUrl}/healthz`)).status, 200);
	});

	it("resumes after a cursor, acknowledges, and never reuses a sequence number", async () => {
		const h = await start();
		for (const n of [1, 2, 3]) await post(h.hook("jira"), `{"n":${n}}`);
		const all = (await h.pull()).items;
		assert.deepEqual(all.map((i) => i.seq), [1, 2, 3]);
		assert.deepEqual((await h.pull(2)).items.map((i) => i.seq), [3]);
		assert.equal(((await (await h.ack(2)).json()) as { removed: number }).removed, 2);
		assert.deepEqual((await h.pull()).items.map((i) => i.seq), [3]);
		await h.ack(3);
		await post(h.hook("jira"), `{"n":4}`);
		assert.deepEqual((await h.pull()).items.map((i) => i.seq), [4], "an acked sequence number is never handed out again");
		assert.equal((await h.ack(-1)).status, 400);
	});

	it("long-polls: returns early when an item arrives and empty on timeout", async () => {
		const h = await start();
		const started = Date.now();
		const waiting = h.pull(0, 5);
		setTimeout(() => void post(h.hook("jira"), "{}"), 150);
		assert.equal((await waiting).items.length, 1);
		assert.ok(Date.now() - started < 3000);
		const idle = Date.now();
		assert.equal((await h.pull(1, 1)).items.length, 0);
		assert.ok(Date.now() - idle >= 900);
	});

	it("reports stats", async () => {
		const h = await start();
		await post(h.hook("jira"), "{}");
		h.clock.now += 90_000;
		const stats = (await (await fetch(`${h.privateUrl}/v1/stats`, { headers: h.authorized() })).json()) as any;
		assert.equal(stats.queued, 1);
		assert.equal(stats.oldestAgeSeconds, 90);
		assert.equal(stats.sources.jira.accepted, 1);
		assert.equal(stats.lastSeq, 1);
	});
});

describe("durability", () => {
	it("keeps accepted webhooks across a restart and purges after the retention", async () => {
		const dir = mkdtempSync(join(tmpdir(), "receiver-restart-"));
		try {
			const first = await start({ dir });
			assert.equal((await post(first.hook("jira"), `{"survives":true}`)).status, 202);
			await first.stop();
			open.pop();

			const second = await start({ dir });
			const items = (await second.pull()).items;
			assert.equal(items.length, 1);
			assert.equal(Buffer.from(items[0].bodyBase64, "base64").toString(), `{"survives":true}`);
			await post(second.hook("jira"), `{"after":true}`);
			assert.deepEqual((await second.pull()).items.map((i) => i.seq), [1, 2]);

			second.clock.now += 25 * 3_600_000;
			assert.equal(second.queue.purge(24 * 3_600_000), 2);
			assert.equal((await second.pull()).items.length, 0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps the paused state across a restart", async () => {
		const dir = mkdtempSync(join(tmpdir(), "receiver-paused-"));
		try {
			const first = await start({ dir });
			first.queue.setPaused("jira", true);
			await first.stop();
			open.pop();
			const second = await start({ dir });
			assert.equal((await post(second.hook("jira"), "{}")).status, 404);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

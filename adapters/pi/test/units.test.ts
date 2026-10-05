import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { FileCredentialStore } from "../src/credentials.ts";
import { GitHubHost, parseGitHubRepo } from "../src/githost.ts";
import { DailyLedger } from "../src/ledger.ts";
import { redact } from "../src/log.ts";
import { Metrics } from "../src/metrics.ts";
import { describeEvent } from "../src/pi-runtime.ts";
import { ownerOf, ownsKey, shardOf, validateTable, type ShardTable } from "../src/shards.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "pi-units-"));

describe("shards", () => {
	it("maps a key to the same shard every time and spreads keys evenly", () => {
		assert.equal(shardOf("acme/payments#7"), shardOf("acme/payments#7"));
		const counts = new Array(64).fill(0);
		for (let i = 0; i < 20_000; i++) counts[shardOf(`repo-${i}#${i % 13}`)]++;
		assert.ok(Math.min(...counts) > 200 && Math.max(...counts) < 450, `uneven: ${Math.min(...counts)}..${Math.max(...counts)}`);
	});

	const table: ShardTable = { shardCount: 64, owners: { "agent/pi-a": [[0, 31]], "agent/pi-b": [[32, 63]] } };
	it("routes every key to exactly one owner and agrees with ownership checks", () => {
		validateTable(table);
		for (let i = 0; i < 500; i++) {
			const key = `k${i}`;
			const owner = ownerOf(table, key);
			assert.equal(ownsKey(table, owner, key), true);
			assert.equal(ownsKey(table, owner === "agent/pi-a" ? "agent/pi-b" : "agent/pi-a", key), false);
		}
	});

	it("moving a shard range moves only the keys of those shards", () => {
		const before = new Map(Array.from({ length: 2000 }, (_, i) => [`k${i}`, ownerOf(table, `k${i}`)]));
		const moved: ShardTable = { shardCount: 64, owners: { "agent/pi-a": [[0, 23]], "agent/pi-b": [[32, 63]], "agent/pi-c": [[24, 31]] } };
		validateTable(moved);
		for (const [key, owner] of before) {
			const now = ownerOf(moved, key);
			if (shardOf(key) >= 24 && shardOf(key) <= 31) assert.equal(now, "agent/pi-c");
			else assert.equal(now, owner, "keys outside the moved shards keep their owner");
		}
	});

	it("rejects overlapping, out-of-range and incomplete tables", () => {
		assert.throws(() => validateTable({ shardCount: 4, owners: { a: [[0, 2]], b: [[2, 3]] } }), /owned by both/);
		assert.throws(() => validateTable({ shardCount: 4, owners: { a: [[0, 9]] } }), /invalid shard range/);
		assert.throws(() => validateTable({ shardCount: 4, owners: { a: [[0, 1]] } }), /without an owner/);
	});
});

describe("daily ledger", () => {
	it("persists spend, caps the remainder and starts over on a new day", () => {
		const path = join(tmp(), "ledger.json");
		let day = "2026-10-05";
		const ledger = new DailyLedger(path, 1000, () => day);
		ledger.record(400);
		assert.equal(new DailyLedger(path, 1000, () => day).remaining(), 600, "a restart keeps the spend");
		ledger.record(900);
		assert.equal(ledger.remaining(), 0);
		day = "2026-10-06";
		assert.equal(ledger.remaining(), 1000);
	});
});

describe("credential store", () => {
	it("reads, lists and serializes concurrent modifications; the file stays 0600", async () => {
		const path = join(tmp(), "auth.json");
		writeFileSync(path, JSON.stringify({ "openai-codex": { type: "oauth", access: "a0", refresh: "r0", expires: 1 } }));
		const store = new FileCredentialStore(path);
		assert.deepEqual(await store.list(), [{ providerId: "openai-codex", type: "oauth" }]);
		await Promise.all(
			[1, 2, 3, 4, 5].map((n) =>
				store.modify("openai-codex", async (current) => {
					await new Promise((r) => setTimeout(r, 10));
					return { ...(current as any), access: `a${n}`, counter: ((current as any).counter ?? 0) + 1 };
				}),
			),
		);
		const final = JSON.parse(readFileSync(path, "utf8"))["openai-codex"];
		assert.equal(final.counter, 5, "no lost update: refreshes are serialized");
		assert.equal(statSync(path).mode & 0o777, 0o600);
		await store.delete("openai-codex");
		assert.equal(await store.read("openai-codex"), undefined);
	});
});

describe("metrics and log redaction", () => {
	it("renders counters, gauges and histograms in Prometheus text", () => {
		const metrics = new Metrics();
		const jobs = metrics.counter("jobs_total", "jobs");
		const active = metrics.gauge("active_jobs", "active");
		const duration = metrics.histogram("job_seconds", "duration", [1, 10]);
		jobs({ status: "done" });
		jobs({ status: "done" }, 2);
		active.set(3);
		duration(0.5, { status: "done" });
		duration(5, { status: "done" });
		const text = metrics.render();
		assert.match(text, /jobs_total\{status="done"\} 3/);
		assert.match(text, /active_jobs 3/);
		assert.match(text, /job_seconds_bucket\{status="done",le="1"\} 1/);
		assert.match(text, /job_seconds_bucket\{status="done",le="10"\} 2/);
		assert.match(text, /job_seconds_count\{status="done"\} 2/);
	});

	it("never logs prompts, file contents, commands, tokens or long strings", () => {
		const out = redact({ taskId: "t1", prompt: "fix the bug in secret.rs", command: "cat /etc/passwd", token: "ghp_x", env: { A: "b" }, note: "x".repeat(500), count: 3 });
		assert.equal(out.taskId, "t1");
		assert.equal(out.prompt, "[redacted]");
		assert.equal(out.command, "[redacted]");
		assert.equal(out.token, "[redacted]");
		assert.equal(out.env, "[redacted]");
		assert.match(String(out.note), /\[500 chars\]$/);
		assert.equal(out.count, 3);
	});

	it("turns agent events into progress without any content", () => {
		assert.deepEqual(describeEvent({ type: "tool_execution_start", toolName: "bash", args: { command: "secret" } }), { message: "tool: bash" });
		assert.equal(describeEvent({ type: "message_update", delta: "text" }), undefined);
	});
});

describe("GitHub host", () => {
	it("finds an existing pull request, creates one otherwise, and sends the token as a bearer", async () => {
		const seen: { method: string; url: string; auth?: string; body?: string }[] = [];
		const open = new Set<string>();
		const server = createServer((req, res) => {
			let body = "";
			req.on("data", (c) => (body += c));
			req.on("end", () => {
				seen.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, body });
				res.setHeader("content-type", "application/json");
				if (req.method === "GET") return res.end(JSON.stringify(open.has(decodeURIComponent(req.url!)) ? [{ html_url: "https://github.test/o/r/pull/1" }] : []));
				open.add(decodeURIComponent("/repos/o/r/pulls?state=open&head=o:agent/t1"));
				res.statusCode = 201;
				res.end(JSON.stringify({ html_url: "https://github.test/o/r/pull/1" }));
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const host = new GitHubHost({ token: "tok", apiBase: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
		const query = { repoUrl: "https://github.com/o/r.git", head: "agent/t1" };
		assert.equal(await host.findPullRequest(query), undefined);
		const created = await host.createPullRequest({ ...query, base: "main", title: "t", body: "b" });
		assert.equal(created?.url, "https://github.test/o/r/pull/1");
		assert.equal((await host.findPullRequest(query))?.url, "https://github.test/o/r/pull/1");
		assert.ok(seen.every((call) => call.auth === "Bearer tok"));
		assert.deepEqual(JSON.parse(seen.find((c) => c.method === "POST")!.body!), { head: "agent/t1", base: "main", title: "t", body: "b", draft: false });
		server.close();
	});

	it("opens draft pull requests when configured", async () => {
		const bodies: any[] = [];
		const server = createServer((req, res) => {
			let body = "";
			req.on("data", (c) => (body += c));
			req.on("end", () => {
				bodies.push(JSON.parse(body));
				res.statusCode = 201;
				res.end(JSON.stringify({ html_url: "https://github.test/o/r/pull/2" }));
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const host = new GitHubHost({ token: "tok", draft: true, apiBase: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
		await host.createPullRequest({ repoUrl: "https://github.com/o/r.git", head: "agent/t2", base: "main", title: "t", body: "b" });
		assert.equal(bodies[0].draft, true);
		server.close();
	});

	it("parses https and ssh GitHub URLs and rejects others", () => {
		assert.deepEqual(parseGitHubRepo("https://github.com/acme/payments.git"), { owner: "acme", repo: "payments" });
		assert.deepEqual(parseGitHubRepo("git@github.com:acme/payments.git"), { owner: "acme", repo: "payments" });
		assert.throws(() => parseGitHubRepo("https://example.com/x/y"), /not a GitHub/);
	});
});

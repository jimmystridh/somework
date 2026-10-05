import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { after, before, describe, it } from "node:test";
import { SomeWorkClient, SomeWorkError } from "../src/client.ts";
import { ContractError, parseRuleList, parseRuleView, validatePublish, validateRuleSpec, whereMatches, type RuleSpec } from "../src/events.ts";
import { Identity } from "../src/identity.ts";
import { parsePointer, renderTemplate, resolvePointer, TemplateError, templatePointers } from "../src/rule-template.ts";

const keyFile = { kind: "service", id: "producer/github", domainId: "development", privateKey: Buffer.alloc(32, 9).toString("base64url"), publicKey: "" };

interface Seen {
	method: string;
	path: string;
	body: any;
	authorization?: string;
	idempotencyKey?: string;
}

let server: Server;
let baseUrl: string;
const seen: Seen[] = [];
let answer: (request: Seen) => { status: number; body?: unknown } = () => ({ status: 200, body: {} });

before(async () => {
	server = createServer((req: IncomingMessage, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			const raw = Buffer.concat(chunks).toString();
			const request: Seen = { method: req.method!, path: req.url!, body: raw === "" ? undefined : JSON.parse(raw), authorization: req.headers.authorization, idempotencyKey: req.headers["idempotency-key"] as string | undefined };
			seen.push(request);
			const { status, body } = answer(request);
			res.writeHead(status, { "content-type": "application/json" });
			res.end(body === undefined ? "" : JSON.stringify(body));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(() => server.close());

const client = () => new SomeWorkClient({ baseUrl, identity: new Identity(keyFile), retries: 1 });

const event = { topic: "github.pull_request.opened", key: "delivery-1", source: "github", data: { number: 7 }, classification: "internal", verified: true };

const rule: RuleSpec = {
	description: "Review every opened pull request",
	owner: "automation/pr-review",
	selector: "github.pull_request.opened",
	where: [{ path: "/data/draft", equals: false }],
	wake: false,
	reaction: {
		capability: { id: "code.review", version: 3 },
		input: { pullRequest: "${/data/number}" },
		budget: { maxTokens: 200000, maxMinutes: 20 },
	},
};

const view = (overrides: object = {}) => ({ name: "pr-review", ...rule, status: "active", createdAt: "2026-10-05T10:00:00Z", updatedAt: "2026-10-05T10:00:00Z", lastFiredAt: null, counters: { fired: 2, skipped: { duplicate: 1 } }, ...overrides });

describe("publishEvent", () => {
	it("posts the event signed, with an idempotency key, and reads the answer", async () => {
		seen.length = 0;
		answer = () => ({ status: 200, body: { seq: 12, eventId: "evt_1", duplicate: false } });
		const result = await client().publishEvent(event);
		assert.deepEqual(result, { seq: 12, eventId: "evt_1", duplicate: false });
		assert.equal(seen[0]!.method, "POST");
		assert.equal(seen[0]!.path, "/v1/events/publish");
		assert.match(seen[0]!.authorization!, /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
		assert.equal(seen[0]!.idempotencyKey, "event:github.pull_request.opened:delivery-1");
		assert.deepEqual(seen[0]!.body, event);
	});

	it("reports a duplicate as a duplicate", async () => {
		answer = () => ({ status: 200, body: { seq: 12, eventId: "evt_1", duplicate: true } });
		assert.equal((await client().publishEvent(event)).duplicate, true);
	});

	it("retries a 503 because the key makes the publish idempotent", async () => {
		seen.length = 0;
		let calls = 0;
		answer = () => (++calls === 1 ? { status: 503, body: { code: "unavailable", detail: "busy" } } : { status: 200, body: { seq: 1, eventId: "evt_2", duplicate: false } });
		assert.equal((await client().publishEvent(event)).eventId, "evt_2");
		assert.equal(seen.length, 2);
	});

	it("turns a domain refusal into a SomeWorkError with the problem code", async () => {
		answer = () => ({ status: 403, body: { code: "permission_denied", detail: "events.publish:github.* does not cover jira.issue.created" } });
		await assert.rejects(client().publishEvent({ ...event, topic: "jira.issue.created" }), (error: unknown) => error instanceof SomeWorkError && error.status === 403 && error.code === "permission_denied");
	});

	it("rejects an event that breaks the contract before sending anything", async () => {
		seen.length = 0;
		for (const bad of [
			{ ...event, topic: "github.pull_request" },
			{ ...event, topic: "GitHub.pull_request.opened" },
			{ ...event, key: "" },
			{ ...event, key: "k".repeat(201) },
			{ ...event, source: "Git Hub" },
			{ ...event, data: { blob: "x".repeat(70_000) } },
			{ ...event, data: [] as unknown as object },
			{ ...event, classification: "Internal!" },
			{ ...event, occurredAt: "yesterday" },
		]) {
			await assert.rejects(client().publishEvent(bad as never), ContractError);
		}
		assert.equal(seen.length, 0);
	});

	it("refuses a malformed answer", async () => {
		answer = () => ({ status: 200, body: { ok: true } });
		await assert.rejects(client().publishEvent(event), ContractError);
	});

	it("accepts a topic of exactly 200 characters and refuses 201", () => {
		const topic = (length: number) => `github.${"a".repeat(length - "github.x.".length)}.x`;
		assert.equal(topic(200).length, 200);
		validatePublish({ ...event, topic: topic(200) });
		assert.throws(() => validatePublish({ ...event, topic: topic(201) }), ContractError);
	});
});

describe("rules", () => {
	it("lists rules from either answer shape and normalises missing counters and where", async () => {
		answer = () => ({ status: 200, body: { rules: [view(), view({ name: "bare", where: undefined, counters: undefined, description: undefined })] } });
		const rules = await client().listRules();
		assert.equal(rules.length, 2);
		assert.deepEqual(rules[1]!.where, []);
		assert.equal(rules[1]!.counters.skipped.rate, 0);
		assert.equal(rules[0]!.counters.skipped.duplicate, 1);
		assert.equal(parseRuleList([view()]).length, 1);
	});

	it("refuses an unexpected list or rule shape", async () => {
		answer = () => ({ status: 200, body: { items: [] } });
		await assert.rejects(client().listRules(), /unexpected answer/);
		assert.throws(() => parseRuleView(view({ status: "running" })), /unexpected rule shape/);
		assert.throws(() => parseRuleView(null), /unexpected rule shape/);
	});

	it("puts, gets, pauses, resumes and deletes through the documented paths", async () => {
		seen.length = 0;
		answer = (request) => ({ status: request.method === "DELETE" ? 204 : 200, body: request.method === "DELETE" ? undefined : view({ status: request.path.endsWith("/pause") ? "paused" : "active" }) });
		const c = client();
		assert.equal((await c.putRule("pr-review", rule)).name, "pr-review");
		await c.getRule("pr-review");
		assert.equal((await c.pauseRule("pr-review")).status, "paused");
		assert.equal((await c.resumeRule("pr-review")).status, "active");
		await c.deleteRule("pr-review");
		assert.deepEqual(
			seen.map((s) => `${s.method} ${s.path}`),
			["PUT /v1/rules/pr-review", "GET /v1/rules/pr-review", "POST /v1/rules/pr-review/pause", "POST /v1/rules/pr-review/resume", "DELETE /v1/rules/pr-review"],
		);
		assert.deepEqual(seen[0]!.body, rule);
	});

	it("rejects a bad name or a rule that breaks the contract before sending", async () => {
		seen.length = 0;
		const c = client();
		await assert.rejects(c.putRule("../etc", rule), ContractError);
		await assert.rejects(c.putRule("Bad Name", rule), ContractError);
		for (const bad of [
			{ ...rule, owner: "pr-review" },
			{ ...rule, selector: "*" },
			{ ...rule, selector: "github.**" },
			{ ...rule, wake: undefined },
			{ ...rule, reaction: undefined, wake: false },
			{ ...rule, reaction: { ...rule.reaction!, budget: undefined } },
			{ ...rule, reaction: { ...rule.reaction!, maxDepth: 0 } },
			{ ...rule, reaction: { ...rule.reaction!, maxFiringsPerHour: 5000 } },
			{ ...rule, reaction: { ...rule.reaction!, input: { a: "${/data/x" } } },
			{ ...rule, where: [{ path: "data/draft", equals: false }] },
			{ ...rule, where: [{ path: "/data/draft", equals: { a: 1 } }] },
			{ ...rule, status: "running" },
		]) {
			assert.throws(() => validateRuleSpec(bad as never), ContractError, JSON.stringify(bad).slice(0, 80));
		}
		assert.equal(seen.length, 0);
	});

	it("accepts an agent subscription (wake without reaction)", () => {
		validateRuleSpec({ owner: "agent/manager", selector: "grafana.alert.firing", wake: true });
	});
});

describe("rule templates", () => {
	const payload = { topic: "github.pull_request.opened", data: { number: 42, draft: false, title: "Fix ${/data/number}", labels: ["a", "b"], repo: { url: "https://x/y.git" }, "a/b": 1, "m~n": 2, empty: null } };

	it("substitutes a whole-string reference with the typed value and an embedded one with text", () => {
		const out = renderTemplate({ n: "${/data/number}", flag: "${/data/draft}", ref: "refs/pull/${/data/number}/head", labels: "${/data/labels}", nested: { url: "${/data/repo/url}" }, list: ["${/data/labels/1}", "x"], keep: 5 }, payload) as any;
		assert.deepEqual(out, { n: 42, flag: false, ref: "refs/pull/42/head", labels: ["a", "b"], nested: { url: "https://x/y.git" }, list: ["b", "x"], keep: 5 });
	});

	it("does not interpret substituted text again", () => {
		assert.equal(renderTemplate("t=${/data/title}", payload), "t=Fix ${/data/number}");
	});

	it("handles pointer escapes, null values and array indexes", () => {
		assert.deepEqual(parsePointer("/a~1b/m~0n"), ["a/b", "m~n"]);
		assert.equal(renderTemplate("${/data/a~1b}", payload), 1);
		assert.equal(renderTemplate("${/data/m~0n}", payload), 2);
		assert.equal(renderTemplate("${/data/empty}", payload), null);
		assert.equal(renderTemplate("x=${/data/empty}", payload), "x=null");
		assert.equal(resolvePointer(payload, "/data/labels/2").found, false);
		assert.equal(resolvePointer(payload, "/data/labels/01").found, false);
	});

	it("fails the whole rendering when a pointer resolves to nothing", () => {
		assert.throws(() => renderTemplate({ a: "${/data/missing}" }, payload), TemplateError);
		assert.throws(() => renderTemplate("${/data/number/x}", payload), TemplateError);
	});

	it("rejects malformed references", () => {
		assert.throws(() => templatePointers("${/data/x"), TemplateError);
		assert.throws(() => templatePointers("${data/x}"), TemplateError);
		assert.throws(() => templatePointers("${/a~2b}"), TemplateError);
		assert.deepEqual(templatePointers({ a: ["${/x}", "${/y} and ${/z}"] }), ["/x", "/y", "/z"]);
	});

	it("evaluates where as an and over typed equality", () => {
		assert.equal(whereMatches([{ path: "/data/draft", equals: false }, { path: "/data/number", equals: 42 }], payload), true);
		assert.equal(whereMatches([{ path: "/data/number", equals: "42" }], payload), false);
		assert.equal(whereMatches([{ path: "/data/missing", equals: null }], payload), false);
		assert.equal(whereMatches(undefined, payload), true);
	});
});

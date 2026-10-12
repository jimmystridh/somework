import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { CiClient, CiError, createCiTools, readTokenFile, stepsOf, summarisePipeline } from "../src/tools/ci.ts";
import { boundary, callTool, toolNamed } from "./support.ts";

const TOKEN = "woodpecker-token-0123456789abcdef";

interface Request {
	url: string;
	method: string;
	headers: Record<string, string>;
}

const pipeline = (number: number, over: Record<string, unknown> = {}) => ({ number, status: "success", event: "push", branch: "main", commit: `abcdef0123456789${number}`, message: `change ${number}\nsecond line`, started: 1_760_000_000 + number * 100, finished: 1_760_000_060 + number * 100, ...over });
const detail = (number: number) => ({
	...pipeline(number, { status: "failure" }),
	workflows: [{ id: 1, name: "check", children: [{ id: 11, pid: 1, name: "install", state: "success", exit_code: 0, started: 1, finished: 5 }, { id: 12, pid: 2, name: "test", state: "failure", exit_code: 1, started: 5, finished: 65 }] }],
});
const logEntries = (lines: string[]) => lines.map((line, index) => ({ id: index, step_id: 12, time: index, line: index, data: Buffer.from(`${line}\n`).toString("base64"), type: 1 }));

/** A Woodpecker that answers the read endpoints and records every request. */
function woodpecker(over: Record<string, (url: URL) => { status?: number; body?: unknown }> = {}) {
	const requests: Request[] = [];
	const answers: Record<string, (url: URL) => { status?: number; body?: unknown }> = {
		"/api/repos/lookup/acme/somework": () => ({ body: { id: 7, full_name: "acme/somework" } }),
		"/api/repos/7/pipelines": (url) => ({ body: Array.from({ length: Math.min(Number(url.searchParams.get("perPage")), 5) }, (_, i) => pipeline(40 - i)) }),
		"/api/repos/7/pipelines/40": () => ({ body: detail(40) }),
		"/api/repos/7/logs/40/12": () => ({ body: logEntries(["> npm test", "not ok 1 - something broke", `leaked ${TOKEN}`, "GIT_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789"]) }),
		...over,
	};
	const fetch = (async (input: URL | string, init?: RequestInit) => {
		const url = new URL(String(input));
		requests.push({ url: url.href, method: init?.method ?? "GET", headers: Object.fromEntries(new Headers(init?.headers).entries()) });
		const answer = answers[url.pathname]?.(url) ?? { status: 404, body: {} };
		return new Response(JSON.stringify(answer.body ?? {}), { status: answer.status ?? 200, headers: { "content-type": "application/json" } });
	}) as typeof fetch;
	return { fetch, requests };
}

function setup(over: Parameters<typeof woodpecker>[0] = {}) {
	const world = woodpecker(over);
	const client = new CiClient({ url: "https://ci.internal:8443", repository: "acme/somework", token: () => TOKEN, fetch: world.fetch });
	const logs: string[] = [];
	const tools = createCiTools({ client, secrets: () => [TOKEN], boundary, log: (_level, event) => void logs.push(event) });
	const extension = { tools };
	return { ...world, client, logs, pipelines: (args: Record<string, unknown>) => callTool(toolNamed(extension, "ci_pipelines"), args), logsOf: (args: Record<string, unknown>) => callTool(toolNamed(extension, "ci_logs"), args) };
}

describe("ci_pipelines", () => {
	it("lists recent pipelines, newest first, with what a developer looks for", async () => {
		const { pipelines, requests } = setup();
		const { text, isError } = await pipelines({ limit: 3 });
		assert.equal(isError, false);
		assert.match(text, /^<<<CLUSTER-0123456789abcdef \(Woodpecker pipelines: untrusted data/);
		assert.match(text, /#40 success push main abcdef012345 started 2025-10-09T\S+ took 60s "change 40 second line"/);
		assert.match(text, /#38 /);
		assert.ok(!/#37 /.test(text), "the limit holds");
		assert.deepEqual(requests.map((request) => new URL(request.url).pathname), ["/api/repos/lookup/acme/somework", "/api/repos/7/pipelines"]);
	});

	it("shows one pipeline with its steps", async () => {
		const { pipelines } = setup();
		const { text } = await pipelines({ number: 40 });
		assert.match(text, /#40 failure push main/);
		assert.match(text, /step 11 install: success \(exit 0\) took 4s/);
		assert.match(text, /step 12 test: failure \(exit 1\) took 60s/);
	});

	it("only ever reads, with the token as a bearer header and nowhere else, to the one origin", async () => {
		const { pipelines, logsOf, requests } = setup();
		await pipelines({});
		await pipelines({ number: 40 });
		await logsOf({ number: 40, step: "test" });
		assert.ok(requests.length >= 5);
		for (const request of requests) {
			assert.equal(request.method, "GET");
			assert.equal(request.headers.authorization, `Bearer ${TOKEN}`);
			assert.equal(new URL(request.url).origin, "https://ci.internal:8443");
			assert.ok(!request.url.includes(TOKEN), "the token is never in a URL");
		}
	});

	it("looks the repository up once and uses a numeric repository id as it is", async () => {
		const { pipelines, requests } = setup();
		await pipelines({});
		await pipelines({});
		assert.equal(requests.filter((request) => request.url.includes("/lookup/")).length, 1);
		const world = woodpecker();
		const client = new CiClient({ url: "https://ci.internal:8443", repository: "7", token: () => TOKEN, fetch: world.fetch });
		await client.listPipelines(2);
		assert.ok(!world.requests.some((request) => request.url.includes("/lookup/")));
	});

	it("reports an unreachable, refusing or failing CI as a readable error without the token", async () => {
		for (const [status, pattern] of [[401, /refused the token/], [403, /refused the token/], [404, /no such thing/], [500, /answered 500/], [302, /redirect/]] as const) {
			const { pipelines, logs } = setup({ "/api/repos/7/pipelines": () => ({ status, body: { message: `bad ${TOKEN}` } }) });
			const { text, isError } = await pipelines({});
			assert.equal(isError, true, String(status));
			assert.match(text, pattern, String(status));
			assert.ok(!text.includes(TOKEN));
			assert.ok(logs.includes("ci_tool_failed"));
		}
		const down = new CiClient({ url: "https://ci.internal:8443", repository: "7", token: () => TOKEN, fetch: (async () => Promise.reject(new Error(`connect ECONNREFUSED with ${TOKEN}`))) as never });
		const tools = createCiTools({ client: down, secrets: () => [TOKEN], boundary });
		const { text, isError } = await callTool(toolNamed({ tools }, "ci_pipelines"), {});
		assert.equal(isError, true);
		assert.match(text, /could not be reached/);
		assert.ok(!text.includes(TOKEN));
	});

	it("says so when CI is not configured", async () => {
		const tools = createCiTools({ client: undefined, boundary });
		for (const name of ["ci_pipelines", "ci_logs"]) {
			const { text, isError } = await callTool(toolNamed({ tools }, name), { number: 1, step: "x" });
			assert.equal(isError, true);
			assert.match(text, /CI is not configured/);
		}
	});

	it("has exactly two tools and both are replay-safe", () => {
		const tools = createCiTools({ client: undefined });
		assert.deepEqual(tools.map((tool) => tool.name), ["ci_pipelines", "ci_logs"]);
		for (const tool of tools) assert.equal(tool.replay, "safe");
	});
});

describe("ci_logs", () => {
	it("finds a step by name or id, decodes the log, takes the secrets out and frames it", async () => {
		const { logsOf } = setup();
		for (const step of ["test", 12, "12"]) {
			const { text, isError } = await logsOf({ number: 40, step });
			assert.equal(isError, false);
			assert.match(text, /Woodpecker log of test in pipeline 40, 4 of 4 lines/);
			assert.match(text, /not ok 1 - something broke/);
			assert.ok(!text.includes(TOKEN), "the CI token is scrubbed");
			assert.ok(!text.includes("ghp_abcdefghijkl"), "token-shaped text is scrubbed");
			assert.match(text, /untrusted data from a machine or system/);
		}
	});

	it("shows the last lines only", async () => {
		const { logsOf } = setup({ "/api/repos/7/logs/40/12": () => ({ body: logEntries(Array.from({ length: 50 }, (_, i) => `line ${i}`)) }) });
		const { text } = await logsOf({ number: 40, step: "test", tail: 3 });
		assert.match(text, /3 of 50 lines/);
		assert.match(text, /line 49/);
		assert.match(text, /line 47/);
		assert.ok(!/line 46\b/.test(text));
	});

	it("lists the steps when the name is wrong", async () => {
		const { logsOf } = setup();
		const { text } = await logsOf({ number: 40, step: "deploy" });
		assert.match(text, /no step "deploy" in pipeline 40. Steps: 11 install, 12 test/);
	});

	it("cuts a huge log to the size limit, keeping the end", async () => {
		const { logsOf } = setup({ "/api/repos/7/logs/40/12": () => ({ body: logEntries([...Array.from({ length: 1000 }, (_, i) => `noise line number ${i} `.repeat(4)), "THE LAST LINE"]) }) });
		const { text } = await logsOf({ number: 40, step: "test", tail: 1000 });
		assert.ok(Buffer.byteLength(text) < 14_000, `${Buffer.byteLength(text)}`);
		assert.match(text, /THE LAST LINE/);
		assert.match(text, /earlier bytes not shown/);
	});
});

describe("the CI client and its parts", () => {
	it("reads the steps from workflows, or from a flat list on an older server", () => {
		assert.deepEqual(stepsOf(detail(40)).map((step) => [step.id, step.name, step.state, step.exitCode]), [[11, "install", "success", 0], [12, "test", "failure", 1]]);
		assert.deepEqual(stepsOf({ steps: [{ id: 5, name: "build", state: "running" }] }).map((step) => step.name), ["build"]);
		assert.deepEqual(stepsOf({}), []);
		assert.equal(summarisePipeline({}).status, "unknown");
	});

	it("refuses to call another host and to follow a redirect", async () => {
		const client = new CiClient({ url: "https://ci.internal:8443", repository: "7", token: () => TOKEN, fetch: (async () => new Response(null, { status: 302, headers: { location: "https://evil.example" } })) as never });
		await assert.rejects(client.listPipelines(1), /redirect/);
	});

	it("reads the token from a file at the time of each call and never quotes the file", () => {
		const dir = mkdtempSync(join(tmpdir(), "ci-token-"));
		const file = join(dir, "token");
		writeFileSync(file, `${TOKEN}\n`);
		assert.equal(readTokenFile(file)(), TOKEN);
		writeFileSync(file, "x");
		assert.throws(() => readTokenFile(file)(), CiError);
		assert.throws(() => readTokenFile(join(dir, "missing"))(), /cannot be read/);
	});
});

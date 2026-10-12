import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { agentStatus, commitOfVersion, createDeployStatus, summariseStatus } from "../src/tools/deploy-status.ts";
import { boundary, callTool, settingsFor } from "./support.ts";

type Answer = { status?: number; body?: unknown; fail?: string };

/** The health ports of two agents: the reviewer is ready on a CI build, the developer is not ready and on an older one. */
function health(over: Record<string, Record<string, Answer>> = {}) {
	const requests: string[] = [];
	const table: Record<string, Record<string, Answer>> = {
		"http://10.10.10.20:8082": {
			"/ready": { body: { ready: true, failed: [], jobs: [{ id: "a" }], pools: { chat: { used: 1 } } } },
			"/status": { body: { handlers: 2, jobs: [], pools: { chat: { used: 1 } }, long_note: "x".repeat(200) } },
			"/profile": { body: { role: "reviewer", version: "ci-1a2b3c4d5e6f" } },
		},
		"http://10.10.10.20:8081": {
			"/ready": { status: 503, body: { ready: false, failed: ["sandbox"] } },
			"/status": { body: { handlers: 0 } },
			"/profile": { body: { role: "developer", version: "pilot-1" } },
		},
		...over,
	};
	const fetch = (async (input: URL | string, init?: RequestInit) => {
		const url = new URL(String(input));
		requests.push(`${init?.method ?? "GET"} ${url.origin}${url.pathname}`);
		assert.equal(init?.redirect, "manual", "redirects are not followed");
		const answer = table[url.origin]?.[url.pathname];
		if (!answer) return new Response("{}", { status: 404 });
		if (answer.fail) throw new Error(answer.fail);
		return new Response(JSON.stringify(answer.body ?? {}), { status: answer.status ?? 200 });
	}) as typeof fetch;
	return { fetch, requests };
}

const setup = (over: Parameters<typeof health>[0] = {}) => {
	const world = health(over);
	const tool = createDeployStatus({ settings: settingsFor(), fetch: world.fetch, secrets: () => ["supersecretvalue"], boundary });
	return { ...world, run: (args: Record<string, unknown> = {}) => callTool(tool, args) };
};

describe("deploy_status", () => {
	it("tells for every agent whether it is ready, which version and which commit it runs, and a summary of its status", async () => {
		const { run, requests } = setup();
		const { text, isError } = await run();
		assert.equal(isError, false);
		assert.match(text, /^<<<CLUSTER-0123456789abcdef \(agent health: untrusted data/);
		assert.match(text, /reviewer: ready; version ci-1a2b3c4d5e6f \(commit 1a2b3c4d5e6f\); status: handlers: 2; jobs: 0 items; pools: \{chat\}; long_note: x+/);
		assert.match(text, /developer: NOT READY \(sandbox\); version pilot-1; status: handlers: 0/);
		assert.ok(requests.every((request) => request.startsWith("GET ")));
		assert.deepEqual([...new Set(requests.map((request) => new URL(request.split(" ")[1]!).pathname))].sort(), ["/profile", "/ready", "/status"]);
	});

	it("compares with the commit a deploy should have put there", async () => {
		const { run } = setup();
		assert.match((await run({ expect: "1a2b3c4" })).text, /reviewer: ready.*runs the expected commit/);
		assert.match((await run({ expect: "1a2b3c4d5e6f9999999999" })).text, /reviewer: ready.*runs the expected commit/, "a longer sha that starts with the running one");
		const other = (await run({ expect: "ffffffff" })).text;
		assert.match(other, /reviewer: .*runs 1a2b3c4d5e6f, NOT the expected commit/);
		assert.match(other, /developer: .*commit unknown/, "a build that is not a ci-<sha> tag has no commit to compare");
	});

	it("reads one agent when asked, and says which exist when the name is wrong", async () => {
		const { run, requests } = setup();
		const { text } = await run({ agent: "reviewer" });
		assert.ok(!text.includes("developer:"));
		assert.ok(requests.every((request) => request.includes("10.10.10.20:8082")));
		const unknown = await run({ agent: "nobody" });
		assert.equal(unknown.isError, true);
		assert.match(unknown.text, /unknown agent "nobody". Agents: reviewer, developer/);
	});

	it("reports an agent that does not answer, or answers a redirect, without failing the rest", async () => {
		const { run } = setup({ "http://10.10.10.20:8081": { "/ready": { fail: "connect ECONNREFUSED 10.10.10.20:8081" } } });
		const { text, isError } = await run();
		assert.equal(isError, false);
		assert.match(text, /developer: UNREACHABLE \(\/ready: connect ECONNREFUSED/);
		assert.match(text, /reviewer: ready/);
		const redirected = setup({ "http://10.10.10.20:8081": { "/ready": { status: 302, body: {} } } });
		assert.match((await redirected.run({ agent: "developer" })).text, /UNREACHABLE \(\/ready answered with a redirect\)/);
	});

	it("is NOT READY when the ready endpoint says 200 but ready false, or answers 503 without a body", async () => {
		const { run } = setup({ "http://10.10.10.20:8082": { "/ready": { body: { ready: false, failed: ["telegram"] } }, "/status": { body: {} }, "/profile": { body: { version: "ci-abcdef0" } } } });
		assert.match((await run({ agent: "reviewer" })).text, /reviewer: NOT READY \(telegram\)/);
	});

	it("tells when no agents are configured, and takes secrets out of what comes back", async () => {
		const empty = createDeployStatus({ settings: { agentUrls: {} }, fetch: health().fetch, boundary });
		const { text, isError } = await callTool(empty, {});
		assert.equal(isError, true);
		assert.match(text, /CLUSTER_DEV_AGENT_URLS/);
		const leaky = setup({ "http://10.10.10.20:8082": { "/ready": { body: { ready: true } }, "/status": { body: { note: "token=supersecretvalue and GIT_TOKEN=abcdefgh12345678" } }, "/profile": { body: { version: "ci-abcdef0" } } } });
		const out = (await leaky.run({ agent: "reviewer" })).text;
		assert.ok(!out.includes("supersecretvalue"));
		assert.ok(!out.includes("abcdefgh12345678"));
	});

	it("is read only and replay-safe", () => {
		const tool = createDeployStatus({ settings: settingsFor(), fetch: health().fetch });
		assert.equal(tool.replay, "safe");
		assert.equal(tool.name, "deploy_status");
	});
});

describe("what deploy_status reads", () => {
	it("takes the commit out of the image tag the deploy builds", () => {
		assert.equal(commitOfVersion("ci-1a2b3c4"), "1a2b3c4");
		assert.equal(commitOfVersion("ci-1A2B3C4"), undefined);
		assert.equal(commitOfVersion("pilot-1"), undefined);
		assert.equal(commitOfVersion(undefined), undefined);
		assert.equal(commitOfVersion("ci-abc"), undefined, "too short to be a commit");
	});

	it("summarises a status document: scalars as they are, lists and objects by size, cut short", () => {
		assert.equal(summariseStatus({ a: 1, b: [1, 2], c: [1], d: { x: 1, y: 2 }, e: "text" }), "a: 1; b: 2 items; c: 1 item; d: {x, y}; e: text");
		assert.equal(summariseStatus(null), "");
		assert.equal(summariseStatus([1]), "");
		assert.ok(summariseStatus(Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`key${i}`, "v".repeat(30)]))).length <= 600);
	});

	it("reads an agent's health port with three GETs and nothing else", async () => {
		const world = health();
		const status = await agentStatus(world.fetch, "reviewer", "http://10.10.10.20:8082");
		assert.deepEqual([status.reachable, status.ready, status.commit], [true, true, "1a2b3c4d5e6f"]);
		assert.equal(world.requests.length, 3);
	});
});

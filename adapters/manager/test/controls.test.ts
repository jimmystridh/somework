import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { describeAction, parseAction, parseMetrics, hubStats } from "../src/controls.ts";
import { createGateway } from "../src/gateway.ts";
import { build, rule, say, tap } from "./events-helpers.ts";

const METRICS = `
# HELP hub_events_received_total x
hub_events_received_total{source="github"} 42
hub_events_published_total{source="github"} 40
hub_events_duplicate_total{source="github"} 2
hub_events_dropped_total{reason="no_match",source="github"} 1
hub_events_dropped_total{reason="draft",source="github"} 2
hub_events_received_total{source="jira"} 5
hub_events_published_total{source="jira"} 5
hub_dead_letters{source="jira"} 1
hub_receiver_up 1
hub_receiver_queued 3
hub_receiver_oldest_pending_age_seconds 12.5
`;

const hub = (url: string, method?: string) => {
	if (url.endsWith("/metrics")) return { status: 200, text: METRICS };
	if (method === "POST" && /\/admin\/sources\/(github|jira)\/(pause|resume)$/.test(url)) return { status: 200, text: "{}" };
	if (url.endsWith("/status")) return { status: 200, text: JSON.stringify({ handlers: [{ name: "triage", version: "a1b2c3", enabled: true, runs: 10, errors: 1, drops: 4, wakes: 2 }, { name: "noisy", version: "d4e5", enabled: false, runs: 50, errors: 5, drops: 0, wakes: 0, disabledReason: "5 consecutive failures", lastError: "timeout" }], tokenPools: { tasks: { used: 100, limit: 1000 }, events: { used: 300, limit: 300, throttled: true, stopped: true } } }) };
	return { status: 404, text: "" };
};

const config = { hubUrl: "https://hub.internal:8445", hubTokenFile: "/secrets/hub-admin", agentHealth: { "agent/reviewer": "http://10.0.0.5:8081" } };

test("metrics parsing and per-source statistics", () => {
	const stats = hubStats(parseMetrics(METRICS));
	assert.deepEqual(stats.sources.map((s) => [s.source, s.received, s.published, s.duplicate, s.dropped, s.deadLettersWaiting]), [["github", 42, 40, 2, 3, 0], ["jira", 5, 5, 0, 0, 1]]);
	assert.equal(stats.receiverUp, true);
	assert.equal(stats.queued, 3);
	assert.equal(stats.oldestPendingSeconds, 12.5);
});

test("/rules lists status, kind, counters and last fired", async () => {
	const b = build();
	b.domain.rules = [rule("pr-review-opened", { selector: "github.pull_request.opened", lastFiredAt: "2026-10-05T10:00:00Z", counters: { fired: 7, skipped: { rate: 2, approval: 0 } } }), rule("alerts", { wake: true, status: "paused", selector: "grafana.alert.*" })];
	await say(b, "/rules");
	const text = b.telegram.texts().at(-1)!;
	assert.ok(text.includes("pr-review-opened [active] record on github.pull_request.opened; fired 7, skipped: rate 2; last 2026-10-05T10:00:00Z"));
	assert.ok(text.includes("alerts [paused] wake on grafana.alert.*; fired 0; last never"));
});

test("the owner's /pause and /resume go straight to the domain; bad names are refused without a call", async () => {
	const b = build();
	b.domain.rules = [rule("pr-review-opened")];
	await say(b, "/pause pr-review-opened");
	assert.deepEqual(b.domain.rulesPaused, ["pr-review-opened"]);
	assert.ok(b.telegram.texts().at(-1)!.includes("paused"));
	await say(b, "/resume pr-review-opened");
	assert.deepEqual(b.domain.rulesResumed, ["pr-review-opened"]);
	await say(b, "/pause ../../etc");
	await say(b, "/pause");
	assert.equal(b.domain.rulesPaused.length, 1);
});

test("/sources reads the hub metrics; /pausesource calls the hub with the bearer token and remembers it", async () => {
	const b = build({ controls: config, http: hub });
	await say(b, "/sources");
	let text = b.telegram.texts().at(-1)!;
	assert.ok(text.includes("Receiver up, 3 queued, oldest 13 s") || text.includes("oldest 12 s") || text.includes("oldest 13 s"));
	assert.ok(text.includes("github: in 42, published 40, duplicate 2, dropped 3, dead letters 0"));
	await say(b, "/pausesource github");
	const call = b.httpCalls.find((c) => c.method === "POST")!;
	assert.equal(call.url, "https://hub.internal:8445/admin/sources/github/pause");
	assert.equal(call.authorization, "Bearer hub-admin-token");
	await say(b, "/sources");
	text = b.telegram.texts().at(-1)!;
	assert.ok(text.includes("github [paused from here]"));
	await say(b, "/resumesource github");
	assert.ok(b.httpCalls.some((c) => c.url.endsWith("/admin/sources/github/resume")));
	assert.equal(b.state.sourcesPaused!.github, false);
});

test("an unknown source or a missing hub is reported, not guessed", async () => {
	const b = build({ controls: config, http: hub });
	await say(b, "/pausesource nosuch");
	assert.ok(b.telegram.texts().at(-1)!.includes("no source nosuch") || b.telegram.texts().at(-1)!.includes("hub"));
	const c = build();
	await say(c, "/sources");
	assert.ok(c.telegram.texts().at(-1)!.includes("MANAGER_HUB_URL"));
});

test("/handlers shows handlers and token pools of an agent", async () => {
	const b = build({ controls: config, http: hub });
	await say(b, "/handlers agent/reviewer");
	const text = b.telegram.texts().at(-1)!;
	assert.ok(text.includes("triage va1b2c3 [on]") || text.includes("triage v"));
	assert.ok(text.includes("noisy") && text.includes("OFF: 5 consecutive failures") && text.includes("last error: timeout"));
	assert.ok(text.includes("events 300/300 STOPPED"));
	await say(b, "/handlers agent/unknown");
	assert.ok(b.telegram.texts().at(-1)!.includes("no health URL"));
	await say(b, "/handlers nonsense");
	assert.ok(b.telegram.texts().at(-1)!.startsWith("Usage"));
});

test("/kill and /unkill send the kit's control message to the agent", async () => {
	const b = build({ controls: config, http: hub });
	await say(b, "/kill agent/reviewer triage too noisy today");
	await say(b, "/kill agent/reviewer all");
	await say(b, "/unkill agent/reviewer triage");
	await say(b, "/unkill agent/reviewer all");
	const labels = b.domain.sentMessages.map((m) => [m.to, m.labels]);
	assert.deepEqual(labels, [
		["agent/reviewer", { eventControl: "disable", eventTarget: "triage", eventReason: "too noisy today" }],
		["agent/reviewer", { eventControl: "disable-all", eventReason: "switched off by the owner from Telegram" }],
		["agent/reviewer", { eventControl: "enable", eventTarget: "triage" }],
		["agent/reviewer", { eventControl: "enable-all" }],
	]);
	await say(b, "/kill reviewer triage");
	await say(b, "/kill agent/reviewer");
	assert.equal(b.domain.sentMessages.length, 4, "malformed requests send nothing");
});

test("action parsing rejects anything outside the allowed shapes", () => {
	for (const raw of [{ action: "delete_rule", rule: "x" }, { action: "pause_rule", rule: "Bad Name" }, { action: "pause_source", source: "../x" }, { action: "kill_handler", agent: "reviewer", handler: "h" }, { action: "kill_handler", agent: "agent/r", handler: "a b" }, {}]) {
		assert.throws(() => parseAction(raw as never));
	}
	assert.deepEqual(parseAction({ action: "kill_handler", agent: "agent/r", handler: "all", reason: "/approve x" }), { action: "kill_handler", agent: "agent/r", handler: "all", reason: "∕approve x" });
});

async function gateway(b: ReturnType<typeof build>) {
	const server: Server = createGateway({ service: b.service, token: "t".repeat(40) });
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	const call = (method: string, path: string, body?: unknown) => fetch(`${url}${path}`, { method, headers: { authorization: `Bearer ${"t".repeat(40)}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
	return { call, close: () => (server.closeAllConnections(), server.close()) };
}

test("/handlers and /sources say which service could not be reached instead of failing", async () => {
	const down = () => {
		throw new Error("connect ECONNREFUSED 10.0.0.1:8080");
	};
	const b = build({ controls: config, http: down });
	await say(b, "/handlers agent/reviewer");
	assert.ok(b.telegram.texts().at(-1)!.includes("agent/reviewer could not be reached"));
	await say(b, "/sources");
	assert.ok(b.telegram.texts().at(-1)!.includes("the hub could not be reached"));
});

test("the model can read rules, sources and handlers, but a switch only becomes a request the owner must confirm", async () => {
	const b = build({ controls: config, http: hub });
	b.domain.rules = [rule("qa-on-ticket")];
	const g = await gateway(b);
	assert.equal(((await (await g.call("GET", "/v1/control/rules")).json()) as any).rules[0].name, "qa-on-ticket");
	assert.equal(((await (await g.call("GET", "/v1/control/sources")).json()) as any).sources.length, 2);
	assert.equal(((await (await g.call("GET", "/v1/control/handlers?agent=agent/reviewer")).json()) as any).handlers.length, 2);

	const asked: any = await (await g.call("POST", "/v1/control/request", { action: "pause_rule", rule: "qa-on-ticket" })).json();
	assert.equal(asked.status, "awaiting_owner");
	assert.deepEqual(b.domain.rulesPaused, [], "nothing changed yet");
	const prompt = b.telegram.sent.filter((s) => s.method === "sendMessage").at(-1)!;
	assert.ok(prompt.data.text.includes("pause rule qa-on-ticket"));
	assert.deepEqual(prompt.data.reply_markup.inline_keyboard[0].map((k: any) => k.callback_data), [`ct:y:${asked.requestId}`, `ct:n:${asked.requestId}`]);

	assert.equal(b.service.controlRequests!.get(asked.requestId)!.status, "pending");
	await tap(b, `ct:y:${asked.requestId}`);
	assert.deepEqual(b.domain.rulesPaused, ["qa-on-ticket"]);
	assert.equal(b.service.controlRequests!.get(asked.requestId)!.status, "approved");
	g.close();
});

test("a denied or foreign confirmation changes nothing, and the model has no way to create or delete rules", async () => {
	const b = build({ controls: config, http: hub });
	b.domain.rules = [rule("qa-on-ticket")];
	const g = await gateway(b);
	const asked: any = await (await g.call("POST", "/v1/control/request", { action: "kill_handler", agent: "agent/reviewer", handler: "all" })).json();
	await tap(b, `ct:y:${asked.requestId}`, 999, 999);
	await say(b, `/approve ${asked.requestId}`, 999);
	assert.equal(b.domain.sentMessages.length, 0);
	await tap(b, `ct:n:${asked.requestId}`);
	assert.equal(b.domain.sentMessages.length, 0);
	await say(b, `/approve ${asked.requestId}`);
	assert.ok(b.telegram.texts().at(-1)!.includes("already denied"));

	for (const [method, path, body] of [["PUT", "/v1/rules/new", { selector: "x" }], ["DELETE", "/v1/rules/qa-on-ticket"], ["POST", "/v1/rules", { name: "x" }], ["POST", "/v1/control/request", { action: "create_rule", rule: "x" }]] as const) {
		assert.ok([400, 404].includes((await g.call(method, path, body)).status), `${method} ${path}`);
	}
	assert.equal((await g.call("POST", "/v1/control/request", { action: "pause_rule", rule: "../x" })).status, 400);
	g.close();
});

test("a budget raise is only a request until the owner confirms, then it rides on a message to the agent", async () => {
	const b = build({ controls: config, http: hub });
	const g = await gateway(b);
	const asked: any = await (await g.call("POST", "/v1/control/request", { action: "raise_budget", agent: "agent/reviewer", pool: "events", tokens: 500000, reason: "acceptance burst" })).json();
	assert.equal(asked.status, "awaiting_owner");
	assert.ok(b.telegram.texts().some((t) => t.includes("give agent/reviewer 500000 more events tokens for today (acceptance burst)")));
	assert.equal(b.domain.sentMessages.length, 0, "nothing is sent before the owner confirms");
	await tap(b, `ct:y:${asked.requestId}`);
	assert.deepEqual(b.domain.sentMessages.map((m) => [m.to, m.labels]), [["agent/reviewer", { budgetControl: "raise", budgetPool: "events", budgetTokens: "500000", budgetReason: "acceptance burst" }]]);
	assert.ok(b.telegram.texts().at(-1)!.includes("Asked agent/reviewer to add 500000 tokens to its events pool for today"));
	g.close();
});

test("budget requests with an odd agent, pool or amount are refused", () => {
	for (const raw of [
		{ action: "raise_budget", agent: "reviewer", pool: "tasks", tokens: 10 },
		{ action: "raise_budget", agent: "agent/r", pool: "bank", tokens: 10 },
		{ action: "raise_budget", agent: "agent/r", pool: "tasks", tokens: 0 },
		{ action: "raise_budget", agent: "agent/r", pool: "tasks", tokens: 1.5 },
		{ action: "raise_budget", agent: "agent/r", pool: "tasks", tokens: 10_000_001 },
		{ action: "raise_budget", agent: "agent/r", pool: "tasks" },
	]) assert.throws(() => parseAction(raw as never), undefined, JSON.stringify(raw));
	assert.deepEqual(parseAction({ action: "raise_budget", agent: "agent/r", pool: "chat", tokens: "2000" }), { action: "raise_budget", agent: "agent/r", pool: "chat", tokens: 2000 });
});

test("a control request that nobody confirms expires", async () => {
	let clock = Date.now();
	const b = build({ controls: config, http: hub, now: () => clock });
	b.domain.rules = [rule("qa-on-ticket")];
	const result: any = await b.service.controlRequest({ action: "pause_rule", rule: "qa-on-ticket" });
	clock += 11 * 60_000;
	await say(b, `/approve ${result.requestId}`);
	assert.equal(b.domain.rulesPaused.length, 0);
	assert.ok(b.telegram.texts().at(-1)!.includes("already expired"));
});

test("the manager has no call that creates, replaces or deletes a rule", async () => {
	const { readFileSync } = await import("node:fs");
	const source = ["domain.ts", "controls.ts", "service.ts"].map((file) => readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8")).join("\n");
	assert.ok(!/putRule|deleteRule|["`]\/v1\/rules["`/]/.test(source.replace(/`\/v1\/rules\/\$\{segment\(name\)\}\/firings\?limit=\$\{limit\}`/, "")), "only listRules, pauseRule, resumeRule and the firings read are used");
	assert.ok(!source.includes("rules.manage"));
});

test("/suspend pauses every active rule and source and switches off every agent's handlers; /unsuspend puts back only that", async () => {
	const b = build({ controls: config, http: hub });
	b.domain.rules = [rule("pr-review-opened"), rule("qa-on-ticket"), rule("nightly-digest", { status: "paused" })];
	await say(b, "/suspend something is wrong");
	assert.deepEqual(b.domain.rulesPaused.sort(), ["pr-review-opened", "qa-on-ticket"], "a rule that was paused already is left alone");
	assert.deepEqual(b.httpCalls.filter((c) => c.method === "POST").map((c) => c.url.split("/admin/sources/")[1]).sort(), ["github/pause", "jira/pause"]);
	assert.deepEqual(b.domain.sentMessages.map((m) => [m.to, m.labels?.eventControl]), [["agent/reviewer", "disable-all"]]);
	assert.equal(b.state.suspended?.reason, "something is wrong");
	assert.deepEqual(b.state.suspended?.rules.sort(), ["pr-review-opened", "qa-on-ticket"]);
	assert.ok(b.telegram.texts().at(-1)!.startsWith("SUSPENDED."));
	assert.ok(b.rpcCalls.some((c) => JSON.stringify(c).includes("abort")), "the Manager's own run is stopped");

	await say(b, "/status");
	assert.ok(b.telegram.texts().at(-1)!.startsWith("SUSPENDED since"));
	await say(b, "/approve c12345678");
	assert.match(b.telegram.texts().at(-1)!, /suspended: send \/unsuspend/);

	await say(b, "/unsuspend");
	assert.deepEqual(b.domain.rulesResumed.sort(), ["pr-review-opened", "qa-on-ticket"], "the rule that was paused before stays paused");
	assert.deepEqual(b.httpCalls.filter((c) => c.method === "POST").map((c) => c.url.split("/admin/sources/")[1]).sort(), ["github/pause", "github/resume", "jira/pause", "jira/resume"]);
	assert.equal(b.domain.sentMessages.at(-1)!.labels?.eventControl, "enable-all");
	assert.equal(b.state.suspended, undefined);
	await say(b, "/unsuspend");
	assert.match(b.telegram.texts().at(-1)!, /Nothing is suspended/);
});

test("a source that cannot be paused stays in the suspend record so /unsuspend retries only that", async () => {
	let failing = true;
	const b = build({ controls: config, http: (url, method) => (failing && url.includes("/admin/sources/jira/pause") ? { status: 500, text: "" } : hub(url, method)) });
	b.domain.rules = [];
	await say(b, "/suspend");
	assert.match(b.telegram.texts().at(-1)!, /Event sources: FAILED/);
	assert.ok(b.state.suspended, "it is still suspended");
	failing = false;
	await say(b, "/unsuspend");
	assert.equal(b.state.suspended, undefined);
});

import { mkdtempSync, existsSync, writeFileSync as writeText } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { HostControls, parseHostConfig, type Exec } from "../src/host.ts";

const hostRig = (options: { failing?: string } = {}) => {
	const pilotDir = mkdtempSync(joinPath(tmpdir(), "pilot-"));
	const calls: string[] = [];
	const exec: Exec = async (file, args, opts) => {
		const line = file === "ssh" ? `ssh ${args.at(-2)} ${args.at(-1)}` : `${file} ${args.join(" ")} @${opts.cwd?.split("/").at(-1)}`;
		calls.push(line);
		return { code: options.failing && line.includes(options.failing) ? 1 : 0, output: options.failing && line.includes(options.failing) ? "refused" : "" };
	};
	const config = parseHostConfig({
		pilotDir,
		firstStacks: ["events-hub"],
		stacks: ["pi-agent", "reviewer"],
		windows: [{ name: "qa", host: "10.0.0.44" }, { name: "windows-developer", host: "10.0.0.45" }],
		ssh: { user: "js", keyFile: "/k", knownHostsFile: "/kh" },
	});
	return { pilotDir, calls, host: new HostControls(config, exec, () => new Date("2026-10-08T15:00:00Z")) };
};

test("the host side stops the agents, then the hub, then the Windows agents, and starts them in the opposite order", async () => {
	const { host, calls, pilotDir } = hostRig();
	assert.equal(host.isSuspended(), false);
	const stopped = await host.suspend();
	assert.deepEqual(calls, ["docker compose stop @pi-agent", "docker compose stop @reviewer", "docker compose stop @events-hub", "ssh js@10.0.0.44 suspend", "ssh js@10.0.0.45 suspend"].sort((a, b) => 0));
	assert.ok(stopped.every((line) => !line.includes("FAILED")));
	assert.ok(existsSync(joinPath(pilotDir, "SUSPENDED")), "the deploy wrapper sees the flag");
	assert.equal(host.isSuspended(), true);
	calls.length = 0;
	await host.resume();
	assert.deepEqual(calls.filter((c) => c.startsWith("docker")), ["docker compose up -d @events-hub", "docker compose up -d @pi-agent", "docker compose up -d @reviewer"]);
	assert.equal(host.isSuspended(), false);
});

test("a step that fails keeps the flag, so nothing deploys over a half-started fleet", async () => {
	const { host, calls } = hostRig({ failing: "10.0.0.45 resume" });
	await host.suspend();
	const lines = await host.resume();
	assert.ok(lines.some((l) => l === "windows-developer: resume FAILED (refused)"));
	assert.equal(host.isSuspended(), true);
	assert.ok(calls.length > 0);
});

test("the host control file is validated", () => {
	assert.throws(() => parseHostConfig({ pilotDir: "relative" }), /absolute/);
	assert.throws(() => parseHostConfig({ pilotDir: "/p", stacks: ["../x"] }), /plain names/);
	assert.throws(() => parseHostConfig({ pilotDir: "/p", windows: [{ name: "qa", host: "10.0.0.1" }] }), /ssh section/);
});

test("/suspend stops the processes after the platform steps and /unsuspend starts them before resuming rules, sources and handlers", async () => {
	const rig = hostRig();
	const b = build({ controls: config, http: hub });
	// the host is part of the controls: rebuild them with it
	const { Controls } = await import("../src/controls.ts");
	const controls = new Controls({ domain: b.domain, state: b.state, save: async () => {}, config, host: rig.host, hubWaitMs: 100, http: async (url, opts) => hub(url, opts?.method), readToken: async () => "t" });
	b.service.controls = controls;
	b.domain.rules = [rule("qa-on-ticket")];
	await say(b, "/suspend");
	assert.deepEqual(b.domain.rulesPaused, ["qa-on-ticket"]);
	assert.ok(rig.calls.some((c) => c === "docker compose stop @events-hub"));
	assert.ok(b.telegram.texts().at(-1)!.includes("Processes:"));
	assert.equal(rig.host.isSuspended(), true);

	rig.calls.length = 0;
	await say(b, "/unsuspend");
	assert.ok(rig.calls.some((c) => c === "docker compose up -d @events-hub"));
	assert.deepEqual(b.domain.rulesResumed, ["qa-on-ticket"]);
	assert.equal(rig.host.isSuspended(), false);
	assert.equal(b.state.suspended, undefined);
});

test("/unsuspend also starts what was stopped by hand: the flag file alone is enough", async () => {
	const rig = hostRig();
	writeText(joinPath(rig.pilotDir, "SUSPENDED"), "by hand\n");
	const b = build({ controls: config, http: hub });
	const { Controls } = await import("../src/controls.ts");
	b.service.controls = new Controls({ domain: b.domain, state: b.state, save: async () => {}, config, host: rig.host, hubWaitMs: 50, http: async (url, opts) => hub(url, opts?.method), readToken: async () => "t" });
	await say(b, "/unsuspend");
	assert.ok(rig.calls.some((c) => c === "docker compose up -d @events-hub"));
	assert.equal(rig.host.isSuspended(), false);
});

const operations = { url: "https://operations.internal:9444", tokenFile: "/secrets/operations-token" };
const detail = (revision: number, instructions: string | null) => ({
	agent: { id: "agent/reviewer", slug: "reviewer", savedRevision: revision, appliedRevision: revision, pending: false },
	form: { instructions, model: null, approvalPatterns: null, repositorySkills: null, librarySkills: ["review"], overlays: {}, mcp: ["docs"] },
	roleDefaults: { role: "reviewer", prompt: "You review pull requests.", promptSha256: "x", promptCharacters: 25 },
});
const operationsApi = (state: { revision: number; instructions: string | null }, onPut?: (body: any) => { status: number; body: unknown }) => (url: string, method?: string, body?: unknown) => {
	if (!url.startsWith(`${operations.url}/fleet/api/ops/agents/reviewer`)) return { status: 404, text: "" };
	if (method === "PUT") {
		const answer = onPut?.(body) ?? { status: 200, body: { revision: { agent: "agent/reviewer", revision: state.revision + 1 } } };
		return { status: answer.status, text: JSON.stringify(answer.body) };
	}
	return { status: 200, text: JSON.stringify(detail(state.revision, state.instructions)) };
};

test("the model can read an agent's instructions and the role's prompt, but only through Operations", async () => {
	const b = build({ controls: { ...config, operations }, http: operationsApi({ revision: 3, instructions: "Answer in Swedish." }) });
	const g = await gateway(b);
	const read: any = await (await g.call("GET", "/v1/setup?agent=agent/reviewer")).json();
	assert.deepEqual([read.agent, read.savedRevision, read.appliedRevision, read.instructions, read.rolePrompt], ["agent/reviewer", 3, 3, "Answer in Swedish.", "You review pull requests."]);
	assert.equal(b.httpCalls[0]!.authorization, "Bearer hub-admin-token", "the token comes from the token file");
	assert.equal((await g.call("GET", "/v1/setup?agent=reviewer")).status, 400);
	g.close();

	const bare = build({ controls: config });
	const bareGateway = await gateway(bare);
	assert.equal((await bareGateway.call("GET", "/v1/setup?agent=agent/reviewer")).status, 503);
	assert.equal((await bareGateway.call("POST", "/v1/control/request", { action: "set_instructions", agent: "agent/reviewer", instructions: "x" })).status, 503);
	assert.equal(bare.telegram.texts().length, 0, "the owner is not asked for something that cannot be done");
	bareGateway.close();
});

test("new instructions are a request until the owner confirms; then they become one more revision with the rest of the setup untouched", async () => {
	const state = { revision: 3, instructions: "Answer in Swedish." as string | null };
	const b = build({ controls: { ...config, operations }, http: operationsApi(state) });
	const g = await gateway(b);
	const asked: any = await (await g.call("POST", "/v1/control/request", { action: "set_instructions", agent: "agent/reviewer", instructions: "  Answer in English.\nNever approve a PR without tests.  ", reason: "owner prefers English" })).json();
	assert.equal(asked.status, "awaiting_owner");
	const shown = b.telegram.texts().find((t) => t.includes("set the operator instructions of agent/reviewer"))!;
	assert.ok(shown.includes("Answer in English.\nNever approve a PR without tests.") && shown.includes("(owner prefers English)"), "the owner sees the whole new text");
	assert.equal(b.httpCalls.length, 0, "nothing reaches Operations before the owner confirms");

	await tap(b, `ct:y:${asked.requestId}`);
	const put = b.httpCalls.find((c) => c.method === "PUT")!;
	assert.equal(put.url, `${operations.url}/fleet/api/ops/agents/reviewer/setup`);
	assert.equal(put.headers?.["x-operations-request"], "1");
	assert.deepEqual(put.body, {
		baseRevision: 3,
		form: { instructions: "Answer in English.\nNever approve a PR without tests.", model: null, approvalPatterns: null, repositorySkills: null, librarySkills: ["review"], overlays: {}, mcp: ["docs"] },
		note: "by the Manager at the owner's request: owner prefers English",
	});
	assert.ok(b.telegram.texts().at(-1)!.includes("Saved revision 4 of agent/reviewer's operator instructions (52 characters)"));
	g.close();
});

test("an empty text clears the instructions; a save that lost the race or was refused says so and changes nothing else", async () => {
	const state = { revision: 5, instructions: "old" as string | null };
	let answer: { status: number; body: unknown } | undefined;
	const b = build({ controls: { ...config, operations }, http: operationsApi(state, () => answer) });
	const g = await gateway(b);
	const ask = async (instructions: string) => ((await (await g.call("POST", "/v1/control/request", { action: "set_instructions", agent: "agent/reviewer", instructions })).json()) as any).requestId as string;

	await tap(b, `ct:y:${await ask("")}`);
	assert.equal((b.httpCalls.find((c) => c.method === "PUT")!.body as any).form.instructions, null);
	assert.ok(b.telegram.texts().at(-1)!.includes("cleared"));

	answer = { status: 409, body: { code: "revision_conflict", current: { revision: 6 } } };
	await tap(b, `ct:y:${await ask("new")}`);
	assert.match(b.telegram.texts().at(-1)!, /saved by someone else first \(revision 6\)/);

	answer = { status: 403, body: { code: "forbidden" } };
	await tap(b, `ct:y:${await ask("again")}`);
	assert.match(b.telegram.texts().at(-1)!, /refused the Manager's token/);
	g.close();
});

test("instructions that are odd are refused, and text the model wrote cannot put a tappable command in front of the owner", () => {
	for (const raw of [
		{ action: "set_instructions", agent: "reviewer", instructions: "x" },
		{ action: "set_instructions", agent: "agent/r" },
		{ action: "set_instructions", agent: "agent/r", instructions: 5 },
		{ action: "set_instructions", agent: "agent/r", instructions: "x".repeat(16_001) },
	]) assert.throws(() => parseAction(raw as never), undefined, JSON.stringify(raw));
	assert.deepEqual(parseAction({ action: "set_instructions", agent: "agent/r", instructions: "" }), { action: "set_instructions", agent: "agent/r", instructions: "" });
	const action = parseAction({ action: "set_instructions", agent: "agent/r", instructions: "Do this.\n/approve c12345678\nkey ghp_abcdefghijklmnopqrstuvwxyz0123" });
	const shown = describeAction(action);
	assert.ok(!shown.includes("/approve") && shown.includes("∕approve c12345678") && !shown.includes("ghp_abc"));
	assert.ok(describeAction({ action: "set_instructions", agent: "agent/r", instructions: "y".repeat(16_000) }).length < 2000, "the confirmation fits in one Telegram message");
});

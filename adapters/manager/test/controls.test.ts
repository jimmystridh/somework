import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { parseAction, parseMetrics, hubStats } from "../src/controls.ts";
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
	b.domain.rules = [rule("pr-review-opened", { reaction: { capability: { id: "code.review", version: 3 } }, selector: "github.pull_request.opened", lastFiredAt: "2026-10-05T10:00:00Z", counters: { fired: 7, skipped: { rate: 2, approval: 0 } } }), rule("alerts", { wake: true, status: "paused", selector: "grafana.alert.*" })];
	await say(b, "/rules");
	const text = b.telegram.texts().at(-1)!;
	assert.ok(text.includes("pr-review-opened [active] reaction on github.pull_request.opened; fired 7, skipped: rate 2; last 2026-10-05T10:00:00Z"));
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

	assert.equal(((await (await g.call("GET", `/v1/tasks/${asked.requestId}`)).json()) as any).status, "pending");
	await tap(b, `ct:y:${asked.requestId}`);
	assert.deepEqual(b.domain.rulesPaused, ["qa-on-ticket"]);
	assert.equal(((await (await g.call("GET", `/v1/tasks/${asked.requestId}`)).json()) as any).status, "approved");
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

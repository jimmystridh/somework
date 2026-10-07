import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { parseConfig } from "../src/config.ts";
import { timerToken } from "../src/derive.ts";
import { createHubServer } from "../src/server.ts";
import { Store } from "../src/store.ts";
import { TimerError, timerTopic, Timers } from "../src/timers.ts";
import type { MappedEvent } from "../src/types.ts";
import { removeDir, SECRET, startWorld, tempDir, waitFor, type World } from "./support.ts";

const AGENT = "agent/aikido-fixer";
const CONFIG = { agents: [AGENT, "agent/reviewer"], minDelaySeconds: 60, maxDelaySeconds: 3600, maxPendingPerAgent: 3 };

const rig = () => {
	const dir = tempDir("timers-");
	const store = new Store(join(dir, "hub.sqlite"));
	let clock = Date.parse("2026-10-07T08:00:00Z");
	const published: { event: MappedEvent; occurredAt: string }[] = [];
	const failures = { next: 0 };
	const timers = new Timers({
		config: parseConfig({ domain: { url: "http://x" }, receiver: { url: "http://y" }, clock: { producer: { keyFile: "k" } }, timers: CONFIG }).timers!,
		store,
		now: () => clock,
		publish: async (event, occurredAt) => {
			if (failures.next > 0) {
				failures.next--;
				throw new Error("domain down");
			}
			published.push({ event, occurredAt });
			return { duplicate: false };
		},
	});
	return { timers, store, published, failures, advance: (ms: number) => (clock += ms), now: () => clock, done: () => (store.close(), removeDir(dir)) };
};

describe("timers", () => {
	it("fires a timer once, at its time, as an event on the agent's own topic", async () => {
		const r = rig();
		const view = r.timers.request(AGENT, { delaySeconds: 15 * 60, note: "check PR 42 for review comments", key: "pr-followup:42", payload: { pr: 42 } });
		assert.equal(view.dueAt, "2026-10-07T08:15:00.000Z");
		assert.equal(await r.timers.tick(r.advance(14 * 60_000)), 0, "not yet");
		assert.equal(await r.timers.tick(r.advance(61_000)), 1);
		assert.equal(await r.timers.tick(r.advance(60_000)), 0, "only once");
		assert.equal(r.published.length, 1);
		const { event, occurredAt } = r.published[0]!;
		assert.equal(event.topic, "clock.timer.aikido_fixer.due");
		assert.equal(event.key, `timer:${view.id}`);
		assert.deepEqual(event.data, { timerId: view.id, key: "pr-followup:42", agent: AGENT, note: "check PR 42 for review comments", payload: { pr: 42 }, requestedAt: "2026-10-07T08:00:00.000Z", dueAt: "2026-10-07T08:15:00.000Z", late: false });
		assert.equal(occurredAt, "2026-10-07T08:15:00.000Z");
		r.done();
	});

	it("accepts an absolute time, and marks a timer that came due while the hub was away as late", async () => {
		const r = rig();
		r.timers.request(AGENT, { at: "2026-10-07T08:30:00Z", note: "later" });
		await r.timers.tick(r.advance(2 * 3600_000));
		assert.equal((r.published[0]!.event.data as { late: boolean }).late, true);
		r.done();
	});

	it("moves a timer that is asked for again with the same key, and lets a fired key be reused", async () => {
		const r = rig();
		const first = r.timers.request(AGENT, { delaySeconds: 300, note: "a", key: "k" });
		const second = r.timers.request(AGENT, { delaySeconds: 900, note: "b", key: "k" });
		assert.notEqual(first.id, second.id);
		assert.deepEqual(r.timers.list(AGENT).map((t) => [t.key, t.note, t.dueAt]), [["k", "b", "2026-10-07T08:15:00.000Z"]]);
		await r.timers.tick(r.advance(16 * 60_000));
		assert.equal(r.published.length, 1);
		r.timers.request(AGENT, { delaySeconds: 300, note: "again", key: "k" });
		assert.equal(r.timers.list(AGENT).length, 1);
		r.done();
	});

	it("cancels by id or key, only the agent's own", () => {
		const r = rig();
		const a = r.timers.request(AGENT, { delaySeconds: 300, note: "a", key: "k" });
		r.timers.request("agent/reviewer", { delaySeconds: 300, note: "theirs", key: "k" });
		assert.equal(r.timers.cancel(AGENT, a.id), true);
		assert.equal(r.timers.cancel(AGENT, "k"), false, "already gone");
		assert.equal(r.timers.list("agent/reviewer").length, 1, "the other agent's timer with the same key is untouched");
		assert.equal(r.timers.cancel(AGENT, "nosuch"), false);
		r.done();
	});

	it("keeps a timer pending when the domain is down and fires it after the pause", async () => {
		const r = rig();
		r.timers.request(AGENT, { delaySeconds: 60, note: "a" });
		r.failures.next = 1;
		assert.equal(await r.timers.tick(r.advance(61_000)), 0);
		assert.equal(await r.timers.tick(r.advance(3_000)), 0, "waits before the next attempt");
		assert.equal(await r.timers.tick(r.advance(10_000)), 1);
		assert.equal(r.timers.list(AGENT).length, 0);
		r.done();
	});

	it("refuses what is out of bounds, with a reason", () => {
		const r = rig();
		const refused = (raw: Parameters<Timers["request"]>[1], status: number, why: RegExp, agent = AGENT) => {
			assert.throws(() => r.timers.request(agent, raw), (error: unknown) => error instanceof TimerError && error.status === status && why.test(error.message), JSON.stringify(raw));
		};
		refused({ delaySeconds: 10, note: "x" }, 400, /at least 60/);
		refused({ delaySeconds: 7200, note: "x" }, 400, /at most 3600/);
		refused({ delaySeconds: -5, note: "x" }, 400, /must be a number|at least/);
		refused({ delaySeconds: "soon", note: "x" }, 400, /number of seconds/);
		refused({ at: "tomorrow-ish", note: "x" }, 400, /ISO/);
		refused({ note: "x" }, 400, /either delaySeconds or at/);
		refused({ delaySeconds: 100, at: "2026-10-07T09:00:00Z", note: "x" }, 400, /either delaySeconds or at/);
		refused({ delaySeconds: 100 }, 400, /note is required/);
		refused({ delaySeconds: 100, note: "x".repeat(501) }, 400, /at most 500/);
		refused({ delaySeconds: 100, note: "x", key: "has space" }, 400, /key is/);
		refused({ delaySeconds: 100, note: "x", payload: { big: "y".repeat(3000) } }, 400, /payload is at most/);
		refused({ delaySeconds: 100, note: "x" }, 403, /may not ask/, "agent/stranger");
		for (const n of [1, 2, 3]) r.timers.request(AGENT, { delaySeconds: 100, note: "x", key: `k${n}` });
		refused({ delaySeconds: 100, note: "x", key: "k4" }, 429, /3 timers are pending/);
		assert.doesNotThrow(() => r.timers.request(AGENT, { delaySeconds: 200, note: "moved", key: "k3" }), "moving one needs no free slot");
		r.done();
	});

	it("derives the topic from the agent id", () => {
		assert.equal(timerTopic("agent/aikido-fixer"), "clock.timer.aikido_fixer.due");
		assert.equal(timerTopic("agent/a.b_c"), "clock.timer.a_b_c.due");
	});

	it("is configured only with the clock's producer and a list of valid agents", () => {
		const base = { domain: { url: "http://x" }, receiver: { url: "http://y" } };
		assert.throws(() => parseConfig({ ...base, timers: CONFIG }), /timers need clock.producer/);
		const clock = { producer: { keyFile: "k" } };
		assert.throws(() => parseConfig({ ...base, clock, timers: { agents: [] } }), /at least one agent/);
		assert.throws(() => parseConfig({ ...base, clock, timers: { agents: ["reviewer"] } }), /invalid agent id/);
		assert.throws(() => parseConfig({ ...base, clock, timers: { agents: [AGENT], minDelaySeconds: 100, maxDelaySeconds: 50 } }), /larger than/);
		assert.throws(() => parseConfig({ ...base, clock, timers: { agents: ["agent/a-b", "agent/a_b"] } }), /share one timer topic/);
		assert.deepEqual(parseConfig({ ...base, clock, timers: { agents: [AGENT, AGENT] } }).timers, { agents: [AGENT], minDelaySeconds: 60, maxDelaySeconds: 604800, maxPendingPerAgent: 20 });
	});
});

describe("asking the hub over HTTP", () => {
	const worlds: World[] = [];
	const servers: ReturnType<typeof createHubServer>[] = [];
	afterEach(async () => {
		for (const server of servers.splice(0)) await new Promise((r) => { server.closeAllConnections(); server.close(r); });
		for (const w of worlds.splice(0)) {
			await w.hub.stop().catch(() => {});
			await w.stop();
		}
	});
	const start = async () => {
		const w = await startWorld({ timers: { agents: [AGENT], minDelaySeconds: 1, maxDelaySeconds: 3600 } });
		worlds.push(w);
		const server = createHubServer(w.hub, w.store, SECRET);
		servers.push(server);
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
		const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = { "x-somework-agent": AGENT, authorization: `Bearer ${timerToken(SECRET, AGENT)}` }) =>
			fetch(`${base}${path}`, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
		return { w, call };
	};

	it("takes a request with the agent's own token and delivers the event to the domain when it is due", async () => {
		const { w, call } = await start();
		const created = await call("POST", "/v1/timers", { delaySeconds: 1.2, note: "look at PR 7", key: "pr:7", payload: { pr: 7 } });
		assert.equal(created.status, 201);
		const { id } = (await created.json()) as { id: string };
		assert.deepEqual(((await (await call("GET", "/v1/timers")).json()) as { timers: { key: string }[] }).timers.map((t) => t.key), ["pr:7"]);
		w.hub.start();
		await waitFor(() => w.domain.uniqueEvents === 1 && w.store.pendingTimers(AGENT).length === 0, 8000, "the timer event, and the timer marked as fired");
		assert.equal(w.domain.calls[0]!.issuer, "service:producer/clock");
		assert.equal(w.domain.calls[0]!.body.type ?? w.domain.calls[0]!.body.topic, "clock.timer.aikido_fixer.due");
		await waitFor(() => /hub_timers_total\{agent="agent\/aikido-fixer",outcome="published"\} 1/.test(w.hub.metrics.render()), 8000, "the counter");
		assert.equal((await call("DELETE", `/v1/timers/${id}`)).status, 404, "it already fired");
	});

	it("refuses a missing, wrong or another agent's token, and an unlisted agent", async () => {
		const { call } = await start();
		const body = { delaySeconds: 100, note: "x" };
		assert.equal((await call("POST", "/v1/timers", body, {})).status, 401);
		assert.equal((await call("POST", "/v1/timers", body, { "x-somework-agent": AGENT, authorization: "Bearer nope" })).status, 401);
		assert.equal((await call("POST", "/v1/timers", body, { "x-somework-agent": AGENT, authorization: `Bearer ${timerToken(SECRET, "agent/reviewer")}` })).status, 401);
		assert.equal((await call("POST", "/v1/timers", body, { "x-somework-agent": "agent/reviewer", authorization: `Bearer ${timerToken(SECRET, "agent/reviewer")}` })).status, 401, "listed agents only");
	});

	it("answers a bad request with its reason, and a missing timer with 404", async () => {
		const { call } = await start();
		const tooSoon = await call("POST", "/v1/timers", { delaySeconds: 0.1, note: "x" });
		assert.equal(tooSoon.status, 400);
		assert.match(((await tooSoon.json()) as { error: string }).error, /at least 1 seconds/);
		assert.equal((await call("DELETE", "/v1/timers/tmr_nosuch")).status, 404);
	});

	it("is not there when the hub has no timers", async () => {
		const w = await startWorld();
		worlds.push(w);
		const server = createHubServer(w.hub, w.store, SECRET);
		servers.push(server);
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
		const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/timers`, { headers: { "x-somework-agent": AGENT, authorization: `Bearer ${timerToken(SECRET, AGENT)}` } });
		assert.equal(response.status, 404);
	});
});

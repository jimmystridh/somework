import assert from "node:assert/strict";
import { test } from "node:test";
import { keepRuntimeAlive } from "../src/runtime-lifecycle.ts";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeClient(options: { heartbeatFails?: () => boolean } = {}) {
	const calls: string[] = [];
	return {
		calls,
		client: {
			registerRuntime: async () => void calls.push("register"),
			runtimeHeartbeat: async () => {
				calls.push("heartbeat");
				if (options.heartbeatFails?.()) throw new Error("unknown runtime");
			},
			endRuntime: async () => void calls.push("end"),
		} as never,
	};
}

test("registers at start, beats on an interval and ends on request", async () => {
	const { calls, client } = fakeClient();
	const stop = new AbortController();
	const runtime = keepRuntimeAlive({ client, meta: { role: "qa" }, signal: stop.signal, log: () => {}, intervalMs: 10 });
	await runtime.registered;
	await wait(45);
	await runtime.ended();
	stop.abort();
	assert.equal(calls[0], "register");
	assert.ok(calls.filter((call) => call === "heartbeat").length >= 2);
	assert.equal(calls.at(-1), "end");
});

test("a refused heartbeat registers the runtime again", async () => {
	let refuse = true;
	const { calls, client } = fakeClient({ heartbeatFails: () => refuse });
	const stop = new AbortController();
	keepRuntimeAlive({ client, meta: {}, signal: stop.signal, log: () => {}, intervalMs: 10 });
	await wait(35);
	refuse = false;
	stop.abort();
	assert.ok(calls.filter((call) => call === "register").length >= 2);
});

test("an unreachable domain at start is logged and does not stop the agent", async () => {
	const logged: string[] = [];
	const stop = new AbortController();
	const runtime = keepRuntimeAlive({
		client: { registerRuntime: async () => { throw new Error("down"); }, runtimeHeartbeat: async () => {}, endRuntime: async () => {} } as never,
		meta: {},
		signal: stop.signal,
		log: (_level, event) => void logged.push(event),
		intervalMs: 1000,
	});
	await runtime.registered;
	stop.abort();
	assert.deepEqual(logged, ["runtime_register_failed"]);
});

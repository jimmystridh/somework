import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ResourceRegistry } from "../src/threads/resources.ts";

const who = (holder: string, label = `work of ${holder}`) => ({ holder, label });

describe("singleton resources", () => {
	it("hands a free resource out at once and shows who holds it", async () => {
		const registry = new ResourceRegistry(() => 1000);
		const release = await registry.acquire(["app-stack"], who("job_1", "verification of SAD-1"));
		assert.deepEqual(registry.holders(), [{ resource: "app-stack", holder: "job_1", label: "verification of SAD-1", since: 1000 }]);
		release();
		release();
		assert.deepEqual(registry.holders(), []);
	});

	it("needs no waiting for no resources, and unrelated resources do not block each other", async () => {
		const registry = new ResourceRegistry();
		await registry.acquire([], who("a"));
		const a = await registry.acquire(["one"], who("a"));
		const b = await registry.acquire(["two"], who("b"));
		assert.equal(registry.holders().length, 2);
		a();
		b();
	});

	it("makes a second job wait, tells it what is in the way once, and serves waiters in order", async () => {
		const registry = new ResourceRegistry();
		const first = await registry.acquire(["app-stack"], who("job_1", "verification of SAD-1"));
		const told: string[][] = [];
		const order: string[] = [];
		const second = registry.acquire(["app-stack"], who("job_2"), { onWait: (blocking) => told.push(blocking.map((hold) => `${hold.holder}:${hold.label}`)) }).then((release) => (order.push("job_2"), release));
		const third = registry.acquire(["app-stack"], who("job_3")).then((release) => (order.push("job_3"), release));
		await Promise.resolve();
		assert.deepEqual(told, [["job_1:verification of SAD-1"]]);
		assert.deepEqual(registry.waiting().map((entry) => entry.holder), ["job_2", "job_3"]);
		first();
		(await second)();
		(await third)();
		assert.deepEqual(order, ["job_2", "job_3"]);
	});

	it("takes everything or nothing, and a person's request goes ahead of automated ones", async () => {
		const registry = new ResourceRegistry();
		const holdsB = await registry.acquire(["b"], who("job_b"));
		const order: string[] = [];
		const automated = registry.acquire(["a", "b"], who("job_auto"), { priority: 0 }).then((release) => (order.push("auto"), release));
		const person = registry.acquire(["b"], who("job_person"), { priority: 10 }).then((release) => (order.push("person"), release));
		await Promise.resolve();
		assert.equal(registry.holderOf("a"), undefined, "a is not taken while b is missing");
		holdsB();
		const releasePerson = await person;
		assert.deepEqual(order, ["person"]);
		releasePerson();
		(await automated)();
		assert.deepEqual(order, ["person", "auto"]);
	});

	it("does not let a later request overtake an earlier one for the same resource", async () => {
		const registry = new ResourceRegistry();
		const holdsA = await registry.acquire(["a"], who("holder"));
		const order: string[] = [];
		const wantsAB = registry.acquire(["a", "b"], who("ab")).then((release) => (order.push("ab"), release));
		const wantsB = registry.acquire(["b"], who("b-only")).then((release) => (order.push("b-only"), release));
		await Promise.resolve();
		holdsA();
		(await wantsAB)();
		(await wantsB)();
		assert.deepEqual(order, ["ab", "b-only"]);
	});

	it("stops waiting when its signal aborts, and lets the next one in", async () => {
		const registry = new ResourceRegistry();
		const held = await registry.acquire(["x"], who("holder"));
		const stop = new AbortController();
		const waiting = registry.acquire(["x"], who("stopped"), { signal: stop.signal });
		const next = registry.acquire(["x"], who("next"));
		stop.abort();
		await assert.rejects(waiting, /stopped while waiting for x/);
		held();
		(await next)();
		assert.deepEqual(registry.holders(), []);
	});
});

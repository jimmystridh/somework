import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sleep } from "@somework/sdk";
import { startWorker } from "../src/worker.ts";
import { rig, MINUTE, thinBug } from "./rig.ts";

const fakeEngine = (over: { tick?: () => Promise<unknown[]>; recover?: () => number } = {}) => {
	const calls = { tick: 0, recover: 0 };
	return { calls, engine: { tick: async () => (calls.tick++, over.tick ? over.tick() : []), recover: () => (calls.recover++, over.recover ? over.recover() : 0) } as never };
};

describe("the clock of the triage", () => {
	it("revives what a restart interrupted, looks at the queue at once and then on every beat", async () => {
		const { calls, engine } = fakeEngine({ recover: () => 2 });
		const logs: string[] = [];
		const worker = startWorker({ engine, intervalMs: 20, log: (_level, event) => void logs.push(event) });
		await sleep(110);
		worker.stop();
		assert.equal(calls.recover, 1);
		assert.ok(calls.tick >= 3, `ticks: ${calls.tick}`);
		assert.deepEqual(logs, ["jira_triage_recovered"]);
		const after = calls.tick;
		await sleep(60);
		assert.equal(calls.tick, after, "stopped");
	});

	it("never looks at the queue twice at the same time, even when a look takes longer than the beat", async () => {
		let running = 0;
		let overlapped = false;
		const { engine } = fakeEngine({
			tick: async () => {
				running += 1;
				overlapped ||= running > 1;
				await sleep(60);
				running -= 1;
				return [];
			},
		});
		const worker = startWorker({ engine, intervalMs: 10 });
		await sleep(250);
		worker.stop();
		assert.equal(overlapped, false);
	});

	it("survives a failing look: it is logged and the next beat tries again", async () => {
		let attempts = 0;
		const logs: { event: string; fields: any }[] = [];
		const { engine } = fakeEngine({
			tick: async () => {
				attempts += 1;
				if (attempts === 1) throw new Error("disk full");
				return [];
			},
		});
		const worker = startWorker({ engine, intervalMs: 15, log: (_level, event, fields) => void logs.push({ event, fields }) });
		await sleep(120);
		worker.stop();
		assert.ok(attempts >= 2);
		assert.equal(logs.find((log) => log.event === "jira_triage_tick_failed")?.fields.error, "disk full");
	});

	it("drives the real engine: a ticket whose time has come is taken up by the beat", async () => {
		const world = rig({ issues: [thinBug()], developer: false });
		world.jira.down = true;
		await world.engine.handle("SAD-1", { kind: "created" });
		world.jira.down = false;
		world.advance(2 * MINUTE);
		const worker = startWorker({ engine: world.engine, intervalMs: 1_000 });
		await sleep(100);
		worker.stop();
		assert.equal(world.record().phase, "awaiting_reporter");
		assert.equal(world.slack!.posted.length, 1);
	});

	it("a pass that is asked for after the worker stopped does nothing", async () => {
		const { calls, engine } = fakeEngine();
		const worker = startWorker({ engine, intervalMs: 1_000 });
		await sleep(30);
		worker.stop();
		const before = calls.tick;
		assert.equal(await worker.pass(), 0);
		assert.equal(calls.tick, before);
	});
});

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Handler, Outcome } from "@somework/sdk";
import { JobGate } from "../src/gate.ts";
import { JobManager, type JobEntry, type JobReporter, type JobSpec } from "../src/threads/jobs.ts";
import { ResourceRegistry } from "../src/threads/resources.ts";
import { DurableTable } from "../src/threads/store.ts";

const spec = (label: string, extra: Partial<JobSpec> = {}): JobSpec => ({
	capability: { id: "test.verify", version: "1" },
	input: { ticket: label },
	label,
	requestedBy: { kind: "human", id: "user/jimmy" },
	conversationId: "conv_1",
	replyTo: "msg_1",
	source: "message",
	...extra,
});

const completed = (summary: string): Outcome => ({ type: "completed", result: { summary } });
const tick = (ms = 5): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function setup(handler: Handler, options: { steer?: (id: string, text: string) => Promise<boolean>; signal?: AbortSignal; file?: string; approve?: (entry: JobEntry) => Promise<{ approved: boolean }> } = {}) {
	const events: string[] = [];
	const reports: { entry: JobEntry; outcome: Outcome | undefined; artifacts: unknown[] }[] = [];
	const reporter: JobReporter = {
		waiting: async (entry, blocking) => void events.push(`waiting ${entry.label} on ${blocking.map((hold) => hold.label).join(",")}`),
		started: async (entry) => void events.push(`started ${entry.label}`),
		finished: async (entry, outcome, artifacts) => {
			events.push(`finished ${entry.label} ${entry.end?.kind}`);
			reports.push({ entry, outcome, artifacts });
		},
	};
	const file = options.file ?? join(mkdtempSync(join(tmpdir(), "jobs-")), "jobs.json");
	const manager = new JobManager({
		handler,
		resources: new ResourceRegistry(),
		gate: new JobGate(4),
		store: new DurableTable<JobEntry>(file),
		reporter,
		takeArtifacts: (id) => (id ? [{ artifactId: `art-for-${id.slice(0, 4)}` }] : []),
		steer: options.steer ?? (async () => true),
		approve: async (entry) => options.approve?.(entry) ?? { approved: true },
		budget: { maxTokens: 1000, maxMinutes: 1 },
		signal: options.signal,
		noteRetryMs: 5,
	});
	return { manager, events, reports, file };
}

describe("jobs", () => {
	it("runs a job in the background and reports its end once, with the artifacts it uploaded", async () => {
		const { manager, events, reports } = setup(async () => completed("all green"));
		const entry = manager.start(spec("SAD-1"));
		assert.match(entry.id, /^job-/);
		assert.equal(manager.get(entry.id)?.state, "waiting");
		await manager.idle();
		assert.deepEqual(events, ["started SAD-1", "finished SAD-1 completed"]);
		assert.equal(reports.length, 1);
		assert.equal(reports[0]!.artifacts.length, 1);
		assert.equal(manager.get(entry.id)?.end?.summary, "all green");
		assert.equal(manager.active().length, 0);
		assert.equal(manager.recent()[0]?.id, entry.id);
	});

	it("gives the handler a synthetic job with the job's id, its input and a default budget", async () => {
		let seen: any;
		const { manager } = setup(async (job) => {
			seen = job;
			return completed("ok");
		});
		const entry = manager.start(spec("SAD-2"));
		await manager.idle();
		assert.equal(seen.taskId, entry.id);
		assert.equal(seen.input.ticket, "SAD-2");
		assert.deepEqual(seen.input.budget, { maxTokens: 1000, maxMinutes: 1 });
		assert.equal(seen.task.conversationId, "conv_1");
	});

	it("makes a second job for a singleton resource wait, says what it waits for, and runs it when the first is done", async () => {
		let open: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => (open = resolve));
		const order: string[] = [];
		const { manager, events } = setup(async (job) => {
			order.push(String(job.input.ticket));
			if (job.input.ticket === "first") await gate;
			return completed("ok");
		});
		const first = manager.start(spec("first", { resources: ["app-stack"] }));
		await tick();
		const second = manager.start(spec("second", { resources: ["app-stack"] }));
		await tick();
		assert.equal(manager.get(first.id)?.state, "running");
		assert.equal(manager.get(second.id)?.state, "waiting");
		assert.match(manager.get(second.id)?.waitingFor ?? "", /app-stack \(held by first\)/);
		assert.ok(events.includes("waiting second on first"));
		open();
		await manager.idle();
		assert.deepEqual(order, ["first", "second"]);
	});

	it("lets jobs without a shared resource run side by side", async () => {
		let running = 0;
		let peak = 0;
		const { manager } = setup(async () => {
			running += 1;
			peak = Math.max(peak, running);
			await tick(20);
			running -= 1;
			return completed("ok");
		});
		manager.start(spec("a"));
		manager.start(spec("b"));
		await manager.idle();
		assert.equal(peak, 2);
	});

	it("does not start a job that was stopped while it waited, and says it was cancelled", async () => {
		let open: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => (open = resolve));
		const { manager, events } = setup(async (job) => {
			if (job.input.ticket === "first") await gate;
			return completed("ok");
		});
		manager.start(spec("first", { resources: ["app-stack"] }));
		await tick();
		const second = manager.start(spec("second", { resources: ["app-stack"] }));
		await tick();
		assert.equal(await manager.stop(second.id, { kind: "human", id: "user/jimmy" }), "cancelled");
		await tick();
		assert.equal(manager.get(second.id)?.end?.kind, "cancelled");
		assert.ok(!events.includes("started second"));
		open();
		await manager.idle();
	});

	it("tells a running job that it was asked to stop and leaves the decision to its model", async () => {
		const notes: string[] = [];
		let open: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => (open = resolve));
		const { manager } = setup(async () => (await gate, completed("wrapped up")), { steer: async (_id, text) => (notes.push(text), true) });
		const job = manager.start(spec("long"));
		await tick();
		assert.equal(await manager.stop(job.id, { kind: "human", id: "user/jimmy" }, "wrong ticket"), "told");
		assert.equal(notes.length, 1);
		assert.match(notes[0]!, /user\/jimmy asks you to stop: wrong ticket/);
		assert.equal(manager.get(job.id)?.state, "running");
		open();
		await manager.idle();
		assert.equal(manager.get(job.id)?.end?.summary, "wrapped up");
		assert.equal(await manager.stop(job.id, { kind: "human", id: "user/jimmy" }), "finished");
		assert.equal(await manager.stop("job-none", { kind: "human", id: "x" }), "unknown");
	});

	it("keeps a note until the model run of the job can take it", async () => {
		const delivered: string[] = [];
		let ready = false;
		let open: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => (open = resolve));
		const { manager } = setup(async () => (await gate, completed("ok")), {
			steer: async (_id, text) => {
				if (!ready) return false;
				delivered.push(text);
				return true;
			},
		});
		const job = manager.start(spec("long"));
		await tick();
		await manager.note(job.id, "also check the footer");
		assert.deepEqual(delivered, []);
		ready = true;
		await tick(30);
		assert.deepEqual(delivered, ["also check the footer"]);
		open();
		await manager.idle();
	});

	it("leaves a job running at shutdown without reporting it, and picks it up again under the same id", async () => {
		const stop = new AbortController();
		let runs = 0;
		const { manager, events, file } = setup(
			async (_job, control) => {
				runs += 1;
				await new Promise<void>((resolve) => control.signal.addEventListener("abort", () => resolve(), { once: true }));
				return { type: "detach" };
			},
			{ signal: stop.signal },
		);
		const job = manager.start(spec("long"));
		await tick();
		stop.abort();
		await manager.idle();
		assert.equal(manager.get(job.id)?.state, "running");
		assert.ok(!events.some((line) => line.startsWith("finished")));

		const reopened = setup(async () => completed("resumed"), { file });
		const recovered = reopened.manager.recover();
		assert.deepEqual(recovered.map((entry) => entry.id), [job.id]);
		await reopened.manager.idle();
		assert.equal(runs, 1);
		assert.equal(reopened.manager.get(job.id)?.end?.summary, "resumed");
	});

	it("asks for approval through the manager and gives the model the decision", async () => {
		let asked: string | undefined;
		let answer: unknown;
		const { manager } = setup(
			async (_job, control) => {
				answer = await control.requestInput({ tool: "bash", summary: "run the migration" });
				return completed("ok");
			},
			{ approve: async (entry) => ((asked = entry.label), { approved: false }) },
		);
		manager.start(spec("SAD-3"));
		await manager.idle();
		assert.equal(asked, "SAD-3");
		assert.deepEqual(answer, { approved: false });
	});

	it("reports a failing handler as a failed job", async () => {
		const { manager, reports } = setup(async () => {
			throw new Error("sandbox gone");
		});
		manager.start(spec("SAD-4"));
		await manager.idle();
		assert.equal(reports[0]?.entry.end?.kind, "failed");
		assert.match(reports[0]?.entry.end?.summary ?? "", /sandbox gone/);
	});
});

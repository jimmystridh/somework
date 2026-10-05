import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { sleep } from "../src/backoff.ts";
import { Worker, type Handler, type WorkerOptions } from "../src/worker.ts";
import { approve, review, startDomain, type Domain } from "./harness.ts";

let domain: Domain;
before(async () => {
	domain = await startDomain();
});
after(async () => {
	await domain.close();
});

/** Starts a worker for the test and returns a stop function that also waits for run() to finish. */
function runWorker(handler: Handler, options: Partial<WorkerOptions> = {}) {
	const abort = new AbortController();
	const worker = new Worker(domain.worker(), { handler, leaseSeconds: 2, progressThrottleMs: 50, shutdownGraceMs: 3000, ...options });
	const finished = worker.run(abort.signal);
	return {
		stop: async () => {
			abort.abort();
			await finished;
		},
	};
}

const submit = async (text?: string) => (await domain.author.submitTask(review(text))).taskId as string;
const terminal = (taskId: string, ms = 30_000) => domain.author.waitTerminal(taskId, ms);

describe("worker", () => {
	it("claims a task, reports progress and completes it", async () => {
		const seen: string[] = [];
		const worker = runWorker(async (job, control) => {
			seen.push(job.input.text);
			control.progress({ message: "reading", percent: 50 });
			return approve;
		});
		const task = await terminal(await submit("hello"));
		await worker.stop();
		assert.equal(task.state, "succeeded");
		assert.equal(task.result.verdict, "approve");
		assert.deepEqual(seen, ["hello"]);
	});

	it("reports a handler failure and a thrown error as failures", async () => {
		let calls = 0;
		const worker = runWorker(async () => {
			calls += 1;
			if (calls === 1) return { type: "failed", failure: { code: "repo_unreachable", message: "cannot clone", retryable: false } };
			throw new Error("boom");
		});
		const failed = await terminal(await submit());
		const thrown = await terminal(await submit());
		await worker.stop();
		assert.equal(failed.state, "failed");
		assert.equal(failed.failure.code, "repo_unreachable");
		assert.equal(thrown.state, "failed");
		assert.equal(thrown.failure.code, "handler_error");
	});

	it("detach reports nothing; the lapsed lease re-queues the task and a later claim finishes it", async () => {
		let calls = 0;
		const worker = runWorker(async () => {
			calls += 1;
			return calls === 1 ? { type: "detach" } : approve;
		});
		const task = await terminal(await submit());
		await worker.stop();
		assert.equal(task.state, "succeeded");
		assert.equal(task.attempt, 2, "the retry is a second attempt of the same task");
		assert.equal(calls, 2);
	});

	it("tells running handlers `shutdown` and leaves the work for the next worker", async () => {
		let reason: string | undefined;
		let started: () => void = () => {};
		const running = new Promise<void>((resolve) => (started = resolve));
		const first = runWorker(async (_job, control) => {
			started();
			await new Promise((resolve) => control.signal.addEventListener("abort", resolve, { once: true }));
			reason = control.stopReason;
			return { type: "detach" };
		});
		const taskId = await submit();
		await running;
		await first.stop();
		assert.equal(reason, "shutdown");
		const second = runWorker(async () => approve);
		const task = await terminal(taskId);
		await second.stop();
		assert.equal(task.state, "succeeded");
		assert.equal(task.attempt, 2);
	});

	it("tells the handler `cancel_requested` and acknowledges a requester cancel", async () => {
		let reason: string | undefined;
		let started: () => void = () => {};
		const running = new Promise<void>((resolve) => (started = resolve));
		const worker = runWorker(async (_job, control) => {
			started();
			await new Promise((resolve) => control.signal.addEventListener("abort", resolve, { once: true }));
			reason = control.stopReason;
			return { type: "failed", failure: { code: "stopped", message: "stopped on request", retryable: false } };
		});
		const taskId = await submit();
		await running;
		await domain.author.cancelTask(taskId, "no longer needed");
		const task = await terminal(taskId);
		await worker.stop();
		assert.equal(reason, "cancel_requested");
		assert.equal(task.state, "canceled");
	});

	for (const concurrency of [1, 2]) {
		it(`runs at most ${concurrency} handler(s) at once`, async () => {
			let active = 0;
			let peak = 0;
			const worker = runWorker(
				async () => {
					active += 1;
					peak = Math.max(peak, active);
					await sleep(400);
					active -= 1;
					return approve;
				},
				{ concurrency },
			);
			const ids = await Promise.all([submit(), submit(), submit()]);
			for (const id of ids) assert.equal((await terminal(id)).state, "succeeded");
			await worker.stop();
			assert.equal(peak, concurrency);
		});
	}

	it("keeps working through a domain outage: backs off, reconnects, and serves the next task", async () => {
		const worker = runWorker(async () => approve);
		assert.equal((await terminal(await submit())).state, "succeeded");
		await domain.stop();
		await sleep(2500); // several failed polls while the domain is down
		await domain.start();
		const task = await terminal(await submit(), 40_000);
		await worker.stop();
		assert.equal(task.state, "succeeded");
	});

	it("ends its runtime on a graceful stop", async () => {
		const client = domain.worker();
		const abort = new AbortController();
		const worker = new Worker(client, { handler: async () => approve });
		const finished = worker.run(abort.signal);
		await sleep(500);
		abort.abort();
		await finished;
		await assert.rejects(() => client.runtimeHeartbeat(), /./, "the ended runtime can no longer heartbeat");
	});
});

describe("worker: asking the requester", () => {
	it("waits in input_required, continues with the requester's answer, and rejects if the job is cancelled meanwhile", async () => {
		let answer: unknown;
		const worker = runWorker(async (_job, control) => {
			answer = await control.requestInput({ prompt: "delete the branch?" });
			return approve;
		});
		const taskId = await submit();
		let waiting;
		for (let i = 0; i < 100 && waiting?.state !== "input_required"; i++) {
			await sleep(100);
			waiting = await domain.author.getTask(taskId);
		}
		assert.equal(waiting.state, "input_required");
		await domain.author.provideInput(taskId, { approved: true });
		const task = await terminal(taskId);
		assert.equal(task.state, "succeeded");
		assert.deepEqual(answer, { approved: true });
		await worker.stop();

		let rejected: string | undefined;
		const second = runWorker(async (_job, control) => {
			try {
				await control.requestInput({ prompt: "again?" });
			} catch (error) {
				rejected = String(error);
			}
			return { type: "detach" };
		});
		const cancelled = await submit();
		for (let i = 0; i < 100 && (await domain.author.getTask(cancelled)).state !== "input_required"; i++) await sleep(100);
		await domain.author.cancelTask(cancelled, "never mind");
		assert.equal((await terminal(cancelled)).state, "canceled");
		await second.stop();
		assert.match(rejected ?? "", /stopped while waiting for input|became/);
	});
});

describe("artifacts", () => {
	it("uploads bytes and returns a verified reference", async () => {
		const ref = await domain.author.uploadArtifact({ filename: "patch.diff", mediaType: "text/plain", bytes: "diff --git a b\n" });
		assert.equal(typeof ref.artifactId, "string");
		assert.equal(ref.sizeBytes, 15);
		assert.match(ref.digest.algorithm, /sha-?256/);
		assert.equal(ref.digest.value, createHash("sha256").update("diff --git a b\n").digest("hex"));
	});
});

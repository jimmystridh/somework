import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { sleep } from "../src/backoff.ts";
import { interpret, natsInfoFrom, NatsWakeSource, wakes } from "../src/wake.ts";
import { Worker, type Handler, type WorkerOptions } from "../src/worker.ts";
import { approve, review, startDomain, type Domain } from "./harness.ts";

const SWEEP_MS = 25_000;
const FAST_POLL_MS = 150;

let domain: Domain;
before(async () => {
	domain = await startDomain({ nats: true });
});
after(async () => {
	await domain.close();
});

async function until(what: string, ms: number, condition: () => boolean): Promise<void> {
	const deadline = Date.now() + ms;
	while (!condition()) {
		if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
		await sleep(50);
	}
}

function runWorker(handler: Handler, options: Partial<WorkerOptions> = {}) {
	const abort = new AbortController();
	const logs: string[] = [];
	const worker = new Worker(domain.worker(), {
		handler,
		leaseSeconds: 5,
		progressThrottleMs: 50,
		shutdownGraceMs: 3000,
		sweepEveryMs: SWEEP_MS,
		pollEveryMs: FAST_POLL_MS,
		logger: (_level, message) => logs.push(message),
		...options,
	});
	const finished = worker.run(abort.signal);
	return {
		logs,
		connections: () => logs.filter((message) => message === "NATS wake connected").length,
		stop: async () => {
			abort.abort();
			await finished;
		},
	};
}

const submit = async () => (await domain.author.submitTask(review())).taskId as string;
const terminal = (taskId: string, ms = 30_000) => domain.author.waitTerminal(taskId, ms);

describe("NATS wake", () => {
	it("picks a task up in well under the sweep interval, and never holds a request open", async () => {
		const started = new Map<string, number>();
		const worker = runWorker(async (job) => {
			started.set(job.taskId, Date.now());
			return approve;
		});
		await until("the worker to connect to NATS", 30_000, () => worker.connections() === 1);

		const submittedAt = Date.now();
		const taskId = await submit();
		assert.equal((await terminal(taskId)).state, "succeeded");
		const latency = (started.get(taskId) ?? Infinity) - submittedAt;
		await worker.stop();

		assert.ok(latency < 2000, `picked up after ${latency} ms: the NATS notification, not the ${SWEEP_MS} ms sweep, woke the worker`);
		const lookups = domain.requests.filter((line) => line.includes("/v1/tasks/next") || line.includes("/v1/events"));
		assert.ok(lookups.length > 0, "the HTTP sweep ran at least once");
		assert.ok(lookups.every((line) => /[?&]wait=0(&|$)/.test(line)), `no lookup may be held open: ${lookups.filter((line) => !/[?&]wait=0(&|$)/.test(line)).join(", ")}`);
	});

	it("keeps working through a broker outage over HTTP and returns to NATS afterwards", async () => {
		const worker = runWorker(async () => approve);
		await until("the worker to connect to NATS", 30_000, () => worker.connections() === 1);
		assert.equal((await terminal(await submit())).state, "succeeded");

		await domain.nats!.stop();
		await until("the worker to notice the lost broker", 15_000, () => worker.logs.includes("NATS wake lost; falling back to HTTP and reconnecting") || worker.logs.includes("NATS wake unavailable; polling over HTTP meanwhile"));

		const whileDown = await submit(); // submitted with no broker: found by the HTTP fallback
		const outageStarted = Date.now();
		assert.equal((await terminal(whileDown, 20_000)).state, "succeeded");
		assert.ok(Date.now() - outageStarted < SWEEP_MS, "found by short polling, not by waiting for a sweep");

		await domain.nats!.start();
		await until("the worker to reconnect to NATS", 60_000, () => worker.connections() === 2);

		const submittedAt = Date.now();
		const afterwards = await submit();
		assert.equal((await terminal(afterwards, 20_000)).state, "succeeded");
		assert.ok(Date.now() - submittedAt < 10_000, "woken by NATS again, not by the 25 s sweep");
		await worker.stop();
	});

	it("refuses a plaintext broker when TLS is required", async () => {
		const info = natsInfoFrom(await domain.worker().connection());
		assert.ok(info, "the domain offers NATS");
		await assert.rejects(() => NatsWakeSource.connect(info, "agent/ts-worker", { requireTls: true }, () => {}), /./);
	});

	it("streams wakes to a requester-style consumer", async () => {
		const abort = new AbortController();
		const client = domain.worker();
		await client.registerRuntime({ sdk: "test" });
		const stream = wakes(client, abort.signal, { kinds: ["task"], sweepEveryMs: SWEEP_MS, pollEveryMs: FAST_POLL_MS });
		const taskId = await submit();
		const first = await Promise.race([stream.next(), sleep(20_000).then(() => undefined)]);
		abort.abort();
		await stream.return(undefined);
		assert.ok(first && !first.done, "a wake arrived");
		assert.deepEqual([first.value.kind, (first.value as { taskId: string }).taskId], ["task", taskId]);
		await first.value.ack();
		const claim = await client.claimTask(taskId); // leave the queue clean for later tests
		await client.progressTask(taskId, { fencingToken: claim.fencingToken, status: "running" });
		await client.completeTask(taskId, claim.fencingToken, approve.result);
	});
});

describe("wake interpretation", () => {
	it("reads the connection block, with object or bare pool consumers", () => {
		const base = { url: "nats://h:4222", user: "u", password: "p", workStream: "W", inboxStream: "I", inboxConsumer: "inbox-1" };
		assert.deepEqual(natsInfoFrom({ nats: { ...base, poolConsumers: [{ stream: "W2", consumer: "c1" }, "c2"] } })?.poolConsumers, [
			{ stream: "W2", consumer: "c1" },
			{ stream: "W", consumer: "c2" },
		]);
		assert.equal(natsInfoFrom({ nats: { urls: ["nats://a:1"] } })?.url, "nats://a:1");
		assert.equal(natsInfoFrom({}), undefined);
	});

	it("maps pool and inbox notifications and ignores the agent's own and non-waking ones", () => {
		assert.deepEqual(interpret({ taskId: "t1", revision: 3 }, false, "agent/me"), { kind: "task", taskId: "t1", dedupeKey: "task:t1:3" });
		assert.equal(interpret({ revision: 3 }, false, "agent/me"), undefined);
		assert.deepEqual(interpret({ wake: true, kind: "message", messageId: "m1", sender: "agent/other" }, true, "agent/me"), { kind: "message", messageId: "m1", dedupeKey: "msg:m1" });
		assert.deepEqual(interpret({ wake: true, kind: "task", taskId: "t2", event: "task.completed", eventId: "e9" }, true, "agent/me"), { kind: "taskEvent", taskId: "t2", event: "task.completed", dedupeKey: "evt:e9" });
		assert.equal(interpret({ wake: false, kind: "message", messageId: "m2" }, true, "agent/me"), undefined);
		assert.equal(interpret({ wake: true, kind: "message", messageId: "m3", sender: "agent/me" }, true, "agent/me"), undefined);
	});
});

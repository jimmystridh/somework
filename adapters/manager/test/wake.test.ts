import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { Worker, type Wake } from "@somework/sdk";
import { startDomain, type Domain } from "../../../sdk/typescript/test/harness.ts";
import { TelegramBridge } from "../src/bridge.ts";
import { RestDomain } from "../src/domain.ts";
import { InboxReader, Notifications, TaskTracker, WakeFeed } from "../src/notifier.ts";
import { defaultPolicy } from "../src/policy.ts";
import { ManagerService } from "../src/service.ts";
import { FakeDomain, message, recordingApi, stubRpc } from "./helpers.ts";

const here = dirname(fileURLToPath(import.meta.url));

async function until<T>(read: () => T | undefined | false, what: string, ms = 30_000): Promise<T> {
	const deadline = Date.now() + ms;
	for (;;) {
		const value = read();
		if (value) return value;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

describe("the wake feed with a scripted source", () => {
	it("a task wake checks that task, a message wake drains the inbox, and each is acknowledged", async () => {
		const domain = new FakeDomain();
		const telegram = recordingApi();
		const notifications = new Notifications();
		const state: any = { allowedUserId: 42, chatId: 42 };
		const tracker = new TaskTracker(domain, state, async () => {}, notifications);
		const bridge = new TelegramBridge({ state, api: telegram.api, rpc: stubRpc().rpc, save: async () => {}, tracker, notifications });
		const service = new ManagerService({ domain, policy: defaultPolicy, owner: bridge, tracker });
		await service.submit({ capability: { id: "code.review", version: "2" } });
		domain.tasks.task_1 = { taskId: "task_1", state: "succeeded", result: { summary: "done" } };
		domain.unread = [{ messageId: "m1", from: "agent/x", text: "psst", type: "chat.message" }];

		const acked: string[] = [];
		const make = (wake: object, key: string): Wake => ({ ...wake, dedupeKey: key, ack: async () => void acked.push(key) }) as Wake;
		async function* source() {
			yield make({ kind: "taskEvent", taskId: "task_1", event: "task.succeeded" }, "evt:1");
			yield make({ kind: "message", messageId: "m1" }, "msg:m1");
			yield make({ kind: "taskEvent", taskId: "task_foreign", event: "task.succeeded" }, "evt:2");
		}
		const feed = new WakeFeed({} as never, tracker, new InboxReader(domain, notifications), { source: () => source(), sweepEveryMs: 3_600_000 });
		const controller = new AbortController();
		await feed.run(controller.signal.aborted ? controller.signal : AbortSignal.timeout(300)).catch(() => {});
		assert.deepEqual(acked, ["evt:1", "msg:m1", "evt:2"]);
		assert.ok(telegram.texts().some((t) => t.includes("succeeded") && t.includes("done")));
		assert.ok(telegram.texts().includes("[agent/x] psst"));
	});

	it("a wake that fails is not acknowledged", async () => {
		const domain = new FakeDomain();
		const notifications = new Notifications();
		const tracker = new TaskTracker(domain, { tasks: { task_1: { taskId: "task_1", capability: "x@1", submittedAt: "", state: "queued" } } }, async () => {}, notifications);
		domain.getTask = async () => {
			throw new Error("domain down");
		};
		const acked: string[] = [];
		const logs: string[] = [];
		async function* source() {
			yield { kind: "taskEvent", taskId: "task_1", event: "e", dedupeKey: "k", ack: async () => void acked.push("k") } as Wake;
		}
		const feed = new WakeFeed({} as never, tracker, new InboxReader(domain, notifications), { source: () => source(), sweepEveryMs: 3_600_000 }, (event) => logs.push(event));
		await feed.run(AbortSignal.timeout(200));
		assert.deepEqual(acked, []);
		assert.ok(logs.includes("wake_failed"));
	});
});

describe("the wake feed over real NATS", () => {
	let domain: Domain;
	const stop = new AbortController();
	const telegram = recordingApi();
	const running: Promise<unknown>[] = [];
	let tracker: TaskTracker;
	let service: ManagerService;

	before(async () => {
		domain = await startDomain({ cardFile: join(here, "fixtures", "manager-card.json"), nats: true });
		const rest = new RestDomain(domain.author);
		const notifications = new Notifications();
		const state: any = { allowedUserId: 42, chatId: 42 };
		tracker = new TaskTracker(rest, state, async () => {}, notifications);
		const bridge = new TelegramBridge({ state, api: telegram.api, rpc: stubRpc().rpc, save: async () => {}, tracker, notifications });
		service = new ManagerService({ domain: rest, policy: defaultPolicy, owner: bridge, tracker });
		bridge.service = service;
		const feed = new WakeFeed(domain.author, tracker, new InboxReader(rest, notifications), { sweepEveryMs: 3_600_000, activeTaskEveryMs: 300 });
		running.push(feed.run(stop.signal));
		const worker = new Worker(domain.worker(), { handler: async (job) => ({ type: "completed", result: { echo: job.input.text, summary: "echoed" } }), leaseSeconds: 15 });
		running.push(worker.run(stop.signal));
	});

	after(async () => {
		stop.abort();
		await Promise.race([Promise.allSettled(running), new Promise((resolve) => setTimeout(resolve, 5000))]);
		await (domain.close ?? domain.stop)();
	});

	it("tells the owner a task finished within seconds: the active-task lookup notices it, the hour-long inbox sweep is not needed", async () => {
		await new Promise((resolve) => setTimeout(resolve, 1500));
		const submitted: any = await service.submit({ capability: { id: "code.echo", version: "1" }, input: { text: "wake me" } });
		const started = Date.now();
		await until(() => telegram.texts().find((t) => t.includes(submitted.taskId) && t.includes("succeeded")), "the result via NATS wake", 10_000).catch(async (error) => {
			throw new Error(`${error.message}; task=${JSON.stringify(await domain.author.getTask(submitted.taskId))}; tracked=${JSON.stringify(tracker.tasks)}; texts=${JSON.stringify(telegram.texts())}`);
		});
		assert.ok(Date.now() - started < 8000);
	});

	it("forwards an agent's message promptly", async () => {
		await domain.worker().post("/v1/messages", { recipients: [{ kind: "agent", id: "agent/ts-author" }], content: { mediaType: "text/plain", data: "ping via nats" }, triggerMode: "directed" });
		await until(() => telegram.texts().includes("[agent/ts-worker] ping via nats"), "the forwarded message", 10_000);
	});
});

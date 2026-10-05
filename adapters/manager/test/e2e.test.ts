import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { Worker, type Handler } from "@somework/sdk";
import { startDomain, type Domain } from "../../../sdk/typescript/test/harness.ts";
import { TelegramBridge } from "../src/bridge.ts";
import { RestDomain } from "../src/domain.ts";
import { createGateway } from "../src/gateway.ts";
import { InboxReader, Notifications, PollingFeed, TaskTracker } from "../src/notifier.ts";
import { defaultPolicy } from "../src/policy.ts";
import { ManagerService } from "../src/service.ts";
import { message, recordingApi, stubRpc } from "./helpers.ts";

const here = dirname(fileURLToPath(import.meta.url));
const TOKEN = "e".repeat(40);

async function until<T>(read: () => T | undefined | false, what: string, ms = 30_000): Promise<T> {
	const deadline = Date.now() + ms;
	for (;;) {
		const value = read();
		if (value) return value;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

describe("the Manager against a real domain", () => {
	let domain: Domain;
	let server: Server;
	let url: string;
	let handler: Handler = async () => ({ type: "failed", failure: { code: "not_set", message: "no handler", retryable: false } });
	const stop = new AbortController();
	const telegram = recordingApi();
	const state: any = { allowedUserId: 42, chatId: 42 };
	let tracker: TaskTracker;
	let bridge: TelegramBridge;
	let service: ManagerService;
	let running: Promise<void>[] = [];
	let worker: Worker;
	const tasksOfAuthor = async (): Promise<any[]> => (await domain.author.get("/v1/tasks?limit=200")).tasks ?? [];

	const call = (method: string, path: string, body?: unknown) =>
		fetch(`${url}${path}`, { method, headers: { authorization: `Bearer ${TOKEN}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
	const say = (text: string, extra: Record<string, unknown> = {}) => bridge.handleUpdate({ message: message(text, 42, extra) });
	const messages = () => telegram.texts();

	before(async () => {
		domain = await startDomain({ cardFile: join(here, "fixtures", "manager-card.json") });
		const rest = new RestDomain(domain.author);
		const notifications = new Notifications();
		tracker = new TaskTracker(rest, state, async () => {}, notifications);
		bridge = new TelegramBridge({ state, api: telegram.api, rpc: stubRpc().rpc, save: async () => {}, tracker, notifications });
		service = new ManagerService({ domain: rest, policy: defaultPolicy, owner: bridge, tracker });
		bridge.service = service;
		server = createGateway({ service, token: TOKEN });
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		running.push(new PollingFeed(tracker, new InboxReader(rest, notifications), { taskIntervalMs: 100, inboxIntervalMs: 150, maxBackoffMs: 500 }).run(stop.signal));
		worker = new Worker(domain.worker(), { handler: (job, control) => handler(job, control), leaseSeconds: 15, concurrency: 2 });
		running.push(worker.run(stop.signal));
	});

	after(async () => {
		stop.abort();
		await Promise.race([Promise.allSettled(running), new Promise((resolve) => setTimeout(resolve, 5000))]);
		server.closeAllConnections();
		server.close();
		await (domain.close ?? domain.stop)();
	});

	it("finds the target agent and reports each capability's side effects from the real catalog", async () => {
		const catalog: any = await (await call("GET", "/v1/catalog?query=echo%20text")).json();
		const echo = catalog.results.find((r: any) => r.capability.id === "code.echo");
		assert.ok(echo, JSON.stringify(catalog));
		assert.equal(echo.agentId, "agent/ts-worker");
		assert.equal(echo.capability.sideEffects, "read");
		assert.ok(echo.capability.inputSchema);
		await say("/agents");
		assert.match(messages().at(-1)!, /agent\/ts-worker .*code\.echo@1/);
	});

	it("runs a read-only task end to end and tells the owner the result on Telegram", async () => {
		handler = async (job) => ({ type: "completed", result: { echo: job.input.text, summary: `echoed ${job.input.text}` } });
		const submitted: any = await (await call("POST", "/v1/tasks", { capability: { id: "code.echo", version: "1" }, input: { text: "ping" } })).json();
		assert.equal(submitted.status, "submitted", JSON.stringify(submitted));
		const task: any = await (await call("GET", `/v1/tasks/${submitted.taskId}?wait=20`)).json();
		assert.equal(task.state, "succeeded");
		assert.equal(task.result.echo, "ping");
		const note = await until(() => messages().find((t) => t.includes(submitted.taskId) && t.includes("succeeded")), "the result on Telegram");
		assert.match(note, /echoed ping/);
		assert.equal(messages().filter((t) => t.includes(submitted.taskId) && t.includes("succeeded")).length, 1);
	});

	it("a write needs the owner's approval first: nothing exists in the domain until /approve", async () => {
		handler = async (job) => ({ type: "completed", result: { summary: `changed ${job.input.target}`, prUrl: "https://github.test/o/r/pull/7" } });
		const before = (await tasksOfAuthor()).length;
		const answer: any = await (await call("POST", "/v1/tasks", { capability: { id: "code.change", version: "1" }, input: { target: "config", secretToken: "hunter2-very-secret" } })).json();
		assert.equal(answer.status, "awaiting_approval", JSON.stringify(answer));
		const prompt = await until(() => messages().find((t) => t.includes(`Approval ${answer.approvalId}`)), "the approval prompt");
		assert.match(prompt, /code\.change v1 \(side effects: write\)/);
		assert.match(prompt, /target: config/);
		assert.doesNotMatch(prompt, /hunter2/);
		await new Promise((resolve) => setTimeout(resolve, 600));
		assert.equal((await tasksOfAuthor()).length, before, "no task was created before the approval");
		assert.equal(((await (await call("GET", `/v1/tasks/${answer.approvalId}`)).json()) as any).status, "pending");

		await say(`/approve ${answer.approvalId}`);
		assert.equal((await tasksOfAuthor()).length, before + 1);
		const result = await until(() => messages().find((t) => t.includes("code.change@1") && t.includes("succeeded")), "the write result");
		assert.match(result, /PR: https:\/\/github\.test\/o\/r\/pull\/7/);
		const status: any = await (await call("GET", `/v1/tasks/${answer.approvalId}`)).json();
		assert.equal(status.status, "approved");
		assert.ok(status.taskId);
	});

	it("a denied write never reaches the domain", async () => {
		const before = (await tasksOfAuthor()).length;
		const answer: any = await (await call("POST", "/v1/tasks", { capability: { id: "code.change", version: "1" }, input: { target: "prod" } })).json();
		await say(`/deny ${answer.approvalId}`);
		await new Promise((resolve) => setTimeout(resolve, 400));
		assert.equal((await tasksOfAuthor()).length, before);
		assert.equal(((await (await call("GET", `/v1/tasks/${answer.approvalId}`)).json()) as any).status, "denied");
	});

	it("forwards a running task's question and passes the owner's reply back", async () => {
		handler = async (job, control) => {
			const answer: any = await control.requestInput({ question: `Really change ${job.input.target}?` });
			return answer?.approved === true ? { type: "completed", result: { summary: "changed after approval" } } : { type: "failed", failure: { code: "declined", message: "owner said no", retryable: false } };
		};
		const answer: any = await (await call("POST", "/v1/tasks", { capability: { id: "code.change", version: "1" }, input: { target: "db" } })).json();
		await say(`/approve ${answer.approvalId}`);
		const taskId = (await until(() => tracker.tasks.find((t) => t.state === "input_required"), "the task to ask a question")).taskId;
		const question = await until(() => messages().find((t) => t.includes(`Task ${taskId}`) && t.includes("asks:")), "the question on Telegram");
		assert.match(question, /Really change db\?/);
		const questionMessageId = await until(() => tracker.get(taskId)?.questionMessageId, "the question message id");
		await say("yes", { reply_to_message: { message_id: questionMessageId } });
		await until(() => messages().find((t) => t.includes(`Task ${taskId}`) && t.includes("succeeded") && t.includes("changed after approval")), "the final result after the answer");
	});

	it("forwards a message from another agent to the owner, and sends the Manager's messages through the gateway", async () => {
		await domain.worker().post("/v1/messages", { recipients: [{ kind: "agent", id: "agent/ts-author" }], content: { mediaType: "text/plain", data: "the review queue is empty" }, triggerMode: "directed" });
		await until(() => messages().find((t) => t === "[agent/ts-worker] the review queue is empty"), "the forwarded message");
		const sent: any = await (await call("POST", "/v1/messages", { to: "agent/ts-worker", text: "thanks" })).json();
		assert.ok(sent.messageId, JSON.stringify(sent));
		const inbox: any = await domain.worker().get("/v1/inbox?unread=true&limit=20");
		assert.ok(inbox.messages.some((m: any) => m.content?.data === "thanks"));
	});

	it("cancel works only on tasks this Manager submitted", async () => {
		handler = (_job, control) => new Promise((resolve) => control.signal.addEventListener("abort", () => resolve({ type: "detach" }), { once: true }));
		const submitted: any = await (await call("POST", "/v1/tasks", { capability: { id: "code.echo", version: "1" }, input: { text: "slow" } })).json();
		assert.equal((await call("POST", "/v1/tasks/task_not_mine/cancel", {})).status, 403);
		const canceled = await call("POST", `/v1/tasks/${submitted.taskId}/cancel`, { reason: "test" });
		assert.equal(canceled.status, 200, await canceled.text());
	});
});

import assert from "node:assert/strict";
import test from "node:test";
import { answerFrom, TelegramBridge } from "../src/bridge.ts";
import { defaultPolicy } from "../src/policy.ts";
import { InboxReader, Notifications, PollingFeed, TaskTracker } from "../src/notifier.ts";
import { ManagerService } from "../src/service.ts";
import { FakeDomain, message, recordingApi, stubRpc } from "./helpers.ts";

function setup(state: any = { allowedUserId: 42, chatId: 42 }) {
	const domain = new FakeDomain();
	const telegram = recordingApi();
	const saves: number[] = [];
	const save = async () => void saves.push(1);
	const notifications = new Notifications();
	const tracker = new TaskTracker(domain, state, save, notifications);
	const inbox = new InboxReader(domain, notifications);
	const { rpc, calls } = stubRpc();
	const bridge = new TelegramBridge({ state, api: telegram.api, rpc, save, tracker, notifications });
	const service = new ManagerService({ domain, policy: defaultPolicy, owner: bridge, tracker });
	bridge.service = service;
	const say = (text: string, extra: Record<string, unknown> = {}, id = 42) => bridge.handleUpdate({ message: message(text, id, extra) });
	return { domain, telegram, state, tracker, inbox, bridge, service, say, calls, notifications, save };
}

const agentRun = { capability: { id: "code.agent", version: "1" }, input: { repository: { url: "https://example.test/r.git", ref: "main" }, instruction: "fix it" } };

test("the owner approves a write from Telegram and then hears the result", async () => {
	const { domain, telegram, service, say, tracker } = setup();
	const outcome = (await service.submit(agentRun)) as { approvalId: string };
	assert.match(telegram.texts()[0]!, new RegExp(`Reply /approve ${outcome.approvalId} or /deny ${outcome.approvalId}`));
	assert.equal(domain.submitted.length, 0);
	await say(`/approve ${outcome.approvalId}`);
	assert.equal(domain.submitted.length, 1);
	assert.match(telegram.texts().at(-1)!, /Approved .*submitted task task_1/);

	domain.tasks.task_1 = { taskId: "task_1", state: "succeeded", result: { status: "completed", summary: "Fixed the bug", branch: "agent/task_1", prUrl: "https://github.test/o/r/pull/9", usage: { totalTokens: 1234, costUsd: 0.01 } } };
	await tracker.checkAll();
	const result = telegram.texts().at(-1)!;
	assert.match(result, /Task task_1 \(code\.agent@1\) succeeded/);
	assert.match(result, /PR: https:\/\/github\.test\/o\/r\/pull\/9/);
	assert.match(result, /Used 1234 tokens/);
	await tracker.checkAll();
	assert.equal(telegram.texts().filter((t) => t.includes("succeeded")).length, 1, "a finished task is announced once");
});

test("/deny and a stranger's /approve submit nothing", async () => {
	const { domain, telegram, service, say } = setup();
	const outcome = (await service.submit(agentRun)) as { approvalId: string };
	await say(`/approve ${outcome.approvalId}`, {}, 43);
	assert.equal(domain.submitted.length, 0);
	await say(`/deny ${outcome.approvalId}`);
	assert.match(telegram.texts().at(-1)!, /Denied/);
	await say(`/approve ${outcome.approvalId}`);
	assert.match(telegram.texts().at(-1)!, /already denied/);
	assert.equal(domain.submitted.length, 0);
});

test("failures and cancellations are reported with their reason", async () => {
	const { domain, telegram, service, tracker } = setup();
	await service.submit({ capability: { id: "code.review", version: "2" } });
	domain.tasks.task_1 = { taskId: "task_1", state: "failed", failure: { code: "tool_failed", message: "the reviewer crashed" } };
	await tracker.checkAll();
	assert.match(telegram.texts().at(-1)!, /failed\ntool_failed: the reviewer crashed/);
});

test("a question is forwarded and a reply to it answers the task", async () => {
	const { domain, telegram, service, tracker, say } = setup();
	await service.submit({ capability: { id: "code.review", version: "2" } });
	domain.tasks.task_1 = { taskId: "task_1", state: "input_required", blocker: { question: { question: "Run `rm -rf build`?" } } };
	await tracker.checkAll();
	const question = telegram.sent.filter((s) => s.method === "sendMessage").at(-1)!;
	assert.match(question.data.text, /asks:\nRun `rm -rf build`\?/);
	const questionId = tracker.get("task_1")!.questionMessageId!;
	assert.ok(questionId >= 100);
	await tracker.checkAll();
	assert.equal(telegram.texts().filter((t) => t.includes("asks:")).length, 1, "asked once");

	await say("yes, go ahead", { reply_to_message: { message_id: questionId } });
	assert.deepEqual(domain.inputs, [{ taskId: "task_1", data: { approved: true } }]);
	assert.equal(telegram.texts().some((t) => t.includes("hello")), false);
});

test("a normal message that is not a reply goes to Pi, not to the task", async () => {
	const setupHandle = setup();
	const { domain, service, tracker, say, calls } = setupHandle;
	await service.submit({ capability: { id: "code.review", version: "2" } });
	domain.tasks.task_1 = { taskId: "task_1", state: "input_required", blocker: { question: "ok?" } };
	await tracker.checkAll();
	const { bridge } = setupHandle;
	await say("what is the weather");
	clearInterval(bridge.typingTimer);
	assert.deepEqual(domain.inputs, []);
	assert.ok(calls.some((c) => c.type === "prompt"));
});

test("/answer sends free text; yes/no variants map to approvals", async () => {
	assert.deepEqual(answerFrom("Yes"), { approved: true });
	assert.deepEqual(answerFrom("no, too risky"), { approved: false, reason: "too risky" });
	assert.deepEqual(answerFrom("use the staging database"), { answer: "use the staging database" });
	const { domain, service, say } = setup();
	await service.submit({ capability: { id: "code.review", version: "2" } });
	await say("/answer task_1 use the staging database");
	assert.deepEqual(domain.inputs, [{ taskId: "task_1", data: { answer: "use the staging database" } }]);
	await say("/answer task_foreign hi");
	assert.equal(domain.inputs.length, 1);
});

test("messages from other agents are forwarded once; own and bookkeeping messages are not", async () => {
	const { domain, telegram, inbox } = setup();
	domain.unread = [
		{ messageId: "m1", from: "agent/reviewer", text: "I found something odd", type: "chat.message" },
		{ messageId: "m2", from: "agent/manager", text: "my own echo", type: "chat.message" },
		{ messageId: "m3", from: "system", text: "{}", type: "task.status" },
	];
	await inbox.drain();
	assert.deepEqual(telegram.texts(), ["[agent/reviewer] I found something odd"]);
	assert.deepEqual(domain.read, ["m1", "m2", "m3"]);
});

test("a failed Telegram delivery is retried, not lost", async () => {
	const { domain, service, tracker, bridge } = setup();
	await service.submit({ capability: { id: "code.review", version: "2" } });
	domain.tasks.task_1 = { taskId: "task_1", state: "succeeded", result: { summary: "ok" } };
	let failing = true;
	const sent: string[] = [];
	(bridge as any).api = async (_m: string, data: any) => {
		if (failing) throw new Error("Telegram request failed");
		sent.push(data.text);
		return { message_id: 1 };
	};
	await assert.rejects(tracker.checkAll());
	failing = false;
	await tracker.checkAll();
	assert.equal(sent.length, 1);
});

test("tracked tasks survive a restart without being announced twice", async () => {
	const first = setup();
	await first.service.submit({ capability: { id: "code.review", version: "2" } });
	first.domain.tasks.task_1 = { taskId: "task_1", state: "succeeded", result: { summary: "ok" } };
	await first.tracker.checkAll();
	const persisted = JSON.parse(JSON.stringify(first.state));
	const second = setup(persisted);
	second.domain.tasks.task_1 = first.domain.tasks.task_1;
	await second.tracker.checkAll();
	assert.equal(second.telegram.texts().length, 0);
	assert.equal(second.tracker.tasks.length, 1);

	const mid = setup();
	await mid.service.submit({ capability: { id: "code.review", version: "2" } });
	const survivor = setup(JSON.parse(JSON.stringify(mid.state)));
	survivor.domain.tasks.task_1 = { taskId: "task_1", state: "succeeded", result: { summary: "finished while down" } };
	await survivor.tracker.checkAll();
	assert.match(survivor.telegram.texts()[0]!, /finished while down/);
});

test("/agents, /tasks, /pending and /cancel", async () => {
	const { telegram, service, say, domain } = setup();
	await say("/agents");
	assert.match(telegram.texts().at(-1)!, /agent\/reviewer \[online\]: code\.review@2/);
	await say("/tasks");
	assert.equal(telegram.texts().at(-1), "No tasks submitted yet.");
	await service.submit({ capability: { id: "code.review", version: "2" } });
	await say("/tasks");
	assert.match(telegram.texts().at(-1)!, /task_1 queued code\.review@2/);
	await say("/cancel task_1");
	assert.deepEqual(domain.canceled, ["task_1"]);
	await service.submit(agentRun);
	await say("/pending");
	assert.match(telegram.texts().at(-1)!, /code\.agent@1 \(write\)/);
});

test("nothing is asked of an unpaired owner: the write is refused and not submitted", async () => {
	const { domain, service } = setup({});
	await assert.rejects(service.submit(agentRun), /could not be asked|owner/);
	assert.equal(domain.submitted.length, 0);
});

test("the polling feed notices changes, backs off on errors and stops on abort", async () => {
	const { domain, tracker, inbox, telegram, service } = setup();
	await service.submit({ capability: { id: "code.review", version: "2" } });
	const events: string[] = [];
	let failOnce = true;
	const original = domain.getTask.bind(domain);
	domain.getTask = async (id: string) => {
		if (failOnce) {
			failOnce = false;
			throw new Error("domain down");
		}
		return original(id);
	};
	const feed = new PollingFeed(tracker, inbox, { taskIntervalMs: 20, inboxIntervalMs: 20, maxBackoffMs: 40 }, (event) => events.push(event));
	const controller = new AbortController();
	const running = feed.run(controller.signal);
	domain.tasks.task_1 = { taskId: "task_1", state: "succeeded", result: { summary: "ok" } };
	for (let i = 0; i < 100 && telegram.texts().length < 2; i++) await new Promise((r) => setTimeout(r, 20));
	controller.abort();
	await running;
	assert.ok(events.includes("feed_failed"));
	assert.ok(telegram.texts().some((t) => t.includes("succeeded")));
});

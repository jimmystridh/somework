import assert from "node:assert/strict";
import test from "node:test";
import { ApprovalQueue } from "../src/approvals.ts";
import { Notifications, TaskTracker } from "../src/notifier.ts";
import { defaultPolicy, PolicyError, RateLimiter, withBudget } from "../src/policy.ts";
import { summarizeInput } from "../src/redact.ts";
import { ManagerService } from "../src/service.ts";
import { FakeDomain } from "./helpers.ts";

function setup(overrides: { now?: () => number; policy?: Partial<typeof defaultPolicy>; unreachable?: boolean } = {}) {
	const domain = new FakeDomain();
	const told: string[] = [];
	const owner = {
		tell: async (text: string) => {
			if (overrides.unreachable) throw new Error("owner not paired");
			told.push(text);
			return told.length;
		},
	};
	const state = {};
	const tracker = new TaskTracker(domain, state, async () => {}, new Notifications());
	const service = new ManagerService({ domain, policy: { ...defaultPolicy, ...overrides.policy }, owner, tracker, now: overrides.now });
	return { domain, told, service, tracker };
}

const review = { capability: { id: "code.review", version: "2" }, input: { text: "echo hi" } };
const agentRun = { capability: { id: "code.agent", version: "1" }, input: { repository: { url: "https://example.test/r.git", ref: "main" }, instruction: "fix it" } };

test("read-only capabilities are submitted directly and followed", async () => {
	const { domain, service, tracker, told } = setup();
	const outcome = await service.submit(review);
	assert.equal(outcome.status, "submitted");
	assert.equal(domain.submitted.length, 1);
	assert.equal(told.length, 0);
	assert.equal(tracker.tasks.length, 1);
	assert.match(domain.submitted[0]!.key, /^manager-/);
});

test("a write capability waits for approval and nothing reaches the domain before it", async () => {
	const { domain, service, told } = setup();
	const outcome = await service.submit(agentRun);
	assert.equal(outcome.status, "awaiting_approval");
	assert.equal(domain.submitted.length, 0);
	assert.match(told[0]!, /Approval a[0-9a-f]{8} needed/);
	assert.match(told[0]!, /Budget: 200000 tokens, 20 min/);
	assert.match(told[0]!, /instruction: fix it/);
});

test("approving submits exactly the input that was shown, with the capped budget", async () => {
	const { domain, service } = setup();
	const outcome = (await service.submit(agentRun)) as { approvalId: string };
	const approved = await service.approve(outcome.approvalId);
	assert.equal(approved.ok, true);
	assert.equal(domain.submitted.length, 1);
	assert.deepEqual(domain.submitted[0]!.request.input.budget, { maxTokens: 200_000, maxMinutes: 20 });
	assert.equal(domain.submitted[0]!.request.input.instruction, "fix it");
	const status: any = await service.task(outcome.approvalId);
	assert.equal(status.status, "approved");
	assert.equal(status.taskId, "task_1");
	assert.equal((await service.approve(outcome.approvalId)).ok, false, "an approval is single use");
});

test("denied, unknown and expired approvals never submit", async () => {
	let clock = 1_000_000;
	const { domain, service, told } = setup({ now: () => clock });
	const first = (await service.submit(agentRun)) as { approvalId: string };
	assert.equal(service.deny(first.approvalId).ok, true);
	assert.equal((await service.approve(first.approvalId)).ok, false);
	assert.equal((await service.approve("a00000000")).ok, false);
	const second = (await service.submit(agentRun)) as { approvalId: string };
	clock += defaultPolicy.approvalTtlMs;
	assert.equal((await service.approve(second.approvalId)).ok, false);
	assert.equal(domain.submitted.length, 0);
	await service.announceExpired();
	assert.ok(told.some((text) => text.includes(`Approval ${second.approvalId} for code.agent expired`)));
	await service.announceExpired();
	assert.equal(told.filter((text) => text.includes("expired")).length, 1, "the owner hears about an expiry once");
});

test("an unknown side-effect level is treated like a write", async () => {
	const { domain, service } = setup();
	domain.capabilities["odd.thing@1"] = { sideEffects: undefined as never };
	const outcome = await service.submit({ capability: { id: "odd.thing", version: "1" } });
	assert.equal(outcome.status, "awaiting_approval");
	assert.equal(domain.submitted.length, 0);
});

test("when the owner cannot be asked nothing is submitted", async () => {
	const { domain, service } = setup({ unreachable: true });
	await assert.rejects(service.submit(agentRun), (error: PolicyError) => error.code === "owner_unreachable" && error.status === 503);
	assert.equal(domain.submitted.length, 0);
	assert.equal(service.pending().length, 0);
});

test("budgets: defaults are filled in, values above the ceiling are refused", () => {
	assert.deepEqual(withBudget("code.agent", {}, defaultPolicy).budget, { maxTokens: 200_000, maxMinutes: 20 });
	assert.deepEqual(withBudget("code.agent", { budget: { maxTokens: 5000, maxMinutes: 2 } }, defaultPolicy).budget, { maxTokens: 5000, maxMinutes: 2 });
	assert.throws(() => withBudget("code.agent", { budget: { maxTokens: 500_001, maxMinutes: 5 } }, defaultPolicy), (e: PolicyError) => e.code === "budget_above_ceiling");
	assert.throws(() => withBudget("code.agent", { budget: { maxTokens: 1000, maxMinutes: 61 } }, defaultPolicy), (e: PolicyError) => e.code === "budget_above_ceiling");
	assert.throws(() => withBudget("code.agent", { budget: { maxTokens: -1, maxMinutes: 5 } }, defaultPolicy), (e: PolicyError) => e.code === "invalid_budget");
	assert.deepEqual(withBudget("code.review", { text: "x" }, defaultPolicy), { text: "x" }, "other capabilities are left alone");
});

test("a budget above the ceiling is refused before the owner is bothered", async () => {
	const { service, told, domain } = setup();
	await assert.rejects(service.submit({ ...agentRun, input: { ...agentRun.input, budget: { maxTokens: 9_000_000, maxMinutes: 5 } } }), (e: PolicyError) => e.status === 422);
	assert.equal(told.length, 0);
	assert.equal(domain.submitted.length, 0);
});

test("submissions are rate limited per hour", async () => {
	let clock = 0;
	const { service } = setup({ now: () => clock, policy: { submissionsPerHour: 2 } });
	await service.submit(review);
	await service.submit(review);
	await assert.rejects(service.submit(review), (e: PolicyError) => e.code === "rate_limited" && e.status === 429);
	clock += 3_600_001;
	assert.equal((await service.submit(review)).status, "submitted");
});

test("the rate limiter slides", () => {
	let clock = 0;
	const limiter = new RateLimiter(2, 1000, () => clock);
	assert.deepEqual([limiter.take(), limiter.take(), limiter.take()], [true, true, false]);
	clock = 1001;
	assert.equal(limiter.take(), true);
});

test("unknown capabilities are a clear 404, not a submission", async () => {
	const { service, domain } = setup();
	await assert.rejects(service.submit({ capability: { id: "nope", version: "1" } }), (e: PolicyError) => e.status === 404);
	assert.equal(domain.submitted.length, 0);
});

test("only tasks the Manager submitted can be canceled or answered", async () => {
	const { service, domain } = setup();
	await assert.rejects(service.cancel("task_foreign"), (e: PolicyError) => e.status === 403);
	await assert.rejects(service.answer("task_foreign", {}), (e: PolicyError) => e.status === 403);
	const submitted = (await service.submit(review)) as { taskId: string };
	await service.cancel(submitted.taskId);
	assert.deepEqual(domain.canceled, [submitted.taskId]);
});

test("messages are length and rate limited", async () => {
	const { service, domain } = setup({ policy: { messagesPerHour: 1 } });
	await assert.rejects(service.message({ to: "agent/x", text: "x".repeat(9000) }), (e: PolicyError) => e.status === 413);
	await service.message({ to: "agent/reviewer", text: "hello" });
	assert.equal(domain.sentMessages.length, 1);
	await assert.rejects(service.message({ to: "agent/reviewer", text: "again" }), (e: PolicyError) => e.status === 429);
});

test("the approval prompt hides secrets and cuts long values", () => {
	const summary = summarizeInput({ instruction: "x".repeat(1000), apiKey: "super-secret", note: "token ghp_abcdefghijklmnopqrstuvwxyz0123456789 inside", nested: { token: "t" } });
	assert.match(summary, /apiKey: \[redacted\]/);
	assert.doesNotMatch(summary, /super-secret|ghp_abcdef/);
	assert.ok(summary.length <= 760);
	assert.match(summary, /chars\]/);
});

test("approval queue ids are unguessable-looking and decided entries are forgotten after a while", () => {
	let clock = 0;
	const queue = new ApprovalQueue(1000, () => clock);
	const a = queue.create({ capability: { id: "x", version: "1" }, sideEffects: "write", input: {}, summary: "" });
	assert.match(a.id, /^a[0-9a-f]{8}$/);
	assert.equal(queue.decide(a.id, true)?.status, "approved");
	clock = 1000 + 3_600_001;
	queue.pending();
	assert.equal(queue.get(a.id), undefined);
});

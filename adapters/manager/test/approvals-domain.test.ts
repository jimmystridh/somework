import assert from "node:assert/strict";
import test from "node:test";
import { SomeWorkError } from "@somework/sdk";
import { approval, build, rule, say, tap } from "./events-helpers.ts";

test("a pending domain approval reaches the owner once, with what is being approved and buttons", async () => {
	const b = build();
	b.domain.approvals = [approval("appr_1")];
	b.domain.tasks.task_for_appr_1 = {
		taskId: "task_for_appr_1",
		state: "submitted",
		sideEffects: "write",
		input: { issueKey: "ADM-1234", budget: { maxTokens: 150000, maxMinutes: 30 }, apiToken: "ghp_abcdefghijklmnopqrstuvwxyz0123456789" },
		origin: { kind: "reaction", rule: "qa-on-ticket", eventId: "evt_9", depth: 1 },
	};
	b.domain.rules = [rule("qa-on-ticket")];
	await b.reactionApprovals.poll();
	await b.reactionApprovals.poll();
	const sent = b.telegram.sent.filter((s) => s.method === "sendMessage");
	assert.equal(sent.length, 1, "announced exactly once");
	const text: string = sent[0]!.data.text;
	for (const part of ["appr_1", "qa.verify@1", "side effects: write", "Rule: qa-on-ticket", "jira.issue.transitioned", "evt_9", "150000 tokens", "ADM-1234", "agent/automation/qa-on-ticket"]) assert.ok(text.includes(part), part);
	assert.ok(!text.includes("ghp_abcdef"), "secret-looking values are hidden");
	assert.ok(text.includes("apiToken: [redacted]"));
	assert.deepEqual(sent[0]!.data.reply_markup.inline_keyboard[0].map((k: any) => k.callback_data), ["ap:y:appr_1", "ap:n:appr_1"]);
});

test("without permission to read the task the prompt falls back to the rule that fired", async () => {
	const b = build();
	b.domain.approvals = [approval("appr_2")];
	b.domain.getTask = async () => {
		throw new SomeWorkError(403, "policy_denied", "no");
	};
	b.domain.rules = [rule("qa-on-ticket", { reaction: { capability: { id: "qa.verify", version: 1 }, budget: { maxTokens: 90000, maxMinutes: 15 }, input: { issueKey: "${/data/key}" } } })];
	b.domain.firings["qa-on-ticket"] = [{ rule: "qa-on-ticket", eventId: "evt_77", status: "pending", approvalId: "appr_2" }];
	await b.reactionApprovals.poll();
	const text: string = b.telegram.sent.find((s) => s.method === "sendMessage")!.data.text;
	assert.ok(text.includes("Rule: qa-on-ticket") && text.includes("evt_77") && text.includes("90000 tokens"));
	assert.ok(text.includes("the rule's template"), "says the input is the rule's template, not the real input");
});

test("the owner's button approves with the digest and revision the domain reported", async () => {
	const b = build();
	b.domain.approvals = [approval("appr_3", { actionDigest: "dg-3", taskRevision: 7 })];
	await b.reactionApprovals.poll();
	await tap(b, "ap:y:appr_3");
	assert.deepEqual(b.domain.decisions, [{ approvalId: "appr_3", decision: { decision: "approved", actionDigest: "dg-3", taskRevision: 7, comment: "decided by the owner in Telegram" } }]);
	assert.ok(b.telegram.texts().some((t) => t.startsWith("Approved appr_3")));
	assert.ok(b.telegram.sent.some((s) => s.method === "editMessageReplyMarkup" && s.data.reply_markup.inline_keyboard.length === 0), "the buttons go away");
	assert.ok(b.telegram.sent.some((s) => s.method === "answerCallbackQuery"));
});

test("/deny and /approve commands work for domain approvals, and a denial is sent as denied", async () => {
	const b = build();
	b.domain.approvals = [approval("appr_4"), approval("appr_5")];
	await say(b, "/deny appr_4");
	await say(b, "/approve appr_5");
	assert.deepEqual(b.domain.decisions.map((d) => [d.approvalId, d.decision.decision]), [["appr_4", "denied"], ["appr_5", "approved"]]);
});

test("only the paired owner can decide: another account's tap or command changes nothing", async () => {
	const b = build();
	b.domain.approvals = [approval("appr_6")];
	await tap(b, "ap:y:appr_6", 999, 999);
	await tap(b, "ap:y:appr_6", 999, 42);
	await tap(b, "ap:y:appr_6", 42, 999);
	await say(b, "/approve appr_6", 999);
	assert.equal(b.domain.decisions.length, 0);
	assert.equal(b.telegram.sent.filter((s) => s.method === "answerCallbackQuery").length, 0, "strangers get no answer at all");
	assert.equal(b.domain.approvals[0]!.status, "pending");
});

test("garbage in a button does nothing", async () => {
	const b = build();
	for (const data of ["ap:y:../etc", "ap:y:appr_1;drop", "zz:y:appr_1", "ct:y:appr_1", "ap:y:"]) await tap(b, data);
	assert.equal(b.domain.decisions.length, 0);
});

test("an expired approval is refused before the domain is asked, and the owner is told once when one ends on its own", async () => {
	const b = build();
	b.domain.approvals = [approval("appr_7", { expiresAt: new Date(Date.now() - 1000).toISOString() })];
	await say(b, "/approve appr_7");
	assert.equal(b.domain.decisions.length, 0);
	assert.ok(b.telegram.texts().some((t) => t.includes("has expired")));

	const c = build();
	c.domain.approvals = [approval("appr_8")];
	await c.reactionApprovals.poll();
	c.domain.approvals[0]!.status = "expired";
	await c.reactionApprovals.poll();
	await c.reactionApprovals.poll();
	assert.equal(c.telegram.texts().filter((t) => t.includes("appr_8") && t.includes("ended: expired")).length, 1);
});

test("a decision taken elsewhere is reported once; a domain refusal is shown, not hidden", async () => {
	const b = build();
	b.domain.approvals = [approval("appr_9")];
	await b.reactionApprovals.poll();
	b.domain.approvals[0]!.status = "approved";
	b.domain.approvals[0]!.approvedBy = "human/jimmy";
	await b.reactionApprovals.poll();
	assert.equal(b.telegram.texts().filter((t) => t.includes("ended: approved by human/jimmy")).length, 1);

	const c = build();
	c.domain.approvals = [approval("appr_10")];
	c.domain.decideError = new SomeWorkError(409, "stale_revision", "the task changed after this approval was requested");
	await say(c, "/approve appr_10");
	assert.ok(c.telegram.texts().some((t) => t.includes("refused the decision") && t.includes("the task changed")));
	assert.equal(c.domain.approvals[0]!.status, "pending");
});

test("a restart does not ask again: announced approvals are remembered in the state", async () => {
	const b = build();
	b.domain.approvals = [approval("appr_11")];
	await b.reactionApprovals.poll();
	assert.ok(b.state.reactionApprovals!.appr_11);
	const again = (await import("../src/reaction-approvals.ts")).ReactionApprovals;
	const second = new again({ domain: b.domain, owner: b.bridge, state: b.state, save: async () => {} });
	await second.poll();
	assert.equal(b.telegram.sent.filter((s) => s.method === "sendMessage").length, 1);
});

test("an unpaired Manager keeps the approval for later instead of losing it", async () => {
	const b = build({ paired: false });
	b.domain.approvals = [approval("appr_12")];
	await assert.rejects(b.reactionApprovals.poll(), /owner not paired/);
	assert.equal(b.state.reactionApprovals?.appr_12, undefined);
});

test("/approvals lists what waits, from both the Manager and the domain", async () => {
	const b = build();
	b.domain.approvals = [approval("appr_13")];
	await b.service.submit({ capability: { id: "code.agent", version: "1" }, input: { instruction: "x" } });
	await say(b, "/approvals");
	const text = b.telegram.texts().at(-1)!;
	assert.ok(text.includes("code.agent@1") && text.includes("appr_13"));
});

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BUDGET_LABEL, BUDGET_POOL_LABEL, BUDGET_TOKENS_LABEL, createBudgetIntercept } from "../src/budget-control.ts";
import type { InboundMessage } from "../src/chat.ts";
import { DailyLedger } from "../src/ledger.ts";

const path = () => join(mkdtempSync(join(tmpdir(), "budget-")), "ledger.json");
const withPools = (file: string, day: () => string = () => "2026-10-06") => new DailyLedger(file, 1000, day, { share: 0.5, weeklyTokens: 600 }, { share: 0.1 });

describe("raising a pool for today", () => {
	it("adds to the daily limit and to each pool's own limit", () => {
		const ledger = withPools(path());
		assert.deepEqual([ledger.dailyLimit, ledger.eventsLimit, ledger.chatLimit], [1000, 500, 100]);
		assert.equal(ledger.raise("tasks", 400, 1000).limit, 1400);
		assert.equal(ledger.raise("events", 250, 1000).limit, 750);
		assert.equal(ledger.raise("chat", 50, 1000).limit, 150);
		assert.equal(ledger.remaining(), 1400, "the pools' unspent shares do not come off the tasks");
		assert.deepEqual(ledger.usage().raisedToday, { tasks: 400, events: 250, chat: 50 });
		assert.equal(ledger.usage().events.weeklyLimit, 850, "the weekly events cap rises with it");
	});

	it("brings a used-up pool back", () => {
		const ledger = withPools(path());
		ledger.record(500, "events");
		assert.equal(ledger.eventsState(), "stopped");
		ledger.raise("events", 200, 1000);
		assert.equal(ledger.eventsState(), "ok");
		assert.equal(ledger.eventsRemaining(), 200);
	});

	it("lasts for the day only and survives a restart within it", () => {
		const file = path();
		let day = "2026-10-06";
		const ledger = withPools(file, () => day);
		ledger.raise("tasks", 300, 1000);
		assert.equal(withPools(file, () => day).dailyLimit, 1300);
		day = "2026-10-07";
		assert.equal(withPools(file, () => day).dailyLimit, 1000);
		assert.equal(withPools(file, () => day).usage().raisedToday, undefined);
	});

	it("stays within the daily ceiling over all raises, and refuses odd amounts and pools the agent lacks", () => {
		const ledger = withPools(path());
		ledger.raise("tasks", 600, 1000);
		assert.throws(() => ledger.raise("tasks", 401, 1000), /at most 1000 tokens per day, and 600 are raised already/);
		assert.equal(ledger.dailyLimit, 1600, "a refused raise changes nothing");
		for (const tokens of [0, -5, 1.5, Number.NaN]) assert.throws(() => ledger.raise("tasks", tokens, 1000), /positive whole number/);
		const plain = new DailyLedger(path(), 1000, () => "2026-10-06");
		assert.throws(() => plain.raise("events", 10, 1000), /no events pool/);
		assert.throws(() => plain.raise("chat", 10, 1000), /no chat pool/);
	});
});

describe("the budget message", () => {
	const message = (sender: string, labels: Record<string, string>): InboundMessage => ({ messageId: "m1", type: "chat.message", sender: { kind: "agent", id: sender }, conversationId: "c1", labels });
	const rig = () => {
		const ledger = withPools(path());
		const replies: string[] = [];
		const logs: string[] = [];
		const intercept = createBudgetIntercept({ ledger, controllers: ["agent/manager"], ceiling: 1000, reply: async (_m, text) => void replies.push(text), log: (_level, event) => void logs.push(event) });
		return { ledger, replies, logs, intercept };
	};

	it("ignores messages without the label, so chat carries on", async () => {
		const r = rig();
		assert.equal(await r.intercept(message("agent/manager", {})), false);
		assert.deepEqual(r.replies, []);
	});

	it("raises the pool for the manager and tells it the result", async () => {
		const r = rig();
		assert.equal(await r.intercept(message("agent/manager", { [BUDGET_LABEL]: "raise", [BUDGET_POOL_LABEL]: "events", [BUDGET_TOKENS_LABEL]: "200" })), true);
		assert.equal(r.ledger.eventsLimit, 700);
		assert.match(r.replies[0]!, /events pool gets 200 more tokens today.*limit now 700.*tomorrow/);
		assert.ok(r.logs.includes("budget_raised"));
	});

	it("refuses anyone else without a reply or a change", async () => {
		const r = rig();
		assert.equal(await r.intercept(message("agent/qa", { [BUDGET_LABEL]: "raise", [BUDGET_POOL_LABEL]: "tasks", [BUDGET_TOKENS_LABEL]: "100" })), true);
		assert.equal(r.ledger.dailyLimit, 1000);
		assert.deepEqual(r.replies, []);
		assert.ok(r.logs.includes("budget_control_refused"));
	});

	it("says why when the request cannot be carried out", async () => {
		const r = rig();
		await r.intercept(message("agent/manager", { [BUDGET_LABEL]: "raise", [BUDGET_POOL_LABEL]: "tasks", [BUDGET_TOKENS_LABEL]: "5000" }));
		await r.intercept(message("agent/manager", { [BUDGET_LABEL]: "raise", [BUDGET_POOL_LABEL]: "bank", [BUDGET_TOKENS_LABEL]: "5" }));
		await r.intercept(message("agent/manager", { [BUDGET_LABEL]: "lower", [BUDGET_POOL_LABEL]: "tasks", [BUDGET_TOKENS_LABEL]: "5" }));
		assert.equal(r.ledger.dailyLimit, 1000);
		assert.match(r.replies[0]!, /Budget not changed: a pool can be raised by at most 1000/);
		assert.match(r.replies[1]!, /Budget not changed: the action must be raise and the pool/);
		assert.match(r.replies[2]!, /Budget not changed/);
	});
});

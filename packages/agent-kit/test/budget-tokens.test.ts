import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DailyLedger } from "../src/ledger.ts";
import { budgetTokens, CACHE_READ_WEIGHT } from "../src/pi-runtime.ts";

describe("what counts against a token budget", () => {
	it("counts fresh input, output and cache writes in full and cache reads at a tenth", () => {
		assert.equal(CACHE_READ_WEIGHT, 0.1);
		// a real job: 84k fresh input, 8k output, about 1.94M of cache reads re-read on every turn
		assert.equal(budgetTokens({ input: 84_424, output: 8_160, cacheRead: 1_935_744, cacheWrite: 0, totalTokens: 2_028_328 }), 84_424 + 8_160 + 193_574);
		assert.equal(budgetTokens({ input: 100, output: 50, cacheRead: 0, cacheWrite: 400, totalTokens: 550 }), 550, "cache writes are paid for in full");
		assert.equal(budgetTokens({ input: 10, output: 5, cacheRead: 5, cacheWrite: 0 }), 16, "a tenth of 5 rounds to 1");
	});

	it("takes the provider's total when there is no breakdown, and never counts less than nothing", () => {
		assert.equal(budgetTokens({ input: 10, output: 5, totalTokens: 99 }), 99);
		assert.equal(budgetTokens({ input: 10, output: 5 }), 15);
		assert.equal(budgetTokens({}), 0);
		assert.equal(budgetTokens({ input: -5, output: 0, cacheRead: 0, cacheWrite: 0 }), 0);
	});
});

describe("what a task may still use today", () => {
	const ledger = () => new DailyLedger(join(mkdtempSync(join(tmpdir(), "budget-tokens-")), "ledger.json"), 8000, () => "2026-10-13", { share: 0.5, weeklyTokens: 100_000 }, { share: 0.5 });

	it("is reported with the pools, because chat and events spend comes off the same day", () => {
		const day = ledger();
		day.record(7000, "tasks");
		day.record(1500, "chat");
		const { tasks, chat } = day.usage();
		assert.deepEqual([tasks.used, tasks.limit], [7000, 8000], "the task pool alone looks as if 1000 were left");
		assert.equal(tasks.remaining, 0, "but the chat's 1500 also comes off the day");
		assert.equal(chat?.used, 1500);
		assert.equal(tasks.remaining, day.remaining());
	});
});

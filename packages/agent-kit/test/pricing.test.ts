import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildTable, priceEntry } from "../../../scripts/update-pricing.ts";
import { Metrics } from "../src/metrics.ts";
import { modelCostUsd } from "../src/pi-runtime.ts";
import { llmUsageCounters } from "../src/usage-metrics.ts";
import { estimateCostUsd, findPrice, priceSpend, type ModelPrice } from "../src/pricing.ts";

const close = (actual: number | undefined, expected: number, message?: string): void => assert.ok(actual !== undefined && Math.abs(actual - expected) < 1e-9, `${message ?? ""} ${actual} !~ ${expected}`);

describe("the price table", () => {
	it("holds the models the fleet runs on, with LiteLLM's rates in dollars per million tokens", () => {
		assert.deepEqual(findPrice("gpt-6.1-sol"), { i: 2, o: 10, cr: 0.1, cw: 2.5, i2: 4, o2: 15, cr2: 0.2, cw2: 5, flex: 1, fast: 4 });
		assert.deepEqual(findPrice("gpt-5.5")?.i, 5);
		assert.equal(findPrice("claude-sonnet-4-5")?.cw1h, 6);
	});

	it("finds a model the way ccusage does: provider prefix, date suffix, -latest, case", () => {
		assert.deepEqual(findPrice("openai-codex/gpt-6.1-sol"), findPrice("gpt-6.1-sol"));
		assert.deepEqual(findPrice("GPT-5.5"), findPrice("gpt-5.5"));
		assert.deepEqual(findPrice("claude-sonnet-4-5-20250929"), findPrice("claude-sonnet-4-5"));
		assert.deepEqual(findPrice("anthropic/claude-sonnet-4-5-2025-09-29"), findPrice("claude-sonnet-4-5"));
		assert.equal(findPrice("gpt-6.1-sol-9"), undefined, "another numeric suffix is another version, not an alias");
		assert.equal(findPrice("faux-1"), undefined);
		assert.equal(findPrice("__proto__"), undefined);
		assert.equal(findPrice(""), undefined);
	});

	it("is built from LiteLLM's list: only the providers the fleet can use, per million tokens, entries without both rates dropped", () => {
		assert.deepEqual(priceEntry({ input_cost_per_token: 2e-6, output_cost_per_token: 1e-5, cache_read_input_token_cost: 1e-7, input_cost_per_token_priority: 4e-6 }), { i: 2, o: 10, cr: 0.1, fast: 4 });
		assert.equal(priceEntry({ input_cost_per_token: 2e-6 }), undefined);
		const table = buildTable({
			"gpt-x": { litellm_provider: "openai", mode: "chat", input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 },
			"azure/gpt-x": { litellm_provider: "azure", mode: "chat", input_cost_per_token: 9e-6, output_cost_per_token: 9e-6 },
			"openai/gpt-y": { litellm_provider: "openai", mode: "chat", input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 },
			"whisper-1": { litellm_provider: "openai", mode: "audio_transcription", input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 },
			sample_spec: { litellm_provider: "openai", mode: "chat", input_cost_per_token: 1, output_cost_per_token: 1 },
		});
		assert.deepEqual(Object.keys(table), ["gpt-x", "gpt-y"]);
		assert.equal(table["gpt-x"]?.i, 1);
	});
});

describe("the cost of a request", () => {
	const sol = findPrice("gpt-6.1-sol")!;

	it("prices fresh input, cache reads and output each at its own rate (a real QA job that the agent recorded as $0.44402)", () => {
		close(estimateCostUsd(sol, { inputTokens: 84_424, outputTokens: 8_160, cacheReadTokens: 1_935_744 }), 0.4440224, "qa job");
		close(priceSpend("openai-codex/gpt-6.1-sol", { inputTokens: 1_000_000, outputTokens: 0 }), 2);
	});

	it("bills the whole request at the long-context rates once its context passes 272k, not just the part above it", () => {
		const spend = { inputTokens: 100_000, outputTokens: 10_000, cacheReadTokens: 200_000 };
		close(estimateCostUsd(sol, spend, { contextTokens: 300_000 }), 100_000 * 4e-6 + 10_000 * 15e-6 + 200_000 * 0.2e-6);
		close(estimateCostUsd(sol, spend, { contextTokens: 272_000 }), 100_000 * 2e-6 + 10_000 * 10e-6 + 200_000 * 0.1e-6, "272k itself is still short");
		close(estimateCostUsd(sol, spend), 100_000 * 2e-6 + 10_000 * 10e-6 + 200_000 * 0.1e-6, "no context given: one short request");
	});

	it("uses the 200k tier of the models that have one, and the input price for a cache read the model does not discount", () => {
		const gemini: ModelPrice = { i: 1.25, o: 10, cr: 0.125, i3: 2.5, o3: 15, cr3: 0.25 };
		close(estimateCostUsd(gemini, { inputTokens: 1_000_000, outputTokens: 1_000_000 }, { contextTokens: 250_000 }), 2.5 + 15);
		const plain: ModelPrice = { i: 3, o: 6 };
		close(estimateCostUsd(plain, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000 }), 3 + 3, "no cache price: the input price");
	});

	it("prices cache writes, the one-hour retention at twice the input price when the list has no rate, and the flex and fast tiers by their input price", () => {
		const claude = findPrice("claude-sonnet-4-5")!;
		close(estimateCostUsd(claude, { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 1_000_000, cacheWrite1hTokens: 1_000_000 }), 3.75 + 6);
		close(estimateCostUsd({ i: 2, o: 10 }, { inputTokens: 0, outputTokens: 0, cacheWrite1hTokens: 1_000_000 }), 4);
		close(estimateCostUsd(sol, { inputTokens: 1_000_000, outputTokens: 1_000_000 }, { tier: "flex" }), (2 + 10) / 2);
		close(estimateCostUsd(sol, { inputTokens: 1_000_000, outputTokens: 1_000_000 }, { tier: "fast" }), (2 + 10) * 2);
	});

	it("has no price for a model the list does not know", () => {
		assert.equal(priceSpend("faux/faux-1", { inputTokens: 5, outputTokens: 5 }), undefined);
	});
});

describe("the cost an agent records", () => {
	it("is Pi's own figure when Pi has one, and the price list's when it has none", () => {
		assert.equal(modelCostUsd("openai-codex/gpt-6.1-sol", { input: 1_000_000, output: 0, cost: { total: 1.23 } }), 1.23);
		close(modelCostUsd("openai-codex/gpt-6.1-sol", { input: 84_424, output: 8_160, cacheRead: 1_935_744, cacheWrite: 0, cost: { total: 0 } }), 0.4440224, "Pi had no price");
		close(modelCostUsd("some-provider/gpt-5.5-2026-04-23", { input: 1_000_000, output: 0 }), 5);
		assert.equal(modelCostUsd("faux/faux-1", { input: 10, output: 10 }), 0);
	});

	it("counts the tokens of a model that has no price anywhere, so that the missing cost can be seen", () => {
		const metrics = new Metrics();
		const counters = llmUsageCounters(metrics, { agent: "agent/test", role: "tester" });
		const model = { provider: "openai-codex", modelId: "gpt-6.1-sol" };
		counters.record({ ...model, inputTokens: 100, outputTokens: 10, cacheReadTokens: 1000, cacheWriteTokens: 0, costUsd: 0.5 });
		counters.record({ provider: "faux", modelId: "faux-1", inputTokens: 100, outputTokens: 10, cacheReadTokens: 1000, cacheWriteTokens: 5, costUsd: 0 });
		const out = metrics.render();
		assert.match(out, /somework_llm_cost_usd_total\{[^}]*model="gpt-6.1-sol"[^}]*\} 0.5/);
		assert.match(out, /somework_llm_unpriced_tokens_total\{[^}]*model="faux-1"[^}]*\} 1115/);
		assert.doesNotMatch(out, /somework_llm_unpriced_tokens_total\{[^}]*model="gpt-6.1-sol"[^}]*\} [1-9]/);
	});
});

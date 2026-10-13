import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { audit } from "../../../scripts/pricing-audit.ts";

const sol = { provider: "openai-codex", model: "gpt-6.1-sol", input: 977_247, output: 101_080, cacheRead: 7_369_466, cacheWrite: 0 };

describe("the pricing audit", () => {
	it("passes a model whose recorded cost is the price list's, and flags one that differs or has no price", () => {
		const lines = audit([
			{ ...sol, recordedUsd: 3.7 },
			{ ...sol, model: "gpt-5.5", recordedUsd: 3.7 },
			{ ...sol, provider: "faux", model: "faux-1", recordedUsd: 0 },
		]);
		assert.deepEqual(lines.map((line) => [line.model, line.verdict]), [["openai-codex/gpt-6.1-sol", "ok"], ["openai-codex/gpt-5.5", "differs"], ["faux/faux-1", "unpriced"]]);
		assert.ok(Math.abs(lines[0]!.expectedUsd! - 3.7) < 0.01);
	});

	it("allows the tolerance, and a few cents on a small spend", () => {
		assert.equal(audit([{ ...sol, recordedUsd: 3.7 * 1.019 }])[0]!.verdict, "ok");
		assert.equal(audit([{ ...sol, recordedUsd: 3.7 * 1.05 }])[0]!.verdict, "differs");
		assert.equal(audit([{ provider: "openai-codex", model: "gpt-6.1-sol", input: 1000, output: 100, cacheRead: 0, cacheWrite: 0, recordedUsd: 0.012 }])[0]!.verdict, "ok");
	});
});

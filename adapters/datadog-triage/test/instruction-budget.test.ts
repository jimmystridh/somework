import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildInstruction } from "../src/prompt.ts";

const input = { monitor: { id: "1", status: "alert" }, windowMinutes: 60 };
const monitor = { id: "1", name: "load", status: "alert", type: "metric alert", query: "q", message: "m", tags: [] } as never;
const now = new Date("2026-10-07T08:00:00Z");

describe("the triage instruction", () => {
	it("tells the model its budget and to stop investigating well before it, because a run that hits the limit gives no result", () => {
		const text = buildInstruction(input, monitor, "bnd", now, { maxTokens: 150_000, maxMinutes: 10 });
		assert.match(text, /about 150k tokens and 10 minutes/);
		assert.match(text, /ends with no result at all/);
		assert.match(text, /two thirds of the budget/);
		assert.match(text, /outcome inconclusive/);
	});

	it("says nothing about a budget when none is known", () => {
		assert.doesNotMatch(buildInstruction(input, monitor, "bnd", now), /Your budget/);
	});
});

import { displayName } from "../src/notice.ts";

describe("the monitor name in the notice", () => {
	it("is the monitor's own, or the alert's name without its status prefix when the monitor's is a template", () => {
		assert.equal(displayName("CPU high", "[Triggered] CPU high on web-1"), "CPU high");
		assert.equal(displayName("System load is high for host {{host.name}}", "[Triggered] System load is high for host aks-1"), "System load is high for host aks-1");
		assert.equal(displayName("[Warn on {x}] deadlocks for {{database_instance.name}}", "[Warn on {database_instance:db1}] deadlocks"), "deadlocks");
		assert.equal(displayName("System load {{host.name}}", undefined), "System load {{host.name}}");
		assert.equal(displayName(undefined, "[Triggered] Something"), "Something");
	});
});

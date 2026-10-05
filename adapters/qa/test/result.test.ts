import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractJson, parseReport } from "../src/result.ts";

const verified = { verdict: "verified", acceptanceChecks: [{ criterion: "total shows 120", passed: true, evidence: "saw 120,00" }], fixtures: [{ description: "an invoice", keys: "INV-7" }], notes: "" };
const wrap = (value: unknown) => `Verified it.\n\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\`\n`;

describe("extracting the report", () => {
	it("takes the last json block and ignores prose and earlier blocks", () => {
		const text = `first\n\`\`\`json\n{"verdict":"blocked"}\n\`\`\`\nthen\n${wrap(verified)}`;
		assert.equal((extractJson(text) as any).verdict, "verified");
	});
	it("falls back to the outermost braces and gives up on garbage", () => {
		assert.equal((extractJson(`result: ${JSON.stringify(verified)} done`) as any).verdict, "verified");
		assert.equal(extractJson("no json here"), undefined);
		assert.equal(extractJson("```json\n[1,2]\n```"), undefined, "an array is not a report");
	});
});

describe("validating the report", () => {
	it("accepts a verified report with passing checks", () => {
		const parsed = parseReport(wrap(verified));
		assert.ok(parsed.ok);
		assert.equal(parsed.report.acceptanceChecks.length, 1);
		assert.equal(parsed.truncated, false);
	});

	it("a verified report needs checks and every check must have passed", () => {
		for (const bad of [{ ...verified, acceptanceChecks: [] }, { ...verified, acceptanceChecks: [{ criterion: "a", passed: true }, { criterion: "b", passed: false }] }]) {
			const parsed = parseReport(wrap(bad));
			assert.equal(parsed.ok, false);
			assert.match((parsed as any).reason, /verified result needs/);
		}
	});

	it("not_fixed needs a failed check and every other verdict needs notes", () => {
		assert.match((parseReport(wrap({ verdict: "not_fixed", acceptanceChecks: [{ criterion: "a", passed: true }], notes: "x" })) as any).reason, /needs at least one failed/);
		assert.ok(parseReport(wrap({ verdict: "not_fixed", acceptanceChecks: [{ criterion: "a", passed: false, evidence: "total was 100" }], notes: "still broken" })).ok);
		assert.match((parseReport(wrap({ verdict: "blocked", acceptanceChecks: [] })) as any).reason, /notes must explain/);
		assert.ok(parseReport(wrap({ verdict: "blocked", notes: "the app has no companies" })).ok);
	});

	it("rejects an unknown verdict, malformed checks and fixtures, and 'skipped' (only the service decides that)", () => {
		for (const bad of [{ verdict: "maybe" }, { verdict: "skipped", notes: "x" }, { verdict: "blocked", notes: "x", acceptanceChecks: [{ criterion: "", passed: true }] }, { verdict: "blocked", notes: "x", fixtures: [{ keys: "k" }] }, { verdict: "blocked", notes: "x", acceptanceChecks: "no" }]) {
			assert.equal(parseReport(wrap(bad)).ok, false, JSON.stringify(bad));
		}
		assert.match((parseReport("nothing") as any).reason, /no JSON result block/);
	});

	it("cuts runaway fields and says so", () => {
		const parsed = parseReport(wrap({ ...verified, notes: "n".repeat(20000), acceptanceChecks: Array.from({ length: 60 }, (_, i) => ({ criterion: `c${i}`, passed: true })) }));
		assert.ok(parsed.ok);
		assert.equal(parsed.report.acceptanceChecks.length, 40);
		assert.equal(parsed.report.notes.length, 6000);
		assert.equal(parsed.truncated, true);
	});
});

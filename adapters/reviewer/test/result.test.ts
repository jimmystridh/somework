import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractJson, LIMITS, parseReview, renderReport, validateReview } from "../src/result.ts";

const review = {
	verdict: "request_changes",
	summary: "The change drops the null check.",
	findings: [
		{ severity: "P2", file: "src/b.ts", line: 3, title: "minor", detail: "d2" },
		{ severity: "P1", file: "src/a.ts", line: 12, title: "null deref", detail: "crashes when the list is empty", suggestion: "guard it" },
	],
	openQuestions: ["is the old path still used?"],
	checked: ["the diff", "callers of load()"],
	residualRisk: "tests not run",
	draftComments: [{ file: "src/a.ts", line: 12, body: "please guard this" }],
};
const fenced = (value: unknown): string => `Here is my review.\n\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\`\n`;

describe("extracting the result from the answer", () => {
	it("finds the json block among prose, takes the last of several, and falls back to a bare object", () => {
		assert.deepEqual(extractJson(`I looked.\n${fenced({ a: 1 })}\nAnd then more prose with {braces}.`), { a: 1 });
		assert.deepEqual(extractJson("```json\n{\"a\":1}\n```\ntext\n```json\n{\"a\":2}\n```"), { a: 2 });
		assert.deepEqual(extractJson("```\n{\"a\":3}\n```"), { a: 3 });
		assert.deepEqual(extractJson("no fence, just {\"a\": 4} at the end"), { a: 4 });
		assert.equal(extractJson("nothing here"), undefined);
		assert.equal(extractJson("```json\n{broken\n```"), undefined);
	});

	it("skips an unparsable block and uses the earlier valid one", () => {
		assert.deepEqual(extractJson("```json\n{\"ok\":true}\n```\n```json\n{broken\n```"), { ok: true });
	});
});

describe("validating the review", () => {
	it("accepts a well-formed review, most severe finding first", () => {
		const parsed = parseReview(fenced(review));
		assert.ok(parsed.ok);
		assert.equal(parsed.review.verdict, "request_changes");
		assert.deepEqual(parsed.review.findings.map((f) => f.severity), ["P1", "P2"]);
		assert.equal(parsed.review.draftComments?.length, 1);
		assert.equal(parsed.truncated, false);
	});

	it("rejects what the requester could not rely on, with a reason the repair turn can use", () => {
		const reason = (value: unknown): string => {
			const parsed = validateReview(value);
			assert.ok(!parsed.ok);
			return parsed.reason;
		};
		assert.match(reason({ ...review, verdict: "lgtm" }), /verdict must be one of/);
		assert.match(reason({ ...review, summary: "" }), /summary must not be empty/);
		assert.match(reason({ ...review, findings: "none" }), /findings must be an array/);
		assert.match(reason({ ...review, findings: [{ severity: "P9", title: "t", detail: "d" }] }), /findings\[0\]\.severity/);
		assert.match(reason({ ...review, findings: [{ severity: "P1", title: "t" }] }), /findings\[0\]\.detail is required/);
		assert.match(reason({ ...review, findings: [{ severity: "P1", title: "t", detail: "d", line: 0 }] }), /line must be a positive integer/);
		assert.match(reason({ ...review, draftComments: [{ file: "a", body: "b" }] }), /draftComments\[0\]/);
		assert.match(reason({ ...review, verdict: "approve" }), /approve contradicts the P0\/P1 findings/);
		assert.match(reason([]), /not a JSON object/);
		const noJson = parseReview("I could not decide.");
		assert.ok(!noJson.ok);
		assert.match(noJson.reason, /no JSON result/);
	});

	it("accepts approve with only minor findings, and defaults the optional lists", () => {
		const parsed = validateReview({ verdict: "approve", summary: "fine", findings: [{ severity: "P3", title: "t", detail: "d" }] });
		assert.ok(parsed.ok);
		assert.deepEqual(parsed.review.openQuestions, []);
		assert.deepEqual(parsed.review.checked, []);
		assert.equal("draftComments" in parsed.review, false);
	});

	it("cuts oversize results to the limits, keeping the most severe findings, and says so", () => {
		const many = Array.from({ length: LIMITS.findings + 10 }, (_, i) => ({ severity: i < 5 ? "P1" : "P3", title: `f${i}`, detail: "x".repeat(LIMITS.detail + 50) }));
		const parsed = validateReview({ verdict: "request_changes", summary: "s", findings: many, checked: Array.from({ length: 40 }, () => "item") });
		assert.ok(parsed.ok);
		assert.equal(parsed.truncated, true);
		assert.equal(parsed.review.findings.length, LIMITS.findings);
		assert.equal(parsed.review.findings.filter((f) => f.severity === "P1").length, 5, "the severe ones survive");
		assert.ok(parsed.review.findings.every((f) => f.detail.length <= LIMITS.detail));
		assert.equal(parsed.review.checked.length, LIMITS.checked);
	});
});

describe("the report", () => {
	it("reads as a review: verdict, findings with file and line, questions, what was checked, draft comments", () => {
		const parsed = parseReview(fenced(review));
		assert.ok(parsed.ok);
		const report = renderReport(parsed.review, { repository: "https://example.test/o/r.git", ref: "feature", pullRequest: 7, ticket: "ABC-12", taskId: "task_1", truncated: true });
		assert.match(report, /^# Review: Request changes/);
		assert.match(report, /Pull request: #7/);
		assert.match(report, /### \[P1\] null deref `src\/a\.ts:12`/);
		assert.match(report, /Suggested direction: guard it/);
		assert.match(report, /## Open questions/);
		assert.match(report, /## Draft comments \(not posted\)/);
		assert.match(report, /cut to the size limits/);
		assert.ok(report.indexOf("[P1]") < report.indexOf("[P2]"));
	});
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildNotice, monitorUrl, NOTICE_MAX, oneLine } from "../src/notice.ts";
import type { Triage } from "../src/result.ts";

const triage = (extra: Partial<Triage> = {}): Triage => ({
	outcome: "diagnosed",
	severity: "high",
	summary: "Checkout errors rose after the deploy.",
	suspectedCause: "Deploy 1.2.3 broke the payment client.",
	confidence: "medium",
	timeline: [{ at: "t", note: "n" }],
	evidence: [],
	recommendedActions: ["roll back 1.2.3", "check the payment provider status", "page the payments team", "a fourth action"],
	...extra,
});

describe("the owner notice", () => {
	it("holds severity, monitor, summary, cause with confidence, three actions and the service's link", () => {
		const text = buildNotice(triage(), { monitorId: "77", monitorName: "Checkout error rate", site: "datadoghq.eu" });
		assert.equal(
			text,
			["Datadog triage: HIGH, diagnosed", "Monitor: Checkout error rate (77)", "Checkout errors rose after the deploy.", "Suspected cause (medium confidence): Deploy 1.2.3 broke the payment client.", "Next:", "1. roll back 1.2.3", "2. check the payment provider status", "3. page the payments team", "https://app.datadoghq.eu/monitors/77"].join("\n"),
		);
	});

	it("builds the link from the site and the id only", () => {
		assert.equal(monitorUrl("datadoghq.eu", 12), "https://app.datadoghq.eu/monitors/12");
		assert.equal(monitorUrl("us5.datadoghq.com", "9"), "https://app.us5.datadoghq.com/monitors/9");
		assert.equal(monitorUrl("datadoghq.eu", "12/../../evil"), "https://app.datadoghq.eu/monitors/12");
		const text = buildNotice(triage({ summary: "see https://evil.example/phish now" }), { monitorId: "77", site: "datadoghq.eu" });
		assert.doesNotMatch(text, /evil\.example/);
		assert.match(text, /see \[link\] now/);
		assert.equal(text.split("\n").at(-1), "https://app.datadoghq.eu/monitors/77");
	});

	it("strips secrets and control characters and keeps lines to one line", () => {
		const text = buildNotice(triage({ summary: "token=abcdefghijklmnop\nsecond\u0007 line", recommendedActions: ["use Bearer abcdefghijklmnopqrstuv\nnow"] }), { monitorId: "1", monitorName: "name\nwith newline", site: "datadoghq.eu" });
		assert.doesNotMatch(text, /abcdefghijklmnop/);
		assert.match(text, /Monitor: name with newline \(1\)/);
		assert.match(text, /\ntoken=\[redacted\] second line\n/);
	});

	it("says what an inconclusive or noisy result is, without a cause it does not have", () => {
		const inconclusive = buildNotice(triage({ outcome: "inconclusive", suspectedCause: undefined, confidence: "low", recommendedActions: [] }), { monitorId: "5", site: "datadoghq.eu" });
		assert.match(inconclusive, /^Datadog triage: HIGH, inconclusive\nMonitor: monitor 5 \(5\)\n/);
		assert.match(inconclusive, /\nConfidence: low\nhttps:/);
		assert.doesNotMatch(inconclusive, /Suspected cause|Next:/);
		assert.match(buildNotice(triage({ outcome: "noise", severity: "info" }), { monitorId: "5", site: "datadoghq.eu" }), /INFO, looks like noise/);
	});

	it("carries a note about a warning", () => {
		assert.match(buildNotice(triage({ warnings: ["2 evidence item(s) were marked as inference"] }), { monitorId: "5", site: "datadoghq.eu" }), /\nNote: 2 evidence item\(s\) were marked as inference\n/);
	});

	it("never exceeds the size limit and always keeps the link", () => {
		const long = "word ".repeat(500);
		const text = buildNotice(triage({ summary: long, suspectedCause: long, recommendedActions: [long, long, long], warnings: [long] }), { monitorId: "77", monitorName: long, site: "datadoghq.eu" });
		assert.ok(text.length <= NOTICE_MAX, `${text.length}`);
		assert.equal(text.split("\n").at(-1), "https://app.datadoghq.eu/monitors/77");
		assert.ok(text.length < 1500 || NOTICE_MAX === 1500);
	});

	it("oneLine shortens with an ellipsis", () => {
		assert.equal(oneLine("a".repeat(20), 10), `${"a".repeat(9)}…`);
		assert.equal(oneLine("  a   b  ", 10), "a b");
	});
});

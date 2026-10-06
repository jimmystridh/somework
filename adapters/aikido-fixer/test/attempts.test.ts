import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { AttemptLedger } from "../src/attempts.ts";

const ledger = (limits = { maxAttemptsPerIssue: 2, cooldownMinutes: 60, dailyCap: 3 }, clock = { now: new Date("2026-10-06T09:00:00Z") }) => {
	const file = join(mkdtempSync(join(tmpdir(), "aikido-attempts-")), "attempts.json");
	return { file, clock, ledger: new AttemptLedger(file, limits, () => clock.now) };
};

describe("attempt ledger", () => {
	it("counts a task once however often it is retried", () => {
		const { ledger: l } = ledger();
		assert.deepEqual(l.begin("1", "t1"), { ok: true });
		assert.deepEqual(l.begin("1", "t1"), { ok: true });
		assert.deepEqual(l.begin("1", "t1"), { ok: true });
		const { clock, ledger: again } = ledger({ maxAttemptsPerIssue: 2, cooldownMinutes: 1, dailyCap: 1 });
		again.begin("1", "t1");
		for (let i = 0; i < 3; i++) assert.deepEqual(again.begin("1", "t1"), { ok: true }, "the retry of a counted task does not hit the daily cap");
		clock.now = new Date("2026-10-06T09:05:00Z");
		assert.equal(again.begin("2", "t2").ok, false, "but another task does");
	});

	it("allows another attempt on an issue only after the cool-down, and not beyond the limit", () => {
		const { clock, ledger: l } = ledger();
		assert.equal(l.begin("7", "a").ok, true);
		const soon = l.begin("7", "b");
		assert.equal(soon.ok, false);
		assert.match((soon as any).reason, /less than 60 minutes/);
		clock.now = new Date("2026-10-06T10:01:00Z");
		assert.equal(l.begin("7", "b").ok, true);
		clock.now = new Date("2026-10-06T12:00:00Z");
		const third = l.begin("7", "c");
		assert.equal(third.ok, false);
		assert.match((third as any).reason, /already attempted 2 time/);
	});

	it("caps the attempts per day across issues and resets on the next day", () => {
		const { clock, ledger: l } = ledger({ maxAttemptsPerIssue: 5, cooldownMinutes: 1, dailyCap: 2 });
		assert.equal(l.begin("1", "a").ok, true);
		assert.equal(l.begin("2", "b").ok, true);
		assert.match((l.begin("3", "c") as any).reason, /daily cap of 2/);
		clock.now = new Date("2026-10-07T00:00:01Z");
		assert.equal(l.begin("3", "c").ok, true);
	});

	it("remembers across a restart and survives a corrupt file", () => {
		const { file, ledger: l } = ledger();
		l.begin("1", "a");
		const reopened = new AttemptLedger(file, { maxAttemptsPerIssue: 1, cooldownMinutes: 60, dailyCap: 3 }, () => new Date("2026-10-06T12:00:00Z"));
		assert.equal(reopened.begin("1", "b").ok, false);
		writeFileSync(file, "garbage");
		assert.equal(reopened.begin("1", "b").ok, true);
		writeFileSync(file, JSON.stringify({ issues: { "1": "x" } }));
		assert.throws(() => reopened.begin("1", "c"), undefined, "a structurally wrong file is a visible error, not a silent reset");
	});

	it("keeps the first branch name a task chose", () => {
		const { file, ledger: l } = ledger();
		assert.equal(l.branchFor("t1", () => "agent/aikido-1-aaaa"), "agent/aikido-1-aaaa");
		assert.equal(l.branchFor("t1", () => "agent/aikido-1-bbbb"), "agent/aikido-1-aaaa");
		assert.equal(new AttemptLedger(file, { maxAttemptsPerIssue: 2, cooldownMinutes: 60, dailyCap: 3 }).branchFor("t1", () => "x"), "agent/aikido-1-aaaa");
		assert.ok(JSON.parse(readFileSync(file, "utf8")).branches.t1);
	});

	it("forgets old days and bounds the branch list", () => {
		const { clock, ledger: l } = ledger({ maxAttemptsPerIssue: 100, cooldownMinutes: 1, dailyCap: 100 });
		l.begin("1", "old");
		clock.now = new Date("2026-10-20T09:00:00Z");
		l.begin("2", "new");
		for (let i = 0; i < 520; i++) l.branchFor(`t${i}`, () => `agent/x-${i}`);
	});
});

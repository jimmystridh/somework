import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { TriageLedger } from "../src/attempts.ts";

function ledger(limits = { cooldownMinutes: 60, dailyCap: 3 }) {
	const file = join(mkdtempSync(join(tmpdir(), "dd-ledger-")), "ledger.json");
	let now = new Date("2026-10-06T09:00:00Z");
	const clock = { advance: (minutes: number) => void (now = new Date(now.getTime() + minutes * 60_000)) };
	return { ledger: new TriageLedger(file, limits, () => now), file, clock };
}

describe("the triage ledger", () => {
	it("allows a first triage, refuses one inside the cool-down, allows it after", () => {
		const { ledger: l, clock } = ledger();
		assert.deepEqual(l.begin("1", "t1"), { ok: true });
		clock.advance(30);
		const early = l.begin("1", "t2");
		assert.ok(!early.ok && /less than 60 minutes ago/.test(early.reason));
		clock.advance(31);
		assert.deepEqual(l.begin("1", "t3"), { ok: true });
	});

	it("keeps monitors apart and counts every start against the day", () => {
		const { ledger: l } = ledger();
		for (const id of ["1", "2", "3"]) assert.deepEqual(l.begin(id, `t${id}`), { ok: true });
		const capped = l.begin("4", "t4");
		assert.ok(!capped.ok && /daily cap of 3 triages is reached/.test(capped.reason));
		assert.equal(l.facts().today, 3);
	});

	it("starts a new day with a new count, and forgets old days", () => {
		const { ledger: l, clock } = ledger();
		for (const id of ["1", "2", "3"]) l.begin(id, `t${id}`);
		clock.advance(24 * 60);
		assert.deepEqual(l.begin("4", "t4"), { ok: true });
		assert.equal(l.facts().today, 1);
		clock.advance(10 * 24 * 60);
		l.begin("5", "t5");
		assert.equal(l.facts().today, 1);
	});

	it("never counts one task twice", () => {
		const { ledger: l } = ledger({ cooldownMinutes: 60, dailyCap: 1 });
		assert.deepEqual(l.begin("1", "t1"), { ok: true });
		assert.deepEqual(l.begin("1", "t1"), { ok: true }, "a retry of the same task");
		assert.equal(l.facts().today, 1);
	});

	it("records the first outcome of a task and keeps the latest 200", () => {
		const { ledger: l, clock } = ledger();
		l.recordOutcome("t1", { monitorId: "1", outcome: "diagnosed" });
		l.recordOutcome("t1", { monitorId: "1", outcome: "failed:x" });
		assert.equal(l.facts().recent[0]!.outcome, "diagnosed");
		for (let i = 0; i < 205; i++) {
			clock.advance(1);
			l.recordOutcome(`n${i}`, { monitorId: "2", outcome: "noise" });
		}
		const facts = l.facts(500);
		assert.equal(facts.recent.length, 200);
		assert.equal(facts.recent[0]!.taskId, "n204");
		assert.ok(!facts.recent.some((entry) => entry.taskId === "t1"));
	});

	it("survives a damaged file and shares its state between instances", () => {
		const { ledger: l, file } = ledger();
		l.begin("1", "t1");
		const second = new TriageLedger(file, { cooldownMinutes: 60, dailyCap: 3 }, () => new Date("2026-10-06T09:10:00Z"));
		assert.ok(!second.begin("1", "t2").ok);
		writeFileSync(file, "{not json");
		assert.deepEqual(second.begin("1", "t3"), { ok: true });
	});
});

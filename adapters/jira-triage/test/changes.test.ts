import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { applyChanges, assertWritable, ChangeJournal, FORBIDDEN_FIELDS, revertOf, WRITABLE_FIELDS, WriteRefused, type Change } from "../src/changes.ts";
import { issueOf, MemoryJira } from "./memory-jira.ts";

const setup = (over: Parameters<typeof issueOf>[1] = {}) => {
	const dir = mkdtempSync(join(tmpdir(), "triage-changes-"));
	const file = join(dir, "changes.jsonl");
	const jira = new MemoryJira([issueOf("SAD-1", { labels: ["keep"], description: "Old text", ...over })]);
	const logs: { level: string; event: string; fields: any }[] = [];
	const journal = new ChangeJournal(file, () => new Date("2026-10-11T09:00:00Z"));
	return { dir, file, jira, journal, logs, options: { jira, journal, log: (level: string, event: string, fields?: any) => logs.push({ level, event, fields }) } };
};

describe("what the bot may write", () => {
	it("is the checklist's fields, and never an assignee, a status or a reporter", () => {
		assert.deepEqual([...WRITABLE_FIELDS], ["description", "labels", "components", "priority", "environment"]);
		for (const field of WRITABLE_FIELDS) assert.doesNotThrow(() => assertWritable(field));
		for (const field of FORBIDDEN_FIELDS) assert.throws(() => assertWritable(field), (error: Error) => error instanceof WriteRefused && /never changed by this agent/.test(error.message));
		assert.throws(() => assertWritable("Assignee"), WriteRefused);
		assert.throws(() => assertWritable("summary"), /not a field this agent may write/);
		assert.throws(() => assertWritable("fixVersions"), WriteRefused);
	});

	it("refuses a batch that names a forbidden field before anything is written or recorded", async () => {
		const { jira, journal, options, file } = setup();
		const bad = [{ field: "labels", before: ["keep"], after: ["keep", "x"] }, { field: "assignee", before: null, after: "me" }] as unknown as Change[];
		await assert.rejects(applyChanges(options, "SAD-1", bad, { reason: "test", trigger: "event" }), WriteRefused);
		assert.deepEqual(jira.writes, []);
		assert.deepEqual(journal.all(), []);
		assert.throws(() => readFileSync(file), /ENOENT/);
	});
});

describe("making a change", () => {
	it("records it with the value before and after first, then writes it, then records that it was applied", async () => {
		const { jira, journal, options } = setup();
		let seenWhenWriting: string[] = [];
		jira.beforeCall = (method) => {
			if (method === "updateFields") seenWhenWriting = journal.all().map((record) => `${record.field}:${record.state}`);
		};
		const applied = await applyChanges(options, "SAD-1", [{ field: "description", before: "Old text", after: "New text" }], { reason: "developer findings", trigger: "event" });
		assert.equal(applied.length, 1);
		assert.deepEqual(seenWhenWriting, ["description:planned"], "the record exists before Jira hears of it");
		assert.equal(jira.get("SAD-1").description, "New text");
		const records = journal.all();
		assert.deepEqual(records.map((record) => record.state), ["planned", "applied"]);
		assert.equal(records[0]!.id, records[1]!.id);
		assert.equal(records[0]!.before, "Old text");
		assert.equal(records[0]!.after, "New text");
		assert.equal(records[0]!.reason, "developer findings");
		assert.equal(records[0]!.ticket, "SAD-1");
		assert.equal(records[0]!.at, "2026-10-11T09:00:00.000Z");
		assert.deepEqual(journal.forTicket("SAD-1").map((record) => record.state), ["applied"], "the latest state of each change");
	});

	it("changes labels by adding and removing single labels, so a label someone added meanwhile is kept", async () => {
		const { jira, options } = setup();
		jira.beforeCall = (method) => {
			if (method === "updateLabels") jira.get("SAD-1").labels.push("someone-elses");
		};
		await applyChanges(options, "SAD-1", [{ field: "labels", before: ["keep"], after: ["keep", "triaged-by-bot"] }], { reason: "marker", trigger: "event" });
		assert.deepEqual(jira.get("SAD-1").labels, ["keep", "someone-elses", "triaged-by-bot"]);
		assert.deepEqual(jira.writes.at(-1)?.detail, { add: ["triaged-by-bot"], remove: [] });
	});

	it("writes text fields, components and priority in one call", async () => {
		const { jira, options } = setup();
		await applyChanges(
			options,
			"SAD-1",
			[
				{ field: "environment", before: "", after: "Test, 2025.11" },
				{ field: "components", before: [], after: ["web"] },
				{ field: "priority", before: "Medium", after: "High" },
			],
			{ reason: "test", trigger: "manual" },
		);
		assert.equal(jira.get("SAD-1").environment, "Test, 2025.11");
		assert.deepEqual(jira.get("SAD-1").components, ["web"]);
		assert.equal(jira.get("SAD-1").priority, "High");
		assert.equal(jira.writes.filter((write) => write.op === "fields").length, 1);
	});

	it("does nothing, and records nothing, for a change that changes nothing", async () => {
		const { jira, journal, options } = setup();
		assert.deepEqual(await applyChanges(options, "SAD-1", [{ field: "labels", before: ["a"], after: ["a"] }], { reason: "x", trigger: "event" }), []);
		assert.deepEqual(jira.writes, []);
		assert.deepEqual(journal.all(), []);
	});

	it("marks the change failed when Jira refuses, keeps the record that it was planned, and throws", async () => {
		const { jira, journal, options, logs } = setup();
		jira.failWrite = "fields";
		await assert.rejects(applyChanges(options, "SAD-1", [{ field: "description", before: "Old text", after: "New text" }], { reason: "x", trigger: "event" }), /503/);
		assert.deepEqual(journal.all().map((record) => record.state), ["planned", "failed"]);
		assert.match(journal.all()[1]!.error ?? "", /503/);
		assert.equal(jira.get("SAD-1").description, "Old text");
		assert.ok(logs.some((log) => log.event === "jira_change_failed"));
	});

	it("does not write at all when the record cannot be written", async () => {
		const { jira, options } = setup();
		const broken = new ChangeJournal(join(tmpdir(), "no-such-dir-triage", "x", "changes.jsonl"));
		(broken as unknown as { record: () => never }).record = () => {
			throw new Error("disk full");
		};
		await assert.rejects(applyChanges({ ...options, journal: broken }, "SAD-1", [{ field: "description", before: "Old text", after: "New text" }], { reason: "x", trigger: "event" }), /disk full/);
		assert.deepEqual(jira.writes, []);
	});

	it("with a dry run records what it would do, marked as such, and calls Jira for nothing", async () => {
		const { jira, journal, options } = setup();
		assert.deepEqual(await applyChanges({ ...options, dryRun: true }, "SAD-1", [{ field: "labels", before: [], after: ["triaged-by-bot"] }], { reason: "marker", trigger: "event" }), []);
		assert.deepEqual(jira.writes, []);
		assert.deepEqual(journal.all().map((record) => record.state), ["dry_run"]);
	});

	it("logs the change without its values, only their sizes and a hash", async () => {
		const { options, logs } = setup();
		await applyChanges(options, "SAD-1", [{ field: "description", before: "secret customer text", after: "more secret customer text" }], { reason: "x", trigger: "event" });
		const line = logs.find((log) => log.event === "jira_change_applied")!;
		assert.equal(line.fields.field, "description");
		assert.equal(line.fields.afterChars, JSON.stringify("more secret customer text").length);
		assert.doesNotMatch(JSON.stringify(logs), /secret customer/);
	});
});

describe("reverting by hand", () => {
	it("is the same field with the two values swapped", async () => {
		const { journal, options } = setup();
		await applyChanges(options, "SAD-1", [{ field: "description", before: "Old text", after: "New text" }], { reason: "x", trigger: "event" });
		assert.deepEqual(revertOf(journal.forTicket("SAD-1")[0]!), { field: "description", before: "New text", after: "Old text" });
	});

	it("can be done with the same helper, and is journaled like any change", async () => {
		const { jira, journal, options } = setup();
		await applyChanges(options, "SAD-1", [{ field: "description", before: "Old text", after: "New text" }], { reason: "x", trigger: "event" });
		await applyChanges(options, "SAD-1", [revertOf(journal.forTicket("SAD-1")[0]!)], { reason: "revert", trigger: "manual" });
		assert.equal(jira.get("SAD-1").description, "Old text");
		assert.equal(journal.count(), 2);
	});

	it("survives a damaged line in the journal", () => {
		const { journal, file } = setup();
		journal.record({ ticket: "SAD-1", field: "labels", before: [], after: ["x"], reason: "r", trigger: "t", state: "applied" });
		appendFileSync(file, "{not json\n");
		assert.equal(journal.all().length, 1);
		assert.equal(journal.forTicket("SAD-2").length, 0);
	});
});

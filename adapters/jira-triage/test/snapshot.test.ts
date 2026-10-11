import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { changedSince, coversChecklist, fingerprintOf, projectOf, snapshotOf } from "../src/snapshot.ts";
import { withNotes } from "../src/wiki.ts";
import { dana, issueOf, MemoryJira } from "./memory-jira.ts";

const view = (over: Parameters<typeof issueOf>[1] = {}) => new MemoryJira().view(issueOf("SAD-1", over));

describe("a ticket as the triage sees it", () => {
	it("reads what the checklist judges, the reporter and the labels", () => {
		const snapshot = snapshotOf(view({ type: "Bug", components: ["web"], labels: ["x"], environment: "prod", attachments: [{ id: "5", filename: "a.png", mimeType: "image/png" }] }));
		assert.equal(snapshot.key, "SAD-1");
		assert.equal(snapshot.project, "SAD");
		assert.equal(snapshot.type, "Bug");
		assert.deepEqual(snapshot.components, ["web"]);
		assert.deepEqual(snapshot.labels, ["x"]);
		assert.equal(snapshot.environment, "prod");
		assert.deepEqual(snapshot.attachments, [{ filename: "a.png", mimeType: "image/png" }]);
		assert.deepEqual(snapshot.attachmentIds, ["5"]);
		assert.deepEqual(snapshot.reporter, { name: "dana", displayName: "Dana Dev", email: "dana@example.test", active: true });
	});

	it("tolerates a ticket with nothing filled in", () => {
		const snapshot = snapshotOf({ key: "SAD-2", fields: {} });
		assert.equal(snapshot.description, "");
		assert.equal(snapshot.type, "");
		assert.equal(snapshot.project, "SAD");
		assert.equal(snapshot.reporter, undefined);
		assert.deepEqual(snapshot.labels, []);
	});

	it("does not judge the bot's own section: the description is the reporter's text", () => {
		const raw = withNotes("The reporter's words.", { title: "Notes", text: "Something the developer agent said." }, new Date());
		const snapshot = snapshotOf(view({ description: raw }));
		assert.equal(snapshot.description, "The reporter's words.");
		assert.equal(snapshot.rawDescription, raw);
	});

	it("marks an inactive reporter", () => {
		assert.equal(snapshotOf(view({ reporter: { ...dana, active: false } })).reporter?.active, false);
	});

	it("takes the project from the key", () => {
		assert.equal(projectOf("SAD-12"), "SAD");
		assert.equal(projectOf("A_B-1"), "A_B");
	});
});

describe("what a person changed since the bot looked", () => {
	const base = snapshotOf(view({ description: "Steps: 1. a 2. b", environment: "" }));

	it("is nothing for the bot's own writes: a label, a comment, or its section of the description", () => {
		const before = fingerprintOf(base);
		assert.deepEqual(changedSince(before, fingerprintOf(snapshotOf(view({ description: "Steps: 1. a 2. b", labels: ["triaged-by-bot", "needs-info"] })))), []);
		assert.deepEqual(changedSince(before, fingerprintOf(snapshotOf(view({ description: withNotes("Steps: 1. a 2. b", { title: "n", text: "t" }, new Date()) })))), []);
	});

	it("is nothing for whitespace", () => {
		assert.deepEqual(changedSince(fingerprintOf(base), fingerprintOf(snapshotOf(view({ description: "Steps:   1. a\n2. b  " })))), []);
	});

	it("names the fields the checklist reads that differ", () => {
		const before = fingerprintOf(base);
		assert.deepEqual(changedSince(before, fingerprintOf(snapshotOf(view({ description: "Steps: 1. a 2. b 3. c" })))), ["description"]);
		assert.deepEqual(changedSince(before, fingerprintOf(snapshotOf(view({ description: "Steps: 1. a 2. b", environment: "prod" })))), ["environment"]);
		assert.deepEqual(changedSince(before, fingerprintOf(snapshotOf(view({ description: "Steps: 1. a 2. b", summary: "New summary here" })))), ["summary"]);
		assert.deepEqual(changedSince(before, fingerprintOf(snapshotOf(view({ description: "Steps: 1. a 2. b", type: "Story" })))), ["type"]);
		assert.deepEqual(changedSince(before, fingerprintOf(snapshotOf(view({ description: "Steps: 1. a 2. b", attachments: [{ id: "9", filename: "s.png" }] })))), ["attachments"]);
	});

	it("knows which field names of an update event are the checklist's", () => {
		assert.equal(coversChecklist(["labels"]), false);
		assert.equal(coversChecklist(["labels", "comment", "Fix Version"]), false);
		assert.equal(coversChecklist(["labels", "description"]), true);
		assert.equal(coversChecklist(["Attachment"]), true);
		assert.equal(coversChecklist(["environment"]), true);
		assert.equal(coversChecklist(["issuetype"]), true);
		assert.equal(coversChecklist(["summary"]), true);
		assert.equal(coversChecklist([]), false);
	});
});

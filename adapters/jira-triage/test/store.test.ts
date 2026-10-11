import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { newRecord, TriageStore } from "../src/store.ts";

const dir = () => mkdtempSync(join(tmpdir(), "triage-store-"));

describe("the triage queue", () => {
	it("keeps a record across a restart", () => {
		const path = dir();
		const first = new TriageStore(path);
		first.put({ ...newRecord("SAD-1", "event", 1000), phase: "awaiting_reporter", rounds: 1 }, 2000);
		const second = new TriageStore(path);
		assert.equal(second.get("SAD-1")?.phase, "awaiting_reporter");
		assert.equal(second.get("SAD-1")?.updatedAt, 2000);
		assert.equal(second.get("SAD-2"), undefined);
	});

	it("tells open work from finished work and counts both", () => {
		const store = new TriageStore(dir());
		store.put({ ...newRecord("SAD-1", "event", 1), phase: "queued" }, 1);
		store.put({ ...newRecord("SAD-2", "event", 1), phase: "awaiting_developer" }, 1);
		store.put({ ...newRecord("SAD-3", "event", 1), phase: "awaiting_reporter" }, 1);
		store.put({ ...newRecord("SAD-4", "event", 1), phase: "done" }, 1);
		store.put({ ...newRecord("SAD-5", "event", 1), phase: "gave_up" }, 1);
		assert.deepEqual(store.open().map((record) => record.id).sort(), ["SAD-1", "SAD-2", "SAD-3"]);
		assert.deepEqual(store.counts(), { queued: 1, awaiting_developer: 1, awaiting_reporter: 1, done: 1, gave_up: 1 });
	});

	it("accepts an event key once, and again after it was released", () => {
		const path = dir();
		const store = new TriageStore(path);
		assert.equal(store.claimEvent("jira:1:comment:5"), true);
		assert.equal(store.claimEvent("jira:1:comment:5"), false);
		assert.equal(new TriageStore(path).claimEvent("jira:1:comment:5"), false, "also after a restart");
		store.releaseEvent("jira:1:comment:5");
		assert.equal(store.claimEvent("jira:1:comment:5"), true);
	});

	it("forgets the oldest finished rows when there are too many, and never an open one", () => {
		const store = new TriageStore(dir());
		store.put({ ...newRecord("SAD-OPEN", "event", 0), phase: "awaiting_reporter" }, 0);
		for (let index = 1; index <= 520; index++) store.put({ ...newRecord(`SAD-${index}`, "event", index), phase: "done", doneAt: index }, index);
		store.prune();
		assert.equal(store.all().filter((record) => record.phase === "done").length, 500);
		assert.equal(store.get("SAD-1"), undefined);
		assert.ok(store.get("SAD-520"));
		assert.ok(store.get("SAD-OPEN"));
	});
});

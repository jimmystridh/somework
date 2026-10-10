import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DurableInbox, DurableTable } from "../src/threads/store.ts";

const dir = () => mkdtempSync(join(tmpdir(), "threads-store-"));
const item = (id: string, sentAt: string) => ({ id, conversationId: "conv_1", sender: { kind: "agent", id: "agent/manager" }, sentAt });

describe("the durable table", () => {
	it("keeps rows across a restart, and starts empty from a file it cannot read", () => {
		const file = join(dir(), "t.json");
		const first = new DurableTable<{ id: string; n: number }>(file);
		first.put({ id: "a", n: 1 });
		first.put({ id: "b", n: 2 });
		first.remove("a");
		assert.deepEqual(new DurableTable<{ id: string; n: number }>(file).all(), [{ id: "b", n: 2 }]);
		writeFileSync(file, "{not json");
		assert.deepEqual(new DurableTable(file).all(), []);
	});
});

describe("the durable inbox", () => {
	it("takes a message once, however often it is delivered", () => {
		const inbox = new DurableInbox(join(dir(), "inbox.json"));
		assert.equal(inbox.add(item("m1", "2026-10-10T10:00:00Z")), true);
		assert.equal(inbox.add(item("m1", "2026-10-10T10:00:00Z")), false);
		inbox.start("m1");
		inbox.finish("m1");
		assert.equal(inbox.add(item("m1", "2026-10-10T10:00:00Z")), false, "a handled message is still known");
	});

	it("gives back what was not handled after a restart, oldest first, and counts the tries", () => {
		const file = join(dir(), "inbox.json");
		const inbox = new DurableInbox(file, () => 5000);
		inbox.add(item("late", "2026-10-10T10:05:00Z"));
		inbox.add(item("early", "2026-10-10T10:00:00Z"));
		inbox.add(item("done", "2026-10-10T09:00:00Z"));
		inbox.start("early");
		inbox.start("done");
		inbox.finish("done");
		const after = new DurableInbox(file);
		assert.deepEqual(after.unfinished().map((row) => [row.id, row.status, row.attempts]), [["early", "running", 1], ["late", "received", 0]]);
		after.start("early");
		assert.equal(after.unfinished()[0]!.attempts, 2);
		after.markRecovered("late");
		assert.equal(after.unfinished().find((row) => row.id === "late")!.recovered, true);
	});
});

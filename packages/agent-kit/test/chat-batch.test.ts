import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Outcome } from "@somework/sdk";
import type { PlannedInstruction } from "../src/chat-model.ts";
import { chatInstructionRig } from "../src/testing.ts";

const completed = (summary: string): Outcome => ({ type: "completed", result: { outcome: "verified", summary }, artifacts: [] }) as Outcome;

describe("an instruction that plans several jobs", () => {
	it("says what it found, runs the jobs one after another and answers each on its own", async () => {
		const rig = chatInstructionRig({ stateDir: mkdtempSync(join(tmpdir(), "batch-")) });
		const ran: string[] = [];
		const handler = async (job: any): Promise<Outcome> => {
			ran.push(`${job.taskId}:${job.input.ticket}`);
			return completed(`checked ${job.input.ticket}`);
		};
		const plan = async (): Promise<PlannedInstruction> => ({
			intro: "Found 2 tickets in Test: A-1, A-2. I verify them one at a time.",
			batch: ["A-1", "A-2"].map((ticket) => ({ capability: { id: "qa.verify", version: "1" }, input: { ticket } })),
		});
		const chat = rig.responderFor(handler as never, plan);
		await chat.instruct("verify everything in Test");
		assert.deepEqual(ran, ["chat-m1-1:A-1", "chat-m1-2:A-2"]);
		const said = rig.posts.map((post) => String(post.content?.data));
		assert.equal(said.length, 3);
		assert.match(said[0]!, /Found 2 tickets in Test/);
		assert.match(said[1]!, /^\(1\/2\) .*checked A-1/s);
		assert.match(said[2]!, /^\(2\/2\) .*checked A-2/s);
	});

	it("still takes a single job and a refusal as before, and a planner may answer later", async () => {
		const rig = chatInstructionRig({ stateDir: mkdtempSync(join(tmpdir(), "batch-")) });
		const handler = async (job: any): Promise<Outcome> => completed(`checked ${job.input.ticket}`);
		const chat = rig.responderFor(handler as never, (text) => (text.includes("none") ? { refuse: "nothing to do" } : { capability: { id: "qa.verify", version: "1" }, input: { ticket: "B-1" } }));
		assert.match(await chat.instruct("verify B-1"), /^(?!\().*checked B-1/s);
		assert.match(await chat.instruct("none"), /I cannot do that as an instruction: nothing to do/);
	});
});

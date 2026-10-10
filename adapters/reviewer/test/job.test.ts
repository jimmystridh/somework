import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { approvalPolicy, PiDurableRuntime } from "@somework/agent-kit";
import { chatInstructionRig, makeRemote, sh } from "@somework/agent-kit/testing";
import { reviewerChat } from "../src/chat.ts";
import { createReviewerHandler } from "../src/handler.ts";
import { profile } from "../src/profile.ts";
import { answer, turnModels } from "./support.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function rig(turns: string[][]) {
	const { dir, remote } = makeRemote();
	const seed = join(dir, "seed");
	sh(seed, "checkout", "-b", "feature");
	writeFileSync(join(seed, "feature.txt"), "item = list[0]\n");
	sh(seed, "add", "-A");
	sh(seed, "commit", "-m", "read the first item");
	sh(seed, "push", "origin", "feature");
	const work = mkdtempSync(join(tmpdir(), "reviewer-chat-"));
	const workspaceRoot = join(work, "workspaces");
	const env = (cwd: string | undefined) => new NodeExecutionEnv({ cwd: cwd ?? workspaceRoot });
	const fake = turnModels(turns);
	const runtime = new PiDurableRuntime({ storagePath: join(work, "pi.sqlite"), models: fake.models, model: fake.model, env, policy: approvalPolicy([], profile.approvalPatterns), instructions: profile.systemPrompt, allowedTools: profile.allowedTools });
	await runtime.start();
	cleanups.push(() => runtime.close());
	const chat = chatInstructionRig({ stateDir: work });
	const handler = createReviewerHandler({ runtime, session: { env: env(workspaceRoot), identity: { name: "Reviewer", email: "reviewer@test.invalid" } }, workspaceRoot, client: chat.client, limits: { maxTokensCap: 5_000_000, maxMinutesCap: 60 } });
	const hooks = reviewerChat({ CHAT_REPOSITORY_URL: "https://example.test/o/r" } as NodeJS.ProcessEnv);
	// the role's own mapping, with the repository replaced by the local one (the mapping accepts https URLs only)
	const input: typeof hooks.instructInput = (text) => {
		const planned = hooks.instructInput!(text) as { capability: any; input: any };
		if ("refuse" in planned) return planned;
		return { ...planned, input: { ...planned.input, repository: { ...planned.input.repository, url: remote } } };
	};
	return { ...chat, remote, instruct: chat.responderFor(handler, input!, hooks.describeResult).instruct };
}

describe("a review given as an instruction in chat, in a domain that has no task for it", () => {
	it("finishes: the report is kept on the host, the verdict and the findings are in the reply, and no task-bound call is made", async () => {
		const r = await rig([[`final:${answer()}`]]);
		const reply = await r.instruct("ref: feature\nticket: ABC-12\nlook at empty lists");
		assert.match(reply, /^Review done: request_changes\./);
		assert.match(reply, /Findings: 1 P1\./);
		assert.match(reply, /Attachments were not uploaded to the domain/);
		assert.match(reply, /chat-m1-review\.md \(text\/markdown/);
		assert.match(reply, /no guard/);
		assert.deepEqual(r.domain.calls, [], "the domain was not asked anything for the chat job");
		assert.ok(Buffer.byteLength(reply) <= 4096);
	});

	it("keeps the raw answer of a review that could not be used, instead of failing on the upload", async () => {
		const r = await rig([["final:no structured result at all"], ["final:still none"]]);
		const reply = await r.instruct("ref: feature\nreview it");
		assert.match(reply, /invalid_review_output/);
		assert.match(reply, /chat-m1-raw-answer\.txt/);
		assert.doesNotMatch(reply, /not_found|task not found/);
		assert.deepEqual(r.domain.calls, []);
	});
});

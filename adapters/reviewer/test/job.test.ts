import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { approvalPolicy, PiDurableRuntime } from "@somework/agent-kit";
import { jobRig, makeRemote, sh } from "@somework/agent-kit/testing";
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
	const chat = jobRig({ stateDir: work });
	const handler = createReviewerHandler({ runtime, session: { env: env(workspaceRoot), identity: { name: "Reviewer", email: "reviewer@test.invalid" } }, workspaceRoot, client: chat.client, limits: { maxTokensCap: 5_000_000, maxMinutesCap: 60 } });
	const hooks = reviewerChat({ CHAT_REPOSITORY_URL: "https://example.test/o/r" } as NodeJS.ProcessEnv);
	// the role's own tool, with the repository replaced by the local one (the tool accepts https URLs only)
	const review = async (args: { ref?: string; ticket?: string; focus?: string }) => {
		const planned = (await hooks.jobTools![0]!.plan(args)) as { capability: any; input: any; label: string };
		return chat.run(handler, { capability: planned.capability, input: { ...planned.input, repository: { ...planned.input.repository, url: remote } }, label: planned.label }, hooks.describeResult);
	};
	return { ...chat, remote, review };
}

describe("a review run as a job, in a domain that has no task for it", () => {
	it("finishes: the report is uploaded and carried by the result, the verdict and the findings are in the message, and no task-bound call is made", async () => {
		const r = await rig([[`final:${answer()}`]]);
		const run = await r.review({ ref: "feature", ticket: "ABC-12", focus: "look at empty lists" });
		assert.equal(run.entry.end?.kind, "completed");
		assert.match(run.text, /^review feature \(job-[a-z0-9-]+\)\nReview done: request_changes\./);
		assert.match(run.text, /Findings: 1 P1\./);
		assert.ok(r.domain.uploaded.some((name) => name.endsWith("review.md")), "the report went to the domain");
		assert.ok(run.artifacts.length >= 1, "the result message carries it");
		assert.ok(!r.domain.calls.some((call) => /tasks\/job-|for job-/.test(call)), r.domain.calls.join(", "));
		assert.ok(Buffer.byteLength(run.text) <= 4096);
	});

	it("keeps the raw answer of a review that could not be used, instead of failing on the upload", async () => {
		const r = await rig([["final:no structured result at all"], ["final:still none"]]);
		const run = await r.review({ ref: "feature", focus: "review it" });
		assert.match(run.text, /invalid_review_output/);
		assert.ok(r.domain.uploaded.some((name) => name.endsWith("raw-answer.txt")), r.domain.uploaded.join(", "));
		assert.doesNotMatch(run.text, /not_found|task not found/);
		assert.ok(!r.domain.calls.some((call) => /tasks\/job-|for job-/.test(call)));
	});
});

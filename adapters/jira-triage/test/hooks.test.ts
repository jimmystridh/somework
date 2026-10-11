import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createHandler, describeOutcome, Metrics, noPullRequests, type AgentRuntime, type Outcome } from "@somework/agent-kit";
import { jobRig, runHandler } from "@somework/agent-kit/testing";
import { describeTriage } from "../src/chat.ts";
import { createTriageHooks, parseTriageInput } from "../src/hooks.ts";
import { profile } from "../src/profile.ts";
import { RefusingRuntime } from "../src/worker.ts";
import { COMPLETE_TEXT, rig, thinBug } from "./rig.ts";
import { issueOf } from "./memory-jira.ts";

/** A runtime that fails the test when anything asks it for a model run. */
function noModel() {
	const calls: string[] = [];
	const runtime: AgentRuntime = {
		async start() {},
		health: () => ({ ready: true }),
		async close() {},
		async execute(request) {
			calls.push(request.requestId);
			throw new Error("no model run is expected for a triage");
		},
	};
	return { runtime, calls };
}

function stack(options: Parameters<typeof rig>[0] = {}) {
	const world = rig(options);
	const model = noModel();
	const rigJobs = jobRig({ stateDir: mkdtempSync(join(tmpdir(), "jira-jobs-")) });
	const hooks = createTriageHooks({ engine: world.engine });
	const handler = createHandler({ runtime: hooks.wrapRuntime!(model.runtime), envFor: () => ({}) as never, session: {} as never, host: noPullRequests, workspaceRoot: "/nowhere", client: rigJobs.client, limits: { maxTokensCap: 1_000_000, maxMinutesCap: 60 }, metrics: new Metrics(), profile, hooks });
	return { world, model, handler, rigJobs };
}

const job = (input: unknown) => ({ capability: { id: "jira.triage", version: "1" }, input: input as Record<string, unknown> });

describe("a triage job", () => {
	it("is the engine's pass over the ticket, ends without a model run, and reports where the triage stands", async () => {
		const { world, model, handler } = stack({ issues: [issueOf("SAD-1", { summary: "Invoice total", description: COMPLETE_TEXT })] });
		const outcome = (await runHandler(handler, job({ ticket: "SAD-1", trigger: { kind: "created", eventKey: "jira:1:created" } }))) as Extract<Outcome, { type: "completed" }>;
		assert.equal(outcome.type, "completed");
		assert.deepEqual(outcome.result, { status: "complete", ticket: "SAD-1", summary: "complete: it has what the checklist asks for", missing: [] });
		assert.deepEqual(model.calls, []);
		assert.deepEqual(world.ticket().labels, ["triaged-by-bot"]);
	});

	it("says in its result when the reporter was asked, and on which way", async () => {
		const { world, handler } = stack({ issues: [thinBug()], developer: false });
		const outcome = (await runHandler(handler, job({ ticket: "SAD-1", trigger: { kind: "created" } }))) as Extract<Outcome, { type: "completed" }>;
		assert.equal((outcome.result as any).status, "asked_reporter");
		assert.equal((outcome.result as any).via, "slack");
		assert.deepEqual((outcome.result as any).missing, ["reproduction-steps", "expected-actual", "environment-version"]);
		assert.equal(world.slack!.posted.length, 1);
	});

	it("is a completed job, not a failed one, when the ticket system is down: the retry is the engine's", async () => {
		const { world, handler } = stack({ issues: [thinBug()] });
		world.jira.down = true;
		const outcome = (await runHandler(handler, job({ ticket: "SAD-1", trigger: { kind: "created" } }))) as Extract<Outcome, { type: "completed" }>;
		assert.equal(outcome.type, "completed");
		assert.equal((outcome.result as any).status, "retry");
		assert.equal(world.store.get("SAD-1")?.phase, "queued");
	});

	it("ignores what is not its business and says why", async () => {
		const { handler } = stack();
		const outcome = (await runHandler(handler, job({ ticket: "OTHER-1", trigger: { kind: "created" } }))) as Extract<Outcome, { type: "completed" }>;
		assert.equal((outcome.result as any).status, "ignored");
		assert.match((outcome.result as any).summary, /not one of the projects/);
	});

	it("refuses input that is not a ticket and a trigger, and a capability it only serves in conversation", async () => {
		const { handler } = stack();
		for (const input of [{}, { ticket: "nope", trigger: { kind: "created" } }, { ticket: "SAD-1" }, { ticket: "SAD-1", trigger: { kind: "bogus" } }, { description: "make a ticket" }]) {
			const outcome = await runHandler(handler, job(input));
			assert.equal(outcome.type, "failed", JSON.stringify(input));
			assert.equal((outcome as any).failure.code, "invalid_input");
			assert.equal((outcome as any).failure.retryable, false);
		}
	});

	it("shows up in the journal and in the conversation with the ticket as its subject", async () => {
		const { handler, rigJobs } = stack({ issues: [thinBug()], developer: false });
		const { text } = await rigJobs.run(handler, { capability: { id: "jira.triage", version: "1" }, input: { ticket: "SAD-1", trigger: { kind: "manual" } } }, describeTriage);
		assert.match(text, /SAD-1: asked reporter - asked Dana Dev on Slack about reproduction-steps/);
		const described = describeOutcome({ type: "completed", result: { status: "asked_reporter", ticket: "SAD-1", summary: "asked" } });
		assert.equal(described?.subject, "SAD-1");
		assert.equal(described?.outcome, "asked_reporter");
	});

	it("is not run for a capability the card does not offer", async () => {
		const { handler } = stack();
		const outcome = await runHandler(handler, { capability: { id: "code.agent", version: "1" }, input: { ticket: "SAD-1", trigger: { kind: "created" } } });
		assert.equal((outcome as any).failure.code, "unsupported_capability");
	});
});

describe("the input of a job", () => {
	it("keeps the key, the kind and what each kind needs, cut to size", () => {
		assert.deepEqual(parseTriageInput({ ticket: " SAD-12 ", trigger: { kind: "created", eventKey: "k".repeat(300) } }), { ticket: "SAD-12", trigger: { kind: "created", eventKey: "k".repeat(120) } });
		assert.deepEqual(parseTriageInput({ ticket: "SAD-1", trigger: { kind: "updated", changed: ["description", 5, "x".repeat(100)] } }).trigger, { kind: "updated", changed: ["description", "x".repeat(60)] });
		assert.deepEqual(parseTriageInput({ ticket: "SAD-1", trigger: { kind: "comment", commentId: "9", author: "dana" } }).trigger, { kind: "comment", commentId: "9", author: "dana" });
		assert.deepEqual(parseTriageInput({ ticket: "SAD-1", trigger: { kind: "comment", author: "dana; DROP" } }).trigger, { kind: "comment" });
		assert.deepEqual(parseTriageInput({ ticket: "SAD-1", trigger: { kind: "manual", force: true } }).trigger, { kind: "manual", force: true });
		assert.deepEqual(parseTriageInput({ ticket: "SAD-1", trigger: { kind: "manual", force: "yes" } }).trigger, { kind: "manual" });
	});
});

describe("the model of this role", () => {
	it("is refused every approval: no shell, no file writes, whoever would be asked", async () => {
		const seen: { approved: boolean; reason?: string }[] = [];
		const inner: AgentRuntime = {
			async start() {},
			health: () => ({ ready: true }),
			async close() {},
			async execute(_request, hooks) {
				seen.push(await hooks.requestApproval({ tool: "bash", summary: "rm -rf /" }));
				return { status: "done", answer: "ok", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 } };
			},
		};
		await new RefusingRuntime(inner).execute({ requestId: "r", agentKey: "k", instruction: "i", workspace: "/w", budget: { maxTokens: 1, maxMinutes: 1 } }, { signal: new AbortController().signal, onProgress() {}, requestApproval: async () => ({ approved: true }) });
		assert.deepEqual(seen, [{ approved: false, reason: "this agent has no use for a shell or for files: use the ticket tools" }]);
	});
});

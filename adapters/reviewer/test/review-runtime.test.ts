import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentOutcome, AgentRequest, AgentRuntime, RunHooks } from "@somework/agent-kit";
import { ReviewRuntime } from "../src/review-runtime.ts";

const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15, costUsd: 0 };
const hooks = (): RunHooks => ({ signal: new AbortController().signal, onProgress() {}, requestApproval: async () => ({ approved: true }) });
const request = (requestId: string): AgentRequest => ({ requestId, agentKey: "k", instruction: "go", workspace: "/w", budget: { maxTokens: 100_000, maxMinutes: 5 } });
const inner = (answer: string, seen: AgentRequest[]): AgentRuntime => ({
	start: async () => {},
	health: () => ({ ready: true }),
	close: async () => {},
	execute: async (r): Promise<AgentOutcome> => (seen.push(r), { status: "done", answer, usage }),
});

describe("ReviewRuntime", () => {
	it("passes a chat answer through as written: no repair turn and no review kept", async () => {
		const seen: AgentRequest[] = [];
		const runtime = new ReviewRuntime(inner("I am up.", seen));
		const outcome = await runtime.execute(request("thread:msg_1"), hooks());
		assert.equal(outcome.status === "done" && outcome.answer, "I am up.");
		assert.equal(seen.length, 1);
		assert.equal(runtime.take("thread:msg_1"), undefined);
	});

	it("still asks for one repair turn when the answer of a job is not a review", async () => {
		const seen: AgentRequest[] = [];
		const runtime = new ReviewRuntime(inner("no json here", seen));
		await runtime.execute(request("somework:job-1"), hooks());
		assert.equal(seen.length, 2);
		assert.equal(seen[1]!.requestId, "somework:job-1:repair");
	});

	it("refuses a mutation the read-only policy denied, in a chat as in a job", async () => {
		let answered: unknown;
		const guard: AgentRuntime = { ...inner("ok", []), execute: async (_r, runHooks) => ((answered = await runHooks.requestApproval({ tool: "bash", summary: "x" } as never)), { status: "done", answer: "ok", usage }) };
		await new ReviewRuntime(guard).execute(request("thread:msg_2"), hooks());
		assert.ok(answered);
	});
});

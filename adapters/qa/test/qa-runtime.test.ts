import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentOutcome, AgentRequest, AgentRuntime, RunHooks } from "@somework/agent-kit";
import { QaRuntime } from "../src/qa-runtime.ts";

const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15, costUsd: 0 };
const hooks = (): RunHooks => ({ signal: new AbortController().signal, onProgress() {}, requestApproval: async () => ({ approved: true }) });
const request = (requestId: string): AgentRequest => ({ requestId, agentKey: "k", instruction: "go", workspace: "/w", budget: { maxTokens: 100_000, maxMinutes: 5 } });
const inner = (answer: string, seen: AgentRequest[]): AgentRuntime => ({
	start: async () => {},
	health: () => ({ ready: true }),
	close: async () => {},
	execute: async (r): Promise<AgentOutcome> => (seen.push(r), { status: "done", answer, usage }),
});

describe("QaRuntime", () => {
	it("passes a chat answer through as written: no repair turn and no report kept", async () => {
		const seen: AgentRequest[] = [];
		const runtime = new QaRuntime(inner("SAD-1 is on Test, I will look at it.", seen));
		const outcome = await runtime.execute(request("thread:msg_1"), hooks());
		assert.equal(outcome.status === "done" && outcome.answer, "SAD-1 is on Test, I will look at it.");
		assert.equal(seen.length, 1);
		assert.equal(runtime.take("thread:msg_1"), undefined);
	});

	it("still asks for one repair turn when the answer of a job is not a report", async () => {
		const seen: AgentRequest[] = [];
		await new QaRuntime(inner("no json here", seen)).execute(request("somework:job-1"), hooks());
		assert.equal(seen.length, 2);
		assert.equal(seen[1]!.requestId, "somework:job-1:repair");
	});
});

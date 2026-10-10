import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentOutcome, AgentRequest, AgentRuntime, RunHooks, Usage } from "@somework/agent-kit";
import { REFUSED } from "../src/commands.ts";
import { evidenceProblems, extractJson, markUnverified, validateTriage, type Triage } from "../src/result.ts";
import { TriageRuntime } from "../src/triage-runtime.ts";

const good = (extra: Record<string, unknown> = {}) => ({
	outcome: "diagnosed",
	severity: "high",
	summary: "Checkout errors rose after the 11:50 deploy.",
	suspectedCause: "Deploy 1.2.3 broke the payment client.",
	confidence: "medium",
	timeline: [{ at: "2026-10-06T11:50:00Z", note: "deploy finished" }],
	evidence: [{ kind: "events", query: "source:deployment", finding: "deploy at 11:50", refs: ["call-1"] }],
	recommendedActions: ["roll back 1.2.3"],
	...extra,
});
const fenced = (value: unknown) => `Here is my answer.\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\`\nDone.`;
const issued = (...refs: string[]) => ({ has: (ref: string) => refs.includes(ref) });

describe("extractJson", () => {
	it("takes the last fenced json block, else the outermost braces", () => {
		assert.deepEqual(extractJson(`\`\`\`json\n{"a":1}\n\`\`\`\ntext\n\`\`\`json\n{"a":2}\n\`\`\``), { a: 2 });
		assert.deepEqual(extractJson('prefix {"a": {"b": 1}} suffix'), { a: { b: 1 } });
		assert.equal(extractJson("no json at all"), undefined);
		assert.equal(extractJson("```json\n[1,2]\n```"), undefined);
		assert.equal(extractJson("```json\n{broken\n```"), undefined);
	});
});

describe("validateTriage", () => {
	it("accepts a complete answer and cleans its text", () => {
		const parsed = validateTriage(good({ summary: "  token=abcdefghijklmnop leaked \u0007 here  " }));
		assert.ok(parsed.ok);
		if (parsed.ok) {
			assert.equal(parsed.triage.summary, "token=[redacted] leaked   here");
			assert.deepEqual(parsed.triage.evidence[0], { kind: "events", query: "source:deployment", finding: "deploy at 11:50", refs: ["call-1"] });
			assert.equal(parsed.truncated, false);
		}
	});

	it("lists every problem at once, so one repair turn can fix them all", () => {
		const parsed = validateTriage({ outcome: "maybe", severity: "huge", summary: "", confidence: "sure", timeline: "none", evidence: [{ kind: "logs" }], recommendedActions: [3] });
		assert.ok(!parsed.ok);
		if (!parsed.ok) {
			const text = parsed.problems.join("\n");
			for (const part of [/outcome must be one of/, /severity must be one of/, /summary is required/, /confidence must be one of/, /timeline must be an array/, /evidence\[0\] must be/, /recommendedActions\[0\] must be/]) assert.match(text, part);
		}
	});

	it("needs a suspected cause for a diagnosis, not for the other outcomes", () => {
		assert.ok(!validateTriage(good({ suspectedCause: undefined })).ok);
		assert.ok(validateTriage(good({ outcome: "inconclusive", suspectedCause: undefined })).ok);
		assert.ok(validateTriage(good({ outcome: "noise", suspectedCause: undefined, severity: "info" })).ok);
		assert.ok(!validateTriage(good({ outcome: "skipped" })).ok, "the model cannot say skipped");
	});

	it("cuts long text and long lists, and says it did", () => {
		const parsed = validateTriage(good({ summary: "s".repeat(5000), timeline: Array.from({ length: 30 }, () => ({ at: "t", note: "n" })), recommendedActions: Array.from({ length: 20 }, () => "a") }));
		assert.ok(parsed.ok);
		if (parsed.ok) {
			assert.equal(parsed.triage.summary.length, 1200);
			assert.equal(parsed.triage.timeline.length, 10);
			assert.equal(parsed.triage.recommendedActions.length, 6);
			assert.equal(parsed.truncated, true);
		}
	});

	it("drops anything it does not know", () => {
		const parsed = validateTriage(good({ extra: "x", muteMonitor: true }));
		assert.ok(parsed.ok);
		if (parsed.ok) assert.deepEqual(Object.keys(parsed.triage).sort(), ["confidence", "evidence", "outcome", "recommendedActions", "severity", "summary", "suspectedCause", "timeline"]);
	});
});

describe("evidence", () => {
	const triage = (evidence: unknown[]): Triage => {
		const parsed = validateTriage(good({ evidence }));
		assert.ok(parsed.ok);
		return (parsed as { triage: Triage }).triage;
	};

	it("accepts findings that cite a real call or are marked as inference", () => {
		assert.deepEqual(evidenceProblems(triage([{ kind: "logs", finding: "a", refs: ["call-1", "call-2"] }, { kind: "analysis", finding: "b", inference: true }]), issued("call-1", "call-2")), []);
	});

	it("flags findings with no refs, with refs nobody handed out, and not marked as inference", () => {
		const problems = evidenceProblems(triage([{ kind: "logs", finding: "a" }, { kind: "logs", finding: "b", refs: ["call-9"] }, { kind: "logs", finding: "c", refs: ["call-1", "made-up"] }]), issued("call-1"));
		assert.equal(problems.length, 3);
		assert.match(problems[0]!, /evidence\[0\] cites no tool call/);
		assert.match(problems[1]!, /"call-9", which no tool call of yours returned/);
		assert.match(problems[2]!, /"made-up"/);
	});

	it("marks what stays unverified as inference, with a warning, and keeps the verified refs", () => {
		const marked = markUnverified(triage([{ kind: "logs", finding: "a", refs: ["call-1"] }, { kind: "logs", finding: "b", refs: ["call-1", "x"] }, { kind: "logs", finding: "c" }]), issued("call-1"));
		assert.deepEqual(marked.evidence.map((item) => [item.inference ?? false, item.refs]), [[false, ["call-1"]], [true, ["call-1"]], [true, []]]);
		assert.match(marked.warnings![0]!, /2 evidence item\(s\) cited no tool call the service could verify and were marked as inference/);
		assert.equal(markUnverified(triage([{ kind: "logs", finding: "a", refs: ["call-1"] }]), issued("call-1")).warnings, undefined);
	});
});

describe("TriageRuntime", () => {
	const usage = (totalTokens: number): Usage => ({ inputTokens: totalTokens, outputTokens: 0, totalTokens, costUsd: totalTokens / 1000 });
	const request = (extra: Partial<AgentRequest> = {}): AgentRequest => ({ requestId: "somework:t1", agentKey: "k", instruction: "go", workspace: "/w", budget: { maxTokens: 100_000, maxMinutes: 5 }, ...extra });
	const hooks = (): RunHooks & { approvals: unknown[] } => {
		const approvals: unknown[] = [];
		return { signal: new AbortController().signal, onProgress() {}, requestApproval: async (a) => (approvals.push(a), { approved: true }), approvals };
	};
	const inner = (answers: AgentOutcome[], seen: AgentRequest[] = []): AgentRuntime => ({
		start: async () => {},
		health: () => ({ ready: true }),
		close: async () => {},
		execute: async (r) => (seen.push(r), answers.shift()!),
	});
	const done = (answer: string, tokens = 1000): AgentOutcome => ({ status: "done", answer, usage: usage(tokens) });

	it("keeps a good answer as it is, with no repair turn", async () => {
		const seen: AgentRequest[] = [];
		const runtime = new TriageRuntime(inner([done(fenced(good()))], seen), issued("call-1"));
		const outcome = await runtime.execute(request(), hooks());
		assert.equal(outcome.status, "done");
		assert.equal(seen.length, 1);
		const kept = runtime.take("somework:t1");
		assert.ok(kept?.ok && !kept.repaired && kept.triage.severity === "high");
		assert.equal(runtime.take("somework:t1"), undefined, "handed out once");
	});

	it("passes a chat answer through as written: no repair turn and nothing kept for a result", async () => {
		const seen: AgentRequest[] = [];
		const runtime = new TriageRuntime(inner([done("Looks like a deploy, nothing else.")], seen), issued("call-1"));
		const outcome = await runtime.execute(request({ requestId: "thread:msg_1" }), hooks());
		assert.equal(outcome.status === "done" && outcome.answer, "Looks like a deploy, nothing else.");
		assert.equal(seen.length, 1);
		assert.equal(runtime.take("thread:msg_1"), undefined);
	});

	it("repairs once in the same conversation when a finding cites nothing, and adds up the usage", async () => {
		const seen: AgentRequest[] = [];
		const runtime = new TriageRuntime(inner([done(fenced(good({ evidence: [{ kind: "logs", finding: "x" }] })), 4000), done(fenced(good()), 1500)], seen), issued("call-1"));
		const outcome = await runtime.execute(request(), hooks());
		assert.equal(seen.length, 2);
		assert.equal(seen[1]!.requestId, "somework:t1:repair");
		assert.equal(seen[1]!.agentKey, "k");
		assert.match(seen[1]!.instruction, /evidence\[0\] cites no tool call/);
		assert.deepEqual(seen[1]!.budget, { maxTokens: 96_000, maxMinutes: 5 });
		assert.equal(outcome.status === "done" && outcome.usage.totalTokens, 5500);
		const kept = runtime.take("somework:t1");
		assert.ok(kept?.ok && kept.repaired && !kept.triage.warnings);
	});

	it("marks findings that are still unsupported after the repair as inference rather than failing the triage", async () => {
		const bad = good({ evidence: [{ kind: "logs", finding: "x", refs: ["invented"] }] });
		const runtime = new TriageRuntime(inner([done(fenced(bad)), done(fenced(bad))]), issued("call-1"));
		await runtime.execute(request(), hooks());
		const kept = runtime.take("somework:t1");
		assert.ok(kept?.ok);
		if (kept?.ok) {
			assert.equal(kept.triage.evidence[0]!.inference, true);
			assert.match(kept.triage.warnings![0]!, /marked as inference/);
		}
	});

	it("fails when the answer has no usable shape even after the repair, and keeps the raw answer", async () => {
		const runtime = new TriageRuntime(inner([done("I think it is the database."), done("still prose")]), issued());
		await runtime.execute(request(), hooks());
		const kept = runtime.take("somework:t1");
		assert.ok(kept && !kept.ok);
		if (kept && !kept.ok) {
			assert.match(kept.reason, /holds no json object.*after one repair turn/);
			assert.equal(kept.raw, "still prose");
		}
	});

	it("does not start a repair turn without budget for it, nor when the run did not end with an answer", async () => {
		const seen: AgentRequest[] = [];
		const noBudget = new TriageRuntime(inner([done("prose", 99_000)], seen), issued());
		await noBudget.execute(request(), hooks());
		assert.equal(seen.length, 1);
		const kept = noBudget.take("somework:t1");
		assert.ok(kept && !kept.ok && /no budget left for a repair turn/.test(kept.reason));
		const stopped = new TriageRuntime(inner([{ status: "aborted", reason: "timeout", usage: usage(5) }]), issued());
		assert.equal((await stopped.execute(request(), hooks())).status, "aborted");
		assert.equal(stopped.take("somework:t1"), undefined);
	});

	it("falls back to the first answer when the repair turn does not finish", async () => {
		const first = good({ evidence: [{ kind: "logs", finding: "x" }] });
		const runtime = new TriageRuntime(inner([done(fenced(first), 2000), { status: "aborted", reason: "budget_exceeded", usage: usage(3000) }]), issued("call-1"));
		const outcome = await runtime.execute(request(), hooks());
		assert.equal(outcome.status, "aborted");
		assert.equal(outcome.status === "aborted" && outcome.usage.totalTokens, 5000);
		const kept = runtime.take("somework:t1");
		assert.ok(kept?.ok && kept.triage.evidence[0]!.inference === true);
	});

	it("refuses every approval and tells the model why", async () => {
		let asked: ((r: any) => Promise<any>) | undefined;
		const probing: AgentRuntime = {
			start: async () => {},
			health: () => ({ ready: true }),
			close: async () => {},
			execute: async (_r, h) => ((asked = h.requestApproval as never), done(fenced(good()))),
		};
		const runtime = new TriageRuntime(probing, issued("call-1"));
		const h = hooks();
		await runtime.execute(request(), h);
		const policy = await asked!({ tool: "bash", summary: `${REFUSED}: curl is not available` });
		assert.deepEqual([policy.approved, policy.reason], [false, `${REFUSED}: curl is not available`]);
		const other = await asked!({ tool: "handler_save", summary: "change the agent's event handlers" });
		assert.equal(other.approved, false);
		assert.match(other.reason, /change the agent's event handlers\. no person answers/);
		assert.equal(h.approvals.length, 0, "nobody was asked");
	});
});

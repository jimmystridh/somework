import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { RunRecall } from "../src/recall.ts";
import { INDEX_FILE, RunTrace } from "../src/trace.ts";

const tmp = (): string => mkdtempSync(join(tmpdir(), "run-recall-"));

/** A small history on a fake clock: a chat run that starts a job, the job's run, a spawn-off into another conversation, its answer, and an unrelated run. */
function history() {
	const dir = tmp();
	let clock = Date.parse("2026-10-12T10:00:00Z");
	const trace = new RunTrace({ dir, agentId: "agent/me", role: "r", now: () => clock });
	const model = (text: string, calls: string[] = []) => ({ type: "message_end", entry: { id: `e${clock}`, model: [{ role: "assistant", content: [{ type: "text", text }, ...calls.map((name) => ({ type: "toolCall", name }))], provider: "p", model: "m", stopReason: calls.length > 0 ? "toolUse" : "stop", usage: { totalTokens: 5 } }] } });
	const tool = (recording: any, id: string, name: string, args: unknown, output: string, isError = false) => {
		recording.event({ type: "tool_execution_start", toolCallId: id, toolName: name, args });
		clock += 400;
		recording.event({ type: "tool_execution_end", toolCallId: id, toolName: name, entry: { model: [{ role: "toolResult", isError, content: [{ type: "text", text: output }] }] } });
	};
	const minute = () => void (clock += 60_000);

	const a = trace.open({ requestId: "thread:m1", agentKey: "k1", instruction: "framed prompt one", meta: { kind: "chat", conversationId: "c1", messageId: "m1", by: "user/jimmy (human)", asked: "verify SAD-1 please" } });
	a.event({ type: "message_end", entry: { id: "u", model: [{ role: "user", content: "framed prompt one" }] } });
	a.event(model("on it", ["bash"]));
	tool(a, "t1", "bash", { command: "git status" }, "clean");
	tool(a, "t2", "bash", { command: "npm test" }, "2 failed", true);
	a.note("job_started", { jobId: "job-1", label: "verify SAD-1", capability: "qa.verify@1" });
	a.event(model("Started job-1"));
	a.end({ status: "done", answer: "Started job-1", usage: { totalTokens: 40, costUsd: 0.01 } });
	a.note("sent", { messageId: "out1", conversationId: "c1", to: ["user/jimmy"], via: "reply" });
	minute();

	const b = trace.open({ requestId: "somework:job-1", agentKey: "repo#job-1", instruction: "verify SAD-1", meta: { kind: "job", jobId: "job-1", conversationId: "c1", by: "user/jimmy (human)", asked: "verify SAD-1" } });
	tool(b, "t1", "read", { path: "README.md" }, "hello");
	b.end({ status: "done", answer: "SAD-1 verified", usage: { totalTokens: 90 } });
	b.note("sent", { messageId: "out2", conversationId: "c1", to: ["user/jimmy"], via: "job_result" });
	minute();

	const c = trace.open({ requestId: "thread:m2", agentKey: "k2", instruction: "framed prompt two", meta: { kind: "chat", conversationId: "c1", messageId: "m2", asked: "ask qa about the stack" } });
	c.note("sent", { messageId: "out3", conversationId: "dm-qa", to: ["agent/qa"], fromConversation: "c1", via: "message_send" });
	c.end({ status: "done", answer: "I asked agent/qa", usage: { totalTokens: 10 } });
	c.note("no_reply", { why: "NO_REPLY" });
	minute();

	const d = trace.open({ requestId: "thread:m3", agentKey: "k3", instruction: "x", meta: { kind: "chat", conversationId: "dm-qa", messageId: "m3", asked: "the stack is up" } });
	d.end({ status: "done", answer: "thanks", usage: { totalTokens: 3 } });
	d.note("sent", { messageId: "out4", conversationId: "dm-qa", to: ["agent/qa"], via: "reply" });
	minute();

	const e = trace.open({ requestId: "thread:m9", agentKey: "k9", instruction: "x", meta: { kind: "chat", conversationId: "c9", messageId: "m9", asked: "something private" } });
	e.end({ status: "done", answer: "ok", usage: { totalTokens: 3 } });
	return { dir, recall: new RunRecall({ dir, now: () => clock }), advance: () => (clock += 3_600_000) };
}

describe("reading the run record back", () => {
	it("lists runs newest first and folds each run's lines into one summary", () => {
		const { recall } = history();
		assert.deepEqual(recall.all().map((run) => run.runId), ["thread:m9", "thread:m3", "thread:m2", "somework:job-1", "thread:m1"]);
		const run = recall.find("thread:m1")!;
		assert.deepEqual([run.kind, run.conversationId, run.status, run.steps, run.tools, run.toolErrors, run.tokens], ["chat", "c1", "done", 2, { bash: 2 }, 1, 40]);
		assert.deepEqual(run.jobsStarted, [{ jobId: "job-1", label: "verify SAD-1" }]);
		assert.equal(run.sent[0]!.messageId, "out1");
		assert.equal(recall.find("thread:m2")!.noReply, "NO_REPLY");
	});

	it("finds a conversation's runs, a job's own run and the runs that started it, and the run that wrote a message", () => {
		const { recall } = history();
		assert.deepEqual(recall.inConversation("c1").map((run) => run.runId), ["thread:m2", "somework:job-1", "thread:m1"]);
		assert.deepEqual(recall.ofJob("job-1").map((run) => run.runId), ["somework:job-1", "thread:m1"]);
		assert.equal(recall.writerOf("out2")!.runId, "somework:job-1", "a job's result message belongs to the job's run, noted after the run ended");
		assert.equal(recall.writerOf("nope"), undefined);
	});

	it("ties a conversation a run opened to the one it came from, in both directions", () => {
		const { recall } = history();
		assert.deepEqual([recall.parentOf("dm-qa")?.conversationId, recall.parentOf("dm-qa")?.runId, recall.parentOf("dm-qa")?.to], ["c1", "thread:m2", ["agent/qa"]]);
		assert.deepEqual(recall.childrenOf("c1").map((link) => link.conversationId), ["dm-qa"]);
		assert.equal(recall.parentOf("c1"), undefined);
		assert.deepEqual([...recall.linked("dm-qa")].sort(), ["c1", "dm-qa"]);
		assert.deepEqual([...recall.linked("c9")], ["c9"]);
	});

	it("says what each of the agent's own messages did, for the history lines", () => {
		const { recall } = history();
		const notes = recall.notesFor(["out1", "out2", "out4", "unknown"]);
		assert.equal(notes.get("out1"), "run thread:m1; tools: bash×2, 1 failed; started job-1");
		assert.equal(notes.get("out2"), "run somework:job-1; tools: read");
		assert.equal(notes.get("out4"), "run thread:m3; no tools");
		assert.equal(notes.has("unknown"), false);
	});

	it("describes a run in one block: who asked, how it went, the tools, the answer, what it sent and started", () => {
		const { recall } = history();
		const text = recall.digest(recall.find("thread:m1")!);
		assert.match(text, /^thread:m1 · chat · 2026-10-12 10:00 \(.* ago\) · done in \d/);
		assert.match(text, /2 steps, 2 tool calls \(bash×2; 1 failed\)/);
		assert.match(text, /asked by user\/jimmy \(human\): "verify SAD-1 please"/);
		assert.match(text, /answered: "Started job-1" · sent out1 to user\/jimmy in c1 · started job-1 \(verify SAD-1\) · conversation c1/);
		assert.match(recall.digest(recall.find("thread:m2")!), /sent no reply \(NO_REPLY\).*sent out3 to agent\/qa in dm-qa \(message_send\)/);
	});

	it("lists the steps with tool calls joined to their results, and shows one step in full", () => {
		const { recall } = history();
		const run = recall.find("thread:m1")!;
		const steps = recall.steps(run).map((step) => step.text);
		assert.match(steps[0]!, /^start: prompt 17 chars/);
		assert.ok(steps.some((text) => /^tool bash \{"command":"git status"\} → ok 400ms: "clean"/.test(text)));
		assert.ok(steps.some((text) => /^tool bash \{"command":"npm test"\} → FAILED 400ms: "2 failed"/.test(text)));
		assert.ok(steps.some((text) => text === "started job job-1 (verify SAD-1)"));
		assert.match(steps.at(-1)!, /^sent out1 to user\/jimmy in c1 \(reply\)/);
		const failing = recall.steps(run).find((step) => step.text.includes("npm test"))!;
		const full = recall.step(run, failing.seq)!;
		assert.match(full.text, /"command": "npm test"/);
		assert.match(full.text, /"isError": true/);
		assert.match(full.text, /2 failed/);
		assert.equal(recall.step(run, 9999), undefined);
	});

	it("pages a long record", () => {
		const dir = tmp();
		const recording = new RunTrace({ dir, agentId: "a", role: "r" }).open({ requestId: "r1", agentKey: "k", instruction: "x" });
		recording.event({ type: "tool_execution_start", toolCallId: "t", toolName: "bash", args: {} });
		recording.event({ type: "tool_execution_end", toolCallId: "t", toolName: "bash", entry: { model: [{ role: "toolResult", content: [{ type: "text", text: "y".repeat(30_000) }] }] } });
		recording.end({ status: "done" });
		const recall = new RunRecall({ dir });
		const run = recall.find("r1")!;
		const seq = recall.steps(run).find((step) => step.text.startsWith("tool bash"))!.seq;
		const first = recall.step(run, seq)!;
		assert.ok(first.more! > 0 && first.text.length === 12_000);
		const second = recall.step(run, seq, first.text.length)!;
		assert.ok(second.text.length > 0);
	});

	it("searches the steps for words, every word, any case", () => {
		const { recall } = history();
		const hits = recall.search(recall.all(), "NPM test", 5);
		assert.deepEqual(hits.map((hit) => hit.run.runId), ["thread:m1"]);
		assert.match(hits[0]!.snippet, /npm test/);
		assert.deepEqual(recall.search(recall.all(), "never said this", 5), []);
		assert.deepEqual(recall.search(recall.all(), "   ", 5), []);
	});

	it("keeps up with a record that grows and ignores a damaged index line", () => {
		const { dir, recall } = history();
		assert.equal(recall.all().length, 5);
		const day = readdirSync(dir)[0]!;
		appendFileSync(join(dir, day, INDEX_FILE), "not json at all\n");
		appendFileSync(join(dir, day, INDEX_FILE), `${JSON.stringify({ t: "start", file: "late.jsonl", runId: "thread:late", at: "2026-10-12T12:00:00.000Z", kind: "chat" })}\n`);
		assert.equal(recall.all().length, 6);
		assert.equal(recall.all()[0]!.runId, "thread:late");
	});

	it("reads an empty or missing record as no runs", () => {
		assert.deepEqual(new RunRecall({ dir: join(tmp(), "nothing-here") }).all(), []);
		assert.deepEqual(new RunRecall({ dir: tmp() }).all(), []);
	});
});

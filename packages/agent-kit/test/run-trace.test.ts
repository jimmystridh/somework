import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { PiDurableRuntime } from "../src/pi-runtime.ts";
import { scriptedModels } from "../src/providers/faux.ts";
import { INDEX_FILE, RunTrace } from "../src/trace.ts";

const open: PiDurableRuntime[] = [];
afterEach(async () => {
	for (const runtime of open.splice(0)) await runtime.close();
});

const tmp = (): string => mkdtempSync(join(tmpdir(), "run-trace-"));
const linesOf = (dir: string): any[] => readdirSync(dir).flatMap((day) => readdirSync(join(dir, day)).filter((file) => file.endsWith(".jsonl")).flatMap((file) => readFileSync(join(dir, day, file), "utf8").trim().split("\n").map((line) => JSON.parse(line))));
const info = { requestId: "job-1", agentKey: "k", instruction: "do the work" };

describe("the run record", () => {
	it("keeps a real run whole: the instruction, every assistant turn with its usage, each tool call with arguments, result and time, and the end", async () => {
		const dir = tmp();
		const traces = join(dir, "runs");
		const fake = scriptedModels(["write:out.txt:hello", "bash:cat out.txt", "final:all done"]);
		const runtime = new PiDurableRuntime({ storagePath: join(dir, "s.sqlite"), models: fake.models, model: fake.model, env: (cwd) => new NodeExecutionEnv({ cwd: cwd ?? dir }), trace: new RunTrace({ dir: traces, agentId: "agent/me", role: "tester" }) });
		await runtime.start();
		open.push(runtime);
		const workspace = join(dir, "w");
		mkdirSync(workspace);
		const outcome = await runtime.execute({ requestId: "job-1", agentKey: "k", instruction: "do the work", workspace, budget: { maxTokens: 1_000_000, maxMinutes: 5 }, context: { sender: "agent/x" }, meta: { kind: "job", jobId: "j-1", conversationId: "c1" } }, { signal: new AbortController().signal, onProgress: () => undefined, requestApproval: async () => ({ approved: true }) });
		assert.equal(outcome.status, "done");
		const records = linesOf(traces);
		assert.deepEqual(records.map((record) => record.seq), records.map((_, index) => index), "in order, none missing");
		assert.deepEqual(records.map((record) => record.type).filter((type) => type !== "system"), ["run_start", "user", "assistant", "tool_start", "tool_end", "assistant", "tool_start", "tool_end", "assistant", "run_end"]);
		const start = records[0];
		assert.equal(start.instruction, "do the work");
		assert.deepEqual(start.context, { sender: "agent/x" });
		assert.equal(start.agent, "agent/me");
		assert.equal(start.role, "tester");
		const tools = records.filter((record) => record.type === "tool_start");
		assert.deepEqual(tools.map((record) => [record.tool, record.args]), [["write", { path: "out.txt", content: "hello" }], ["bash", { command: "cat out.txt" }]]);
		const ends = records.filter((record) => record.type === "tool_end");
		assert.equal(ends[1].output[0].text, "hello");
		assert.equal(ends[1].isError, false);
		assert.equal(typeof ends[1].ms, "number");
		assert.ok(records.filter((record) => record.type === "assistant").every((record) => record.usage?.totalTokens > 0 && record.provider && record.model));
		const end = records.at(-1);
		assert.equal(end.status, "done");
		assert.equal(end.answer, "all done");
		assert.ok(end.usage.totalTokens > 0);
		assert.deepEqual(start.meta, { kind: "job", jobId: "j-1", conversationId: "c1" });
		const day = readdirSync(traces)[0]!;
		const index = readFileSync(join(traces, day, INDEX_FILE), "utf8").trim().split("\n").map((line) => JSON.parse(line));
		assert.deepEqual(index.map((line) => line.t), ["start", "end"]);
		assert.deepEqual([index[0].kind, index[0].jobId, index[0].conversationId], ["job", "j-1", "c1"]);
		assert.deepEqual([index[1].status, index[1].steps, index[1].tools, index[1].toolErrors, index[1].answer], ["done", 3, { write: 1, bash: 1 }, 0, "all done"]);
	});

	it("takes secrets out by pattern and by key, and cuts long strings, but keeps the rest of the content", () => {
		const dir = tmp();
		const recording = new RunTrace({ dir, agentId: "agent/me", role: "r", maxStringChars: 50 }).open({ ...info, instruction: "use ghp_abcdefghijklmnop1234 to push" });
		recording.event({ type: "tool_execution_start", toolCallId: "t1", toolName: "http", args: { url: "https://x.test", headers: { authorization: "Bearer abcdefghijkl" }, password: "hunter2hunter2", note: "x".repeat(200) } });
		recording.end({ status: "done" });
		const [start, call] = linesOf(dir);
		assert.equal(start.instruction, "use [redacted] to push");
		assert.equal(call.args.url, "https://x.test");
		assert.equal(call.args.headers.authorization, "[redacted]");
		assert.equal(call.args.password, "[redacted]");
		assert.match(call.args.note, /^x{50}…\[150 chars cut\]$/);
	});

	it("records an error result and keeps the call's duration", () => {
		const dir = tmp();
		let clock = 1_000;
		const recording = new RunTrace({ dir, agentId: "a", role: "r", now: () => clock }).open(info);
		recording.event({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "false" } });
		clock += 250;
		recording.event({ type: "tool_execution_end", toolCallId: "t1", toolName: "bash", entry: { model: [{ role: "toolResult", isError: true, content: [{ type: "text", text: "exit 1" }] }] } });
		const end = linesOf(dir).find((record) => record.type === "tool_end");
		assert.deepEqual([end.isError, end.ms, end.output[0].text], [true, 250, "exit 1"]);
	});

	it("never fails the run: a directory that cannot be written is reported once and the recording is a no-op", () => {
		const dir = tmp();
		const blocked = join(dir, "blocked");
		writeFileSync(blocked, "a file where the directory should be");
		const warnings: string[] = [];
		const trace = new RunTrace({ dir: blocked, agentId: "a", role: "r", log: (_level, event) => warnings.push(event) });
		for (const run of [1, 2]) {
			const recording = trace.open({ ...info, requestId: `job-${run}` });
			recording.event({ type: "message_end", entry: { id: 1, model: [{ role: "user", content: "x" }] } });
			recording.end({ status: "done" });
		}
		assert.deepEqual(warnings, ["run_trace_failed"]);
	});

	it("removes days past the limit, and the oldest days when the total is too big, but never today", () => {
		const dir = tmp();
		for (const [day, bytes] of [["2020-01-01", 10], ["2026-10-09", 600], ["2026-10-10", 600]] as const) {
			mkdirSync(join(dir, day));
			writeFileSync(join(dir, day, "r.jsonl"), "x".repeat(bytes));
		}
		const now = Date.parse("2026-10-12T10:00:00Z");
		new RunTrace({ dir, agentId: "a", role: "r", keepDays: 30, maxTotalBytes: 1000, now: () => now }).open(info);
		assert.deepEqual(readdirSync(dir).sort(), ["2026-10-10", "2026-10-12"]);
		assert.ok(existsSync(join(dir, "2026-10-12")));
		assert.ok(statSync(join(dir, "2026-10-12")).isDirectory());
	});
	it("files what ties a run to the rest, takes notes about it while it goes and after it ended, and indexes the run for recall", () => {
		const dir = tmp();
		let clock = Date.parse("2026-10-12T10:00:00Z");
		const trace = new RunTrace({ dir, agentId: "agent/me", role: "r", now: () => clock });
		const recording = trace.open({ ...info, requestId: "thread:m1", meta: { kind: "chat", conversationId: "c1", messageId: "m1", by: "user/jimmy (human)", asked: "x".repeat(500), labels: { a: "b" } } });
		recording.event({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: {} });
		recording.event({ type: "tool_execution_end", toolCallId: "t1", toolName: "bash", entry: { model: [{ role: "toolResult", isError: true, content: [{ type: "text", text: "no" }] }] } });
		trace.note("thread:m1", "job_started", { jobId: "job-1", label: "verify" });
		clock += 2_000;
		recording.end({ status: "done", answer: "a".repeat(500), usage: { totalTokens: 12, costUsd: 0.5 } });
		trace.note("thread:m1", "sent", { messageId: "out1", conversationId: "c1", via: "reply" });
		trace.note("thread:unknown", "sent", { messageId: "ignored" });
		const records = linesOf(dir);
		assert.deepEqual(records.map((record) => record.type), ["run_start", "tool_start", "tool_end", "job_started", "run_end", "sent"]);
		assert.deepEqual(records[0].meta.labels, { a: "b" });
		const day = readdirSync(dir)[0]!;
		const index = readFileSync(join(dir, day, INDEX_FILE), "utf8").trim().split("\n").map((line) => JSON.parse(line));
		assert.deepEqual(index.map((line) => line.t), ["start", "job_started", "end", "sent"]);
		assert.deepEqual([index[0].kind, index[0].conversationId, index[0].messageId, index[0].by], ["chat", "c1", "m1", "user/jimmy (human)"]);
		assert.equal(index[0].asked.length, 300);
		assert.deepEqual([index[2].status, index[2].ms, index[2].steps, index[2].tools, index[2].toolErrors, index[2].tokens, index[2].costUsd], ["done", 2000, 0, { bash: 1 }, 1, 12, 0.5]);
		assert.equal(index[2].answer.length, 300);
		assert.ok(index.every((line) => line.runId === "thread:m1" && line.file === index[0].file));
	});

	it("cleans secrets out of the index too", () => {
		const dir = tmp();
		const recording = new RunTrace({ dir, agentId: "a", role: "r" }).open({ ...info, meta: { kind: "job", asked: "push with ghp_abcdefghijklmnop1234" } });
		recording.end({ status: "done", answer: "used ghp_abcdefghijklmnop1234" });
		const day = readdirSync(dir)[0]!;
		const text = readFileSync(join(dir, day, INDEX_FILE), "utf8");
		assert.doesNotMatch(text, /ghp_abcdefghijklmnop1234/);
	});
});

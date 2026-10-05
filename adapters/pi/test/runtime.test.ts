import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { sleep } from "@somework/sdk";
import { PiDurableRuntime, type ApprovalPolicy } from "../src/pi-runtime.ts";
import type { AgentRequest, RunHooks } from "../src/runtime.ts";
import { scriptedModels } from "../src/fake-model.ts";

const open: PiDurableRuntime[] = [];
afterEach(async () => {
	for (const runtime of open.splice(0)) await runtime.close();
});

async function runtimeFor(plan: string[], policy?: ApprovalPolicy) {
	const dir = mkdtempSync(join(tmpdir(), "pi-runtime-"));
	const fake = scriptedModels(plan);
	const runtime = new PiDurableRuntime({ storagePath: join(dir, "state.sqlite"), models: fake.models, model: fake.model, env: (cwd) => new NodeExecutionEnv({ cwd: cwd ?? dir }), policy });
	await runtime.start();
	open.push(runtime);
	const workspace = (name: string) => {
		const path = join(dir, name);
		mkdirSync(path, { recursive: true });
		return path;
	};
	return { runtime, dir, workspace, fake };
}

const request = (workspace: string, over: Partial<AgentRequest> = {}): AgentRequest => ({
	requestId: "job-1",
	agentKey: "repo#1",
	instruction: "do the work",
	workspace,
	budget: { maxTokens: 1_000_000, maxMinutes: 5 },
	...over,
});

const hooks = (over: Partial<RunHooks> = {}) => {
	const progress: string[] = [];
	const abort = new AbortController();
	const value: RunHooks = {
		signal: abort.signal,
		onProgress: (update) => progress.push(update.message ?? ""),
		requestApproval: async () => ({ approved: true }),
		...over,
	};
	return { hooks: value, progress, abort };
};

describe("PiDurableRuntime", () => {
	it("runs the model with real coding tools, reports progress and usage, and returns the answer", async () => {
		const { runtime, workspace } = await runtimeFor(["write:out.txt:hello", "bash:cat out.txt", "final:all done"]);
		const ws = workspace("w1");
		const { hooks: h, progress } = hooks();
		const outcome = await runtime.execute(request(ws), h);
		assert.equal(outcome.status, "done");
		assert.equal(outcome.status === "done" && outcome.answer, "all done");
		assert.equal(readFileSync(join(ws, "out.txt"), "utf8"), "hello");
		assert.ok(outcome.status === "done" && outcome.usage.totalTokens > 0);
		assert.ok(progress.includes("tool: write") && progress.includes("tool: bash"), `progress: ${progress}`);
	});

	it("a repeated requestId returns the original run instead of running again", async () => {
		const { runtime, workspace, fake } = await runtimeFor(["bash:echo once", "final:done"]);
		const ws = workspace("w1");
		const first = await runtime.execute(request(ws), hooks().hooks);
		const callsAfterFirst = fake.faux.state.callCount;
		const second = await runtime.execute(request(ws), hooks().hooks);
		assert.equal(first.status, "done");
		assert.equal(second.status, "done");
		assert.equal(fake.faux.state.callCount, callsAfterFirst, "the model was not called again");
	});

	it("a requester cancel aborts a running tool promptly", async () => {
		const { runtime, workspace } = await runtimeFor(["bash:sleep 30", "final:done"]);
		const { hooks: h, abort } = hooks();
		const started = Date.now();
		const running = runtime.execute(request(workspace("w1")), h);
		await sleep(1500);
		abort.abort("cancel_requested");
		const outcome = await running;
		assert.equal(outcome.status, "aborted");
		assert.equal(outcome.status === "aborted" && outcome.reason, "cancel_requested");
		assert.ok(Date.now() - started < 10_000, "abort did not wait for the 30 s sleep");
	});

	it("stops a job that exceeds its token budget", async () => {
		const { runtime, workspace } = await runtimeFor(["bash:echo step", "bash:echo step", "bash:echo step", "bash:echo step", "final:done"]);
		const outcome = await runtime.execute(request(workspace("w1"), { budget: { maxTokens: 150, maxMinutes: 5 } }), hooks().hooks);
		assert.equal(outcome.status, "aborted");
		assert.equal(outcome.status === "aborted" && outcome.reason, "budget_exceeded");
	});

	it("detaches on shutdown and lease loss without aborting the run", async () => {
		const { runtime, workspace } = await runtimeFor(["bash:sleep 2", "final:finished anyway"]);
		const ws = workspace("w1");
		const { hooks: h, abort } = hooks();
		const running = runtime.execute(request(ws), h);
		await sleep(700);
		abort.abort("shutdown");
		assert.equal((await running).status, "detached");
		// the run was not aborted: a retry with the same requestId re-attaches and gets the finished answer
		const again = await runtime.execute(request(ws), hooks().hooks);
		assert.equal(again.status, "done");
		assert.equal(again.status === "done" && again.answer, "finished anyway");
	});

	it("keeps one conversation per agent key: parallel across keys, serial within one", async () => {
		const { runtime, workspace } = await runtimeFor(["bash:sleep 1.5", "final:ok"]);
		const [a, b] = [workspace("a"), workspace("b")];
		let t = Date.now();
		await Promise.all([runtime.execute(request(a, { requestId: "a1", agentKey: "k-a" }), hooks().hooks), runtime.execute(request(b, { requestId: "b1", agentKey: "k-b" }), hooks().hooks)]);
		assert.ok(Date.now() - t < 3500, `two keys ran in parallel (${Date.now() - t} ms)`);
		t = Date.now();
		await Promise.all([runtime.execute(request(a, { requestId: "a2", agentKey: "k-a" }), hooks().hooks), runtime.execute(request(a, { requestId: "a3", agentKey: "k-a" }), hooks().hooks)]);
		assert.ok(Date.now() - t >= 2800, `one key ran serially (${Date.now() - t} ms)`);
	});

	it("asks the requester before a risky call, and the model sees a denial", async () => {
		const policy: ApprovalPolicy = { needsApproval: (tool, args) => (tool === "bash" && String(args.command).includes("rm -rf") ? "delete files" : undefined) };
		const { runtime, workspace } = await runtimeFor(["bash:rm -rf ./victim", "final:done"], policy);
		const ws = workspace("w1");
		mkdirSync(join(ws, "victim"));
		const asked: string[] = [];
		const { hooks: h } = hooks({
			requestApproval: async (r) => {
				asked.push(`${r.tool}: ${r.summary}`);
				return { approved: false, reason: "not now" };
			},
		});
		const outcome = await runtime.execute(request(ws), h);
		assert.equal(outcome.status, "done");
		assert.deepEqual(asked, ["bash: delete files"]);
		assert.ok(existsSync(join(ws, "victim")), "the denied command did not run");
	});

	it("a job may start its conversation on another model, which then keeps its own conversation for the same key", async () => {
		const { runtime, workspace, fake } = await runtimeFor(["final:from the default model"]);
		const other = fauxProvider({ provider: "other", models: [{ id: "other-model" }] });
		other.setResponses(Array.from({ length: 10 }, () => fauxAssistantMessage([fauxText("from the other model")])));
		(fake.models as any).setProvider(other.provider);
		const ws = workspace("w1");

		const chosen = await runtime.execute(request(ws, { requestId: "job-other", model: { provider: "other", modelId: "other-model" } }), hooks().hooks);
		assert.equal(chosen.status === "done" && chosen.answer, "from the other model");
		assert.equal(fake.faux.state.callCount, 0, "the default model was not used");

		const defaulted = await runtime.execute(request(ws, { requestId: "job-default" }), hooks().hooks);
		assert.equal(defaulted.status === "done" && defaulted.answer, "from the default model");

		const again = await runtime.execute(request(ws, { requestId: "job-other-2", model: { provider: "other", modelId: "other-model" } }), hooks().hooks);
		assert.equal(again.status === "done" && again.answer, "from the other model");
	});
});

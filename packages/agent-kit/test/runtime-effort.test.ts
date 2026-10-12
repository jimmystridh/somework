import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { createHandler } from "../src/handler.ts";
import { PiDurableRuntime } from "../src/pi-runtime.ts";
import type { ModelRef } from "../src/providers/allowlist.ts";
import { emptyUsage, type AgentRequest, type AgentRuntime, type RunHooks } from "../src/runtime.ts";
import type { Job, JobControl } from "../src/job-types.ts";
import { FakeHost, makeRemote } from "../src/testing.ts";

const open: PiDurableRuntime[] = [];
afterEach(async () => {
	for (const runtime of open.splice(0)) await runtime.close();
});

const hooks = (): RunHooks => ({ signal: new AbortController().signal, onProgress: () => undefined, requestApproval: async () => ({ approved: true }) });

/** A provider with a reasoning model and one without; every request is recorded with the reasoning level the runtime asked for. */
async function rig(defaultModel: ModelRef = { provider: "faux", modelId: "thinker" }) {
	const dir = mkdtempSync(join(tmpdir(), "kit-effort-"));
	const seen: { model: string; reasoning: unknown }[] = [];
	const faux = fauxProvider({ provider: "faux", models: [{ id: "thinker", reasoning: true }, { id: "plain", reasoning: false }] });
	faux.setResponses(Array.from({ length: 50 }, () => (_context: unknown, options: any, _state: unknown, model: any) => {
		seen.push({ model: model.id, reasoning: options?.reasoning });
		return fauxAssistantMessage([fauxText("done")]);
	}));
	const models = createModels();
	models.setProvider(faux.provider);
	const runtime = new PiDurableRuntime({ storagePath: join(dir, "state.sqlite"), models, model: defaultModel, env: (cwd) => new NodeExecutionEnv({ cwd: cwd ?? dir }) });
	await runtime.start();
	open.push(runtime);
	const workspace = join(dir, "w");
	mkdirSync(workspace, { recursive: true });
	let counter = 0;
	const run = async (key: string, over: Partial<AgentRequest> = {}) => {
		counter += 1;
		const before = seen.length;
		const outcome = await runtime.execute({ requestId: `r-${counter}`, agentKey: key, instruction: "go", workspace, budget: { maxTokens: 1_000_000, maxMinutes: 5 }, ...over }, hooks());
		assert.equal(outcome.status, "done");
		return seen.slice(before).map((entry) => entry.reasoning);
	};
	return { runtime, run, seen };
}

describe("the effort of a run", () => {
	it("passes nothing when no effort is set anywhere, as before", async () => {
		const { run } = await rig();
		assert.deepEqual(await run("job-1"), [undefined]);
	});

	it("runs a conversation at the configured effort", async () => {
		const { run } = await rig({ provider: "faux", modelId: "thinker", effort: "high" });
		assert.deepEqual(await run("job-1"), ["high"]);
	});

	it("applies a changed effort from the next run, also in a conversation that already exists", async () => {
		const { runtime, run } = await rig();
		assert.deepEqual(await run("chat-1"), [undefined]);
		runtime.setModel({ provider: "faux", modelId: "thinker", effort: "medium" });
		assert.deepEqual(await run("chat-1"), ["medium"], "the conversation of an earlier run follows the new effort");
		runtime.setModel({ provider: "faux", modelId: "thinker", effort: "low" });
		assert.deepEqual(await run("chat-1"), ["low"]);
		assert.deepEqual(await run("job-new"), ["low"], "a new conversation starts with it");
		runtime.setModel(undefined);
		assert.deepEqual(await run("chat-1"), [undefined], "back to the configured model: no effort is passed again");
	});

	it("gives a request's own model its own effort, and a request without one none", async () => {
		const { run } = await rig({ provider: "faux", modelId: "thinker", effort: "high" });
		assert.deepEqual(await run("job-1", { model: { provider: "faux", modelId: "thinker", effort: "minimal" } }), ["minimal"]);
		assert.deepEqual(await run("job-1", { model: { provider: "faux", modelId: "thinker" } }), [undefined], "a request that carries a complete model with no effort asks for none");
		assert.deepEqual(await run("job-1"), ["high"]);
	});

	it("applies the effort off as a level of its own: nothing is asked of the provider", async () => {
		const { runtime, run } = await rig({ provider: "faux", modelId: "thinker", effort: "high" });
		assert.deepEqual(await run("chat-1"), ["high"]);
		runtime.setModel({ provider: "faux", modelId: "thinker", effort: "off" });
		assert.deepEqual(await run("chat-1"), [undefined]);
	});

	it("refuses an effort the model does not take, and keeps the one it had", async () => {
		const { runtime, run } = await rig({ provider: "faux", modelId: "thinker", effort: "low" });
		assert.throws(() => runtime.setModel({ provider: "faux", modelId: "plain", effort: "high" }), /plain does not support the effort high/);
		assert.throws(() => runtime.setModel({ provider: "faux", modelId: "thinker", effort: "max" }), /thinker does not support the effort max/);
		assert.deepEqual(runtime.model, { provider: "faux", modelId: "thinker", effort: "low" });
		assert.deepEqual(await run("chat-1"), ["low"]);
	});
});

describe("a job's own model request", () => {
	function handlerFor(resolveModel?: (request: any) => any) {
		const requests: AgentRequest[] = [];
		const { remote } = makeRemote();
		const workspaceRoot = join(mkdtempSync(join(tmpdir(), "kit-effort-job-")), "workspaces");
		const runtime: AgentRuntime = {
			start: async () => {},
			health: () => ({ ready: true }),
			close: async () => {},
			execute: async (request) => {
				requests.push(request);
				return { status: "done", answer: "nothing to change", usage: emptyUsage() };
			},
		};
		const handler = createHandler({
			runtime,
			session: { env: new NodeExecutionEnv({ cwd: workspaceRoot }), identity: { name: "Pi", email: "pi@test.invalid" } },
			host: new FakeHost(),
			workspaceRoot,
			client: {} as never,
			limits: { maxTokensCap: 100_000, maxMinutesCap: 10 },
			allowedModels: [{ provider: "faux", modelId: "thinker" }, { provider: "faux", modelId: "plain" }],
			...(resolveModel ? { resolveModel } : {}),
		});
		const run = (model: unknown) =>
			handler(
				{ taskId: "task_1", task: {}, input: { repository: { url: remote, ref: "main" }, instruction: "x", budget: { maxTokens: 5000, maxMinutes: 1 }, ...(model === undefined ? {} : { model }) } } as unknown as Job,
				{ signal: new AbortController().signal } as unknown as JobControl,
			);
		return { requests, run };
	}
	const code = (outcome: any) => outcome.failure?.code;

	it("may carry an effort with the model, and hands the runtime what the agent's settings resolve it to", async () => {
		const resolved: unknown[] = [];
		const { requests, run } = handlerFor((request) => {
			resolved.push(request);
			return { ok: true, model: { provider: "faux", modelId: "thinker", effort: request.effort ?? "high" }, sources: { provider: "env", modelId: "env", effort: "job" } };
		});
		await run({ provider: "faux", id: "thinker", effort: "low" });
		await run({ effort: "medium" });
		await run(undefined);
		assert.deepEqual(resolved, [{ provider: "faux", modelId: "thinker", effort: "low" }, { effort: "medium" }]);
		assert.deepEqual(requests.map((request) => request.model), [{ provider: "faux", modelId: "thinker", effort: "low" }, { provider: "faux", modelId: "thinker", effort: "medium" }, undefined]);
	});

	it("refuses an unknown effort, a provider without a model id, and a model the agent does not allow", async () => {
		const { requests, run } = handlerFor((request) => ({ ok: true, model: { provider: "faux", modelId: "thinker", ...request }, sources: { provider: "env", modelId: "env" } }));
		assert.equal(code(await run({ effort: "extreme" })), "invalid_input");
		assert.equal(code(await run({ provider: "faux", effort: "low" })), "invalid_input");
		assert.equal(code(await run({ id: "thinker" })), "invalid_input");
		assert.equal(code(await run({})), "invalid_input");
		assert.equal(code(await run({ provider: "faux", id: "ghost", effort: "low" })), "model_not_allowed");
		assert.equal(requests.length, 0);
	});

	it("fails the job with the agent's own reason when the effort does not fit the model", async () => {
		const { requests, run } = handlerFor(() => ({ ok: false, reason: "the model faux/plain does not support the effort high (it supports off)" }));
		const outcome: any = await run({ provider: "faux", id: "plain", effort: "high" });
		assert.equal(code(outcome), "invalid_input");
		assert.match(outcome.failure.message, /does not support the effort high/);
		assert.equal(requests.length, 0);
	});

	it("serves a request with provider, id and effort even when the service has no model settings, and refuses an effort alone then", async () => {
		const { requests, run } = handlerFor();
		await run({ provider: "faux", id: "thinker", effort: "low" });
		assert.deepEqual(requests[0]!.model, { provider: "faux", modelId: "thinker", effort: "low" });
		assert.equal(code(await run({ effort: "low" })), "invalid_input");
	});
});

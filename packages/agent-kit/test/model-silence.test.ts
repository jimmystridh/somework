import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { DEFAULT_MODEL_SILENCE_MS, PiDurableRuntime } from "../src/pi-runtime.ts";
import { scriptedModels } from "../src/providers/faux.ts";

const open: PiDurableRuntime[] = [];
afterEach(async () => {
	for (const runtime of open.splice(0)) await runtime.close();
});

async function timeoutsSeenBy(modelSilenceMs: number | undefined): Promise<unknown[]> {
	const dir = mkdtempSync(join(tmpdir(), "model-silence-"));
	const fake = scriptedModels(["final:done"]);
	const seen: unknown[] = [];
	const original = fake.models.streamSimple.bind(fake.models);
	(fake.models as any).streamSimple = (model: any, context: any, options: any) => {
		seen.push(options?.timeoutMs);
		return original(model, context, options);
	};
	const runtime = new PiDurableRuntime({ storagePath: join(dir, "s.sqlite"), models: fake.models, model: fake.model, env: (cwd) => new NodeExecutionEnv({ cwd: cwd ?? dir }), modelSilenceMs });
	await runtime.start();
	open.push(runtime);
	const workspace = join(dir, "w");
	mkdirSync(workspace);
	const outcome = await runtime.execute({ requestId: "job-1", agentKey: "k", instruction: "go", workspace, budget: { maxTokens: 1_000_000, maxMinutes: 5 }, context: {}, meta: { kind: "job", jobId: "j-1", conversationId: "c1" } }, { signal: new AbortController().signal, onProgress: () => undefined, requestApproval: async () => ({ approved: true }) });
	assert.equal(outcome.status, "done");
	return seen;
}

describe("a model request that goes silent", () => {
	it("is given a deadline, so a connection the network dropped cannot hang the run for good", async () => {
		const seen = await timeoutsSeenBy(undefined);
		assert.ok(seen.length > 0, "the model was called");
		assert.ok(seen.every((timeout) => timeout === DEFAULT_MODEL_SILENCE_MS));
	});

	it("takes the deadline from the runtime's options when one is set", async () => {
		const seen = await timeoutsSeenBy(90_000);
		assert.ok(seen.every((timeout) => timeout === 90_000));
	});
});

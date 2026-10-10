import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { approvalPolicy, createHandler, Metrics, PiDurableRuntime } from "@somework/agent-kit";
import { scriptedModels } from "@somework/agent-kit/providers/faux";
import { jobRig, FakeHost, makeRemote } from "@somework/agent-kit/testing";
import { developerChat } from "../src/chat.ts";
import { profile } from "../src/profile.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("a change run as a job, in a domain that has no task for it", () => {
	it("opens the pull request and uploads the patch, which the result message carries", async () => {
		const { remote } = makeRemote();
		const dir = mkdtempSync(join(tmpdir(), "pi-chat-job-"));
		const workspaceRoot = join(dir, "workspaces");
		const env = (cwd: string | undefined) => new NodeExecutionEnv({ cwd: cwd ?? workspaceRoot });
		const fake = scriptedModels(["write:feature.txt:hello chat", "final:added feature.txt"]);
		const runtime = new PiDurableRuntime({ storagePath: join(dir, "pi.sqlite"), models: fake.models, model: fake.model, env, policy: approvalPolicy() });
		await runtime.start();
		cleanups.push(() => runtime.close());
		const chat = jobRig({ stateDir: dir });
		const host = new FakeHost();
		const handler = createHandler({ runtime, session: { env: env(workspaceRoot), identity: { name: "Pi", email: "pi@test.invalid" } }, host, workspaceRoot, client: chat.client, limits: { maxTokensCap: 5_000_000, maxMinutesCap: 60 }, metrics: new Metrics(), profile, source: "job" });
		const hooks = developerChat({ CHAT_REPOSITORY_URL: "https://example.test/o/r", CHAT_REPOSITORY_REF: "main" } as NodeJS.ProcessEnv);
		const planned = (await hooks.jobTools![0]!.plan({ instruction: "add feature.txt" })) as { capability: any; input: any; label: string };
		const run = await chat.run(handler, { capability: planned.capability, input: { ...planned.input, repository: { url: remote, ref: "main" } }, label: planned.label }, hooks.describeResult);
		assert.equal(run.entry.end?.kind, "completed");
		assert.match(run.text, /^change: add feature\.txt \(job-[a-z0-9-]+\): done \(completed\)\./);
		assert.match(run.text, /Branch: agent\/job-/);
		assert.ok(chat.domain.uploaded.some((name) => name.endsWith(".diff")), "the patch went to the domain");
		assert.ok(run.artifacts.length >= 1, "the result message carries it");
		assert.ok(!chat.domain.calls.some((call) => /tasks\/job-|for job-/.test(call)), chat.domain.calls.join(", "));
		assert.equal(host.created.length, 1);
	});
});

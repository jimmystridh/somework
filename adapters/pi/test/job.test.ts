import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { approvalPolicy, createHandler, Metrics, PiDurableRuntime } from "@somework/agent-kit";
import { scriptedModels } from "@somework/agent-kit/providers/faux";
import { chatInstructionRig, FakeHost, makeRemote } from "@somework/agent-kit/testing";
import { developerChat } from "../src/chat.ts";
import { profile } from "../src/profile.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("a change given as an instruction in chat, in a domain that has no task for it", () => {
	it("opens the pull request and shows the patch in the reply; the patch is never uploaded", async () => {
		const { remote } = makeRemote();
		const dir = mkdtempSync(join(tmpdir(), "pi-chat-job-"));
		const workspaceRoot = join(dir, "workspaces");
		const env = (cwd: string | undefined) => new NodeExecutionEnv({ cwd: cwd ?? workspaceRoot });
		const fake = scriptedModels(["write:feature.txt:hello chat", "final:added feature.txt"]);
		const runtime = new PiDurableRuntime({ storagePath: join(dir, "pi.sqlite"), models: fake.models, model: fake.model, env, policy: approvalPolicy() });
		await runtime.start();
		cleanups.push(() => runtime.close());
		const chat = chatInstructionRig({ stateDir: dir });
		const host = new FakeHost();
		const handler = createHandler({ runtime, session: { env: env(workspaceRoot), identity: { name: "Pi", email: "pi@test.invalid" } }, host, workspaceRoot, client: chat.client, limits: { maxTokensCap: 5_000_000, maxMinutesCap: 60 }, metrics: new Metrics(), profile, source: "chat" });
		const hooks = developerChat({ CHAT_REPOSITORY_URL: "https://example.test/o/r", CHAT_REPOSITORY_REF: "main" } as NodeJS.ProcessEnv);
		const planned = (text: string) => {
			const result = hooks.instructInput!(text) as { capability: any; input: any };
			return "refuse" in result ? result : { ...result, input: { ...result.input, repository: { url: remote, ref: "main" } } };
		};
		const reply = await chat.responderFor(handler, planned as never).instruct("add feature.txt");
		assert.match(reply, /^Done \(completed\)/);
		assert.match(reply, /Branch: agent\/chat-m1/);
		assert.match(reply, /chat-m1\.diff \(text\/x-diff/);
		assert.match(reply, /\+hello chat/);
		assert.deepEqual(chat.domain.calls, []);
		assert.equal(host.created.length, 1);
	});
});

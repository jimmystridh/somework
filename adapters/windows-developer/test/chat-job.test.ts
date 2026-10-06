import assert from "node:assert/strict";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { approvalPolicy, createHandler, Metrics, PiDurableRuntime } from "@somework/agent-kit";
import { scriptedModels } from "@somework/agent-kit/providers/faux";
import { chatInstructionRig, FakeHost, makeRemote } from "@somework/agent-kit/testing";
import { localEnvFactory } from "@somework/agent-kit/windows";
import { windowsDeveloperChat } from "../src/chat.ts";
import { profile } from "../src/profile.ts";
import { parseProfiles } from "../src/profiles.ts";
import { createRole } from "../src/role.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const PROFILES = {
	build: { ok: { command: "echo compiling && test -f feature.txt && echo built-with-feature", timeoutMinutes: 2 } },
	test: { unit: { command: "echo tests-passed && test -f feature.txt", timeoutMinutes: 2 } },
	encoding: { legacyGlobs: ["**/*.cpp"], blockPush: true },
};

describe("a Windows change given as an instruction in chat, in a domain that has no task for it", () => {
	it("builds, tests and pushes: the patch and both logs are kept on the host and shown in the reply, and no task-bound call is made", async () => {
		const { remote } = makeRemote();
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "windev-chat-")));
		const root = join(dir, "workspaces");
		const fake = scriptedModels(["write:feature.txt:new feature", "final:added feature.txt"]);
		const envFor = localEnvFactory({ root, baseEnv: { PATH: process.env.PATH ?? "", HOME: root }, flavour: "posix" });
		const runtime = new PiDurableRuntime({ storagePath: join(dir, "pi.sqlite"), models: fake.models, model: fake.model, env: envFor, policy: approvalPolicy([], profile.approvalPatterns) });
		await runtime.start();
		cleanups.push(() => runtime.close());
		const chat = chatInstructionRig({ stateDir: dir });
		const role = createRole({ profiles: parseProfiles(PROFILES) });
		const host = new FakeHost();
		const handler = createHandler({ runtime, envFor, session: { env: envFor(root), identity: { name: "Win", email: "win@test.invalid" } }, host, workspaceRoot: root, client: chat.client, limits: { maxTokensCap: 5_000_000, maxMinutesCap: 60 }, metrics: new Metrics(), profile, hooks: role.hooks, source: "chat" });
		const hooks = windowsDeveloperChat({ CHAT_REPOSITORY_URL: "https://example.test/o/r", CHAT_REPOSITORY_REF: "main" } as NodeJS.ProcessEnv);
		const planned = (text: string) => {
			const result = hooks.instructInput!(text) as { capability: any; input: any };
			return "refuse" in result ? result : { ...result, input: { ...result.input, repository: { url: remote, ref: "main" } } };
		};
		const reply = await chat.responderFor(handler, planned as never).instruct("build: ok\ntests: unit\nadd a feature");
		assert.match(reply, /^Done \(completed\)/);
		assert.match(reply, /Branch: agent\/chat-m1/);
		assert.match(reply, /Attachments were not uploaded to the domain/);
		assert.match(reply, /chat-m1\.diff/);
		assert.match(reply, /built-with-feature/);
		assert.match(reply, /tests-passed/);
		assert.equal(host.created.length, 1, "the pull request was still opened");
		assert.deepEqual(chat.domain.calls, []);
		assert.ok(Buffer.byteLength(reply) <= 4096);
	});
});

import assert from "node:assert/strict";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { approvalPolicy, createHandler, Metrics, PiDurableRuntime } from "@somework/agent-kit";
import { scriptedModels } from "@somework/agent-kit/providers/faux";
import { jobRig, FakeHost, makeRemote } from "@somework/agent-kit/testing";
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

describe("a Windows change run as a job, in a domain that has no task for it", () => {
	it("builds, tests and pushes: the patch and both logs are uploaded and carried by the result, and no task-bound call is made", async () => {
		const { remote } = makeRemote();
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "windev-chat-")));
		const root = join(dir, "workspaces");
		const fake = scriptedModels(["write:feature.txt:new feature", "final:added feature.txt"]);
		const envFor = localEnvFactory({ root, baseEnv: { PATH: process.env.PATH ?? "", HOME: root }, flavour: "posix" });
		const runtime = new PiDurableRuntime({ storagePath: join(dir, "pi.sqlite"), models: fake.models, model: fake.model, env: envFor, policy: approvalPolicy([], profile.approvalPatterns) });
		await runtime.start();
		cleanups.push(() => runtime.close());
		const chat = jobRig({ stateDir: dir });
		const role = createRole({ profiles: parseProfiles(PROFILES) });
		const host = new FakeHost();
		const handler = createHandler({ runtime, envFor, session: { env: envFor(root), identity: { name: "Win", email: "win@test.invalid" } }, host, workspaceRoot: root, client: chat.client, limits: { maxTokensCap: 5_000_000, maxMinutesCap: 60 }, metrics: new Metrics(), profile, hooks: role.hooks, source: "job" });
		const hooks = windowsDeveloperChat({ CHAT_REPOSITORY_URL: "https://example.test/o/r", CHAT_REPOSITORY_REF: "main" } as NodeJS.ProcessEnv);
		const planned = (await hooks.jobTools![0]!.plan({ build: "ok", tests: ["unit"], instruction: "add a feature" })) as { capability: any; input: any; label: string };
		const run = await chat.run(handler, { capability: planned.capability, input: { ...planned.input, repository: { url: remote, ref: "main" } }, label: planned.label }, hooks.describeResult);
		assert.equal(run.entry.end?.kind, "completed");
		assert.match(run.text, /^change: add a feature \(job-[a-z0-9-]+\): done \(completed\)/);
		assert.match(run.text, /Branch: agent\/job-/);
		assert.ok(chat.domain.uploaded.some((name) => name.endsWith(".diff")), "the patch went to the domain");
		assert.ok(chat.domain.uploaded.length >= 3, `the patch and both logs: ${chat.domain.uploaded.join(", ")}`);
		assert.equal(new Set(run.artifacts.map((ref: any) => ref.artifactId)).size, chat.domain.uploaded.length, "the result message carries all of them");
		assert.equal(host.created.length, 1, "the pull request was still opened");
		assert.ok(!chat.domain.calls.some((call) => /tasks\/job-|for job-/.test(call)), chat.domain.calls.join(", "));
		assert.ok(Buffer.byteLength(run.text) <= 4096);
	});
});

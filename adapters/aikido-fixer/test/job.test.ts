import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { approvalPolicy, createHandler, Metrics, PiDurableRuntime } from "@somework/agent-kit";
import { scriptedModels } from "@somework/agent-kit/providers/faux";
import { FakeHost, jobRig, makeRemote } from "@somework/agent-kit/testing";
import { fixerChat } from "../src/chat.ts";
import { createFixerHooks } from "../src/hooks.ts";
import { FIXER_APPROVAL_PATTERNS, profile } from "../src/profile.ts";
import { loadSettings } from "../src/settings.ts";

const REPO = "https://example.test/Acme/Shop.git";
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const saved: Record<string, string | undefined> = {};
before(() => {
	const { remote } = makeRemote();
	for (const [name, value] of Object.entries({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `url.${remote}.insteadOf`, GIT_CONFIG_VALUE_0: REPO })) {
		saved[name] = process.env[name];
		process.env[name] = value;
	}
});
after(() => {
	for (const [name, value] of Object.entries(saved)) value === undefined ? delete process.env[name] : (process.env[name] = value);
});

const group = { id: 12, title: "Prototype pollution in lodash", type: "open_source", severity: "high", group_status: "new", how_to_fix: "Upgrade lodash to 4.17.21" };
const issue = { id: 99, group_id: 12, status: "open", affected_package: "lodash", installed_version: "4.17.20", patched_versions: ["4.17.21"], code_repo_name: "Acme/Shop" };

describe("a fix run as a job, in a domain that has no task for it", () => {
	it("opens the pull request, uploads the patch, records the outcome and makes no task-bound call", async () => {
		const dir = mkdtempSync(join(tmpdir(), "aikido-chat-job-"));
		const workspaceRoot = join(dir, "workspaces");
		const envFor = (cwd?: string) => new NodeExecutionEnv({ cwd: cwd ?? workspaceRoot });
		const settings = loadSettings({ AIKIDO_REPOSITORY_URL: REPO });
		const aikido = { resolveIssue: async () => ({ group, issue }) } as any;
		const hooks = createFixerHooks({ settings, stateDir: dir, aikido });
		const fake = scriptedModels(["write:fix.txt:patched", "final:FIXED: bump lodash"]);
		const runtime = new PiDurableRuntime({ storagePath: join(dir, "pi.sqlite"), models: fake.models, model: fake.model, env: envFor, policy: approvalPolicy([], FIXER_APPROVAL_PATTERNS, profile.toolApprovals), allowedTools: profile.allowedTools, extensions: hooks.extensions });
		await runtime.start();
		cleanups.push(() => runtime.close());
		const chat = jobRig({ stateDir: dir });
		const host = new FakeHost();
		const handler = createHandler({ runtime: hooks.wrapRuntime!(runtime), envFor, session: { env: envFor(), identity: { name: "Fixer", email: "fixer@test.invalid" }, mirrorDir: join(workspaceRoot, ".mirrors") }, host, workspaceRoot, client: chat.client, limits: { maxTokensCap: 5_000_000, maxMinutesCap: 60 }, metrics: new Metrics(), profile, hooks, source: "job" });
		const roleChat = fixerChat({ settings, aikido, stateDir: dir });
		const [fix] = roleChat.jobTools!;
		const plan = (await fix!.plan({ issue: "12" })) as { capability: any; input: any; label: string };
		const run = await chat.run(handler, plan, roleChat.describeResult);
		assert.equal(run.entry.end?.kind, "completed");
		assert.match(run.text, /^fix Aikido issue 12 \(job-[a-z0-9-]+\): done \(pr_opened\)/);
		assert.match(run.text, /Pull request: https:\/\/example.test\/pr\/agent\/aikido-12-/);
		assert.ok(chat.domain.uploaded.some((name) => name.endsWith(".diff")), "the patch went to the domain");
		assert.ok(run.artifacts.length >= 1, "the result message carries it");
		assert.ok(!chat.domain.calls.some((call) => /tasks\/job-|for job-/.test(call)), `no call is bound to the job's task: ${chat.domain.calls.join(", ")}`);
		assert.equal(host.created.length, 1);
		assert.match(await roleChat.context!(), /- issue 12: pr_opened at \S+, branch agent\/aikido-12-\w+, https:\/\/example.test\/pr\//, "the outcome is in the host ledger the chat reports from");
	});
});

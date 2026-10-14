import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { approvalPolicy, createHandler, Metrics, PiDurableRuntime } from "@somework/agent-kit";
import { scriptedModels } from "@somework/agent-kit/providers/faux";
import { FakeHost, jobRig, makeRemote, runHandler, sh } from "@somework/agent-kit/testing";
import { CAPABILITY, clusterChangeTool } from "../src/chat.ts";
import { createClusterHooks } from "../src/hooks.ts";
import { profile } from "../src/profile.ts";
import { fakeSpawn, settingsFor } from "./support.ts";

// the profile's approval functions read the settings of the process, as the service does
Object.assign(process.env, { CLUSTER_DEV_HOSTS: "agents=js@10.10.10.20", CLUSTER_DEV_SSH_KEY_DIR: "/keys", CLUSTER_DEV_ASK_IN_SANDBOX: "1", CLUSTER_DEV_CONFIRM: "1" });

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** The role's hooks and policy in the kit's real job handler, a local bare repository as the organisation's, and a scripted model. */
async function stack(plan: string[]) {
	const { remote } = makeRemote();
	const dir = mkdtempSync(join(tmpdir(), "cluster-job-"));
	const workspaceRoot = join(dir, "workspaces");
	mkdirSync(workspaceRoot);
	const envFor = (cwd?: string) => new NodeExecutionEnv({ cwd: cwd ?? workspaceRoot });
	const settings = { ...settingsFor(), repositoryUrl: remote };
	const hooks = createClusterHooks({ settings, spawn: fakeSpawn().spawn });
	const fake = scriptedModels(plan);
	const runtime = new PiDurableRuntime({
		storagePath: join(dir, "pi.sqlite"),
		models: fake.models,
		model: fake.model,
		env: envFor,
		policy: approvalPolicy([], profile.approvalPatterns, profile.toolApprovals),
		instructions: profile.systemPrompt,
		allowedTools: profile.allowedTools,
		extensions: hooks.extensions,
	});
	await runtime.start();
	cleanups.push(() => runtime.close());
	const rig = jobRig({ stateDir: dir });
	const host = new FakeHost();
	const handler = createHandler({
		runtime,
		envFor,
		session: { env: envFor(workspaceRoot), identity: { name: "SomeWork cluster development", email: "cluster-dev@somework.invalid" } },
		host,
		workspaceRoot,
		client: rig.client,
		limits: { maxTokensCap: 5_000_000, maxMinutesCap: 60 },
		metrics: new Metrics(),
		profile,
		hooks,
		source: "job",
	});
	const questions: { tool: string; summary: string }[] = [];
	const run = (input: Record<string, unknown> = {}, answer: { approved: boolean } = { approved: false }) =>
		runHandler(handler, { capability: { ...CAPABILITY }, input: { repository: { url: remote, ref: "main" }, instruction: "add change.txt", budget: { maxTokens: 1_000_000, maxMinutes: 5 }, ...input } }, { approve: async (question) => (questions.push(question), answer) });
	return { remote, host, questions, run, workspaceRoot, dir };
}

describe("a code.cluster job", () => {
	it("works on the one configured repository, pushes cluster/<job> and opens a pull request that says an agent made it", async () => {
		const s = await stack(["write:change.txt:hello", "final:added change.txt"]);
		const outcome = await s.run();
		assert.equal(outcome.type, "completed", JSON.stringify(outcome));
		const result = (outcome as any).result;
		assert.equal(result.status, "completed");
		assert.match(result.branch, /^cluster\/job-/);
		assert.match(sh(s.remote, "branch", "--list", result.branch), /cluster\/job-/, "the branch is on the remote");
		assert.equal(sh(s.remote, "show", `${result.branch}:change.txt`), "hello");
		assert.equal(s.host.created.length, 1);
		assert.equal(s.host.created[0]!.title, "cluster: add change.txt");
		assert.deepEqual(s.questions, []);
	});

	it("refuses another repository as invalid input, before anything is cloned", async () => {
		const s = await stack(["final:x"]);
		const outcome = await s.run({ repository: { url: "https://github.com/evil/other", ref: "main" } });
		assert.equal(outcome.type, "failed");
		assert.equal((outcome as any).failure.code, "invalid_input");
		assert.equal((outcome as any).failure.retryable, false);
		assert.match((outcome as any).failure.message, /only changes the repository it is configured for/);
		assert.equal(s.host.created.length, 0);
	});

	it("asks the requester before a destructive command and the command does not run when they say no", async () => {
		const victim = mkdtempSync(join(tmpdir(), "cluster-victim-"));
		writeFileSync(join(victim, "data"), "x");
		const s = await stack([`bash:rm -rf ${victim}`, "final:could not remove it"]);
		const outcome = await s.run({}, { approved: false });
		assert.equal(outcome.type, "completed");
		assert.equal(s.questions.length, 1);
		assert.equal(s.questions[0]!.tool, "bash");
		assert.ok(s.questions[0]!.summary.startsWith(`bash: rm -rf ${victim} [data: `), s.questions[0]!.summary);
		assert.ok(existsSync(join(victim, "data")), "nothing was removed");
	});

	it("never asks about a push to origin, and the command does not run", async () => {
		const s = await stack(["bash:touch ran.txt && git push origin main", "final:refused"]);
		const outcome = await s.run({}, { approved: true });
		assert.equal(outcome.type, "completed");
		assert.equal((outcome as any).result.status, "no_changes", "ran.txt was never created: nothing of the command ran");
		assert.deepEqual(s.questions, []);
	});

	it("starts from the chat tool's plan: the card's capability on the configured repository", async () => {
		const plan = (await clusterChangeTool({ repositoryUrl: "https://github.com/acme/somework" }).plan({ instruction: "add change.txt" })) as any;
		assert.deepEqual(plan.capability, CAPABILITY);
		assert.ok(profile.capabilities.some((entry) => entry.id === plan.capability.id));
	});
});

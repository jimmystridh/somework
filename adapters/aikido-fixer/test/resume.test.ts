import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { createHandler, type AgentRuntime, type GitHost } from "@somework/agent-kit";
import { makeRemote, sh } from "@somework/agent-kit/testing";
import type { Job, JobControl } from "@somework/sdk";
import { createFixerHooks } from "../src/hooks.ts";
import { profile } from "../src/profile.ts";
import { loadSettings } from "../src/settings.ts";

const REPO = "https://example.test/Acme/Shop.git";
const group = { id: 12, title: "Prototype pollution in lodash", type: "open_source", severity: "high", group_status: "new" };
const issue = { id: 99, group_id: 12, status: "open", affected_package: "lodash", code_repo_name: "Acme/Shop" };

class FlakyHost implements GitHost {
	created: { head: string; base: string; title: string; body: string }[] = [];
	failCreate = 0;
	async findPullRequest(query: { head: string }) {
		return this.created.some((pr) => pr.head === query.head) ? { url: `https://example.test/pr/${query.head}` } : undefined;
	}
	async createPullRequest(request: { head: string; base: string; title: string; body: string }) {
		if (this.failCreate-- > 0) throw new Error("GitHub POST /pulls answered 502");
		this.created.push(request);
		return { url: `https://example.test/pr/${request.head}` };
	}
}

/** The configured repository URL resolves to a local bare repository (git's own URL rewriting; the tests run one after the other). */
function pointRepositoryAt(remote: string): void {
	Object.assign(process.env, { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `url.${remote}.insteadOf`, GIT_CONFIG_VALUE_0: REPO });
}

function rig(answer = "FIXED: bump lodash to 4.17.21\n\nChanged package.json.") {
	const { remote } = makeRemote();
	pointRepositoryAt(remote);
	const root = mkdtempSync(join(tmpdir(), "aikido-resume-"));
	const env = new NodeExecutionEnv({ cwd: join(root, "ws") });
	const host = new FlakyHost();
	const calls = { model: 0 };
	const runtime: AgentRuntime = {
		start: async () => undefined,
		health: () => ({ ready: true }),
		close: async () => undefined,
		execute: async (request) => {
			calls.model += 1;
			writeFileSync(join(request.workspace, "package.json"), `{"lodash":"4.17.21"}\n`);
			return { status: "done", answer, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: 0 } };
		},
	};
	const settings = loadSettings({ AIKIDO_REPOSITORY_URL: REPO, AIKIDO_MAX_ATTEMPTS_PER_ISSUE: "5" });
	const clock = { now: new Date("2026-10-06T09:00:00Z") };
	const hooks = createFixerHooks({ settings, stateDir: root, now: () => clock.now, aikido: { resolveIssue: async () => ({ group, issue }) }, boundary: () => "b" });
	const handler = createHandler({
		runtime: hooks.wrapRuntime!(runtime),
		envFor: () => env,
		session: { env, identity: { name: "t", email: "t@t" } },
		host,
		workspaceRoot: join(root, "ws"),
		client: { uploadArtifact: async () => ({}) as never },
		limits: { maxTokensCap: 1_000_000, maxMinutesCap: 60 },
		profile,
		hooks,
	});
	const job = (taskId: string): Job => ({ taskId, capability: { id: "code.fix", version: 1 }, input: { issue: { id: 12 }, repository: { url: REPO }, budget: { maxTokens: 100_000, maxMinutes: 10 } }, task: {} }) as unknown as Job;
	const control = (): JobControl => ({ signal: new AbortController().signal, progress: () => undefined, requestInput: async () => ({ approved: false }) }) as unknown as JobControl;
	return { remote, host, calls, clock, run: (taskId: string) => handler(job(taskId), control()) };
}

const restore = (): void => void ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"].forEach((name) => delete process.env[name]);

describe("a fix whose pull request failed to open", () => {
	after(restore);
	it("is finished by the retry of the same task without another model run, and says what happened", async () => {
		const r = rig();
		r.host.failCreate = 1;
		const first = await r.run("tsk_1");
		assert.equal(first.type, "failed");
		assert.equal(r.calls.model, 1);
		const branch = sh(r.remote, "for-each-ref", "--format=%(refname:short)", "refs/heads/agent/").trim();
		assert.match(branch, /^agent\/aikido-12-[0-9a-f]{8}$/);
		const pushed = sh(r.remote, "rev-parse", `refs/heads/${branch}`).trim();

		const second = await r.run("tsk_1");
		assert.equal(second.type, "completed", JSON.stringify(second));
		const result = (second as any).result;
		assert.equal(r.calls.model, 1, "no second model run");
		assert.equal(result.outcome, "pr_opened");
		assert.equal(result.branch, branch);
		assert.equal(result.sha, pushed);
		assert.deepEqual(result.files, ["package.json"]);
		assert.equal(sh(r.remote, "rev-parse", `refs/heads/${branch}`).trim(), pushed, "nothing was pushed again");
		assert.equal(r.host.created.length, 1);
		assert.equal(r.host.created[0]!.title, "fix(security): bump lodash to 4.17.21 (Aikido #12)");
		assert.match(r.host.created[0]!.body, /earlier attempt of the same task/);
		assert.match(r.host.created[0]!.body, /Files changed \(1\): `package\.json`/);
	});

	it("is not resumed by a different task for the same issue, which runs the model and finds the branch already holding its work", async () => {
		const r = rig();
		r.host.failCreate = 1;
		assert.equal((await r.run("tsk_1")).type, "failed");
		const branch = sh(r.remote, "for-each-ref", "--format=%(refname:short)", "refs/heads/agent/").trim();
		const pushed = sh(r.remote, "rev-parse", `refs/heads/${branch}`).trim();
		r.clock.now = new Date("2026-10-06T14:00:00Z");
		const other = await r.run("tsk_2");
		assert.equal(other.type, "completed", JSON.stringify(other));
		assert.equal(r.calls.model, 2, "another task spends its own run");
		assert.equal((other as any).result.outcome, "pr_opened");
		assert.equal((other as any).result.branch, branch, "the same tree: the branch is reused, not suffixed");
		assert.equal(sh(r.remote, "rev-parse", `refs/heads/${branch}`).trim(), pushed);
		assert.equal(r.host.created.length, 1);
		assert.match(r.host.created[0]!.body, /Files changed \(1\): `package\.json`/, "the earlier attempt's commit is in the file list even though the model changed nothing new");
		assert.deepEqual((other as any).result.files, ["package.json"]);
	});

	it("opens the pull request on the suffixed branch, and says so in the result, when different work already holds the name", async () => {
		const r = rig();
		const probe = await r.run("tsk_0");
		assert.equal(probe.type, "completed");
		const branch = (probe as any).result.branch as string;
		const original = sh(r.remote, "rev-parse", `refs/heads/${branch}`).trim();
		// the same issue and base, but this time the model produces a different fix: a second handler on the same repository
		const { remote } = r;
		const root = mkdtempSync(join(tmpdir(), "aikido-resume2-"));
		const env = new NodeExecutionEnv({ cwd: join(root, "ws") });
		const host = new FlakyHost();
		const runtime: AgentRuntime = {
			start: async () => undefined,
			health: () => ({ ready: true }),
			close: async () => undefined,
			execute: async (request) => {
				writeFileSync(join(request.workspace, "package.json"), `{"lodash":"4.17.22"}\n`);
				return { status: "done", answer: "FIXED: bump lodash to 4.17.22", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: 0 } };
			},
		};
		const hooks = createFixerHooks({ settings: loadSettings({ AIKIDO_REPOSITORY_URL: REPO, AIKIDO_MAX_ATTEMPTS_PER_ISSUE: "5" }), stateDir: root, aikido: { resolveIssue: async () => ({ group, issue }) } });
		const handler = createHandler({ runtime: hooks.wrapRuntime!(runtime), envFor: () => env, session: { env, identity: { name: "t", email: "t@t" } }, host, workspaceRoot: join(root, "ws"), client: { uploadArtifact: async () => ({}) as never }, limits: { maxTokensCap: 1_000_000, maxMinutesCap: 60 }, profile, hooks });
		const done = await handler({ taskId: "tsk_9", capability: { id: "code.fix", version: 1 }, input: { issue: { id: 12 }, repository: { url: REPO }, budget: { maxTokens: 100_000, maxMinutes: 10 } }, task: {} } as unknown as Job, { signal: new AbortController().signal, progress: () => undefined, requestInput: async () => ({ approved: false }) } as unknown as JobControl);
		assert.equal(done.type, "completed", JSON.stringify(done));
		assert.equal((done as any).result.branch, `${branch}-2`);
		assert.equal(host.created[0]!.head, `${branch}-2`);
		assert.equal(sh(remote, "rev-parse", `refs/heads/${branch}`).trim(), original, "the first branch is untouched");
	});
});

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { InvalidInput, prepareWorkspace, type AgentRuntime, type ResultContext, type RoleHooks } from "@somework/agent-kit";
import { makeRemote, sh } from "@somework/agent-kit/testing";
import { AikidoError } from "../src/aikido/client.ts";
import { createFixerHooks, outcomeOf, SKIPPED } from "../src/hooks.ts";
import { loadSettings } from "../src/settings.ts";

const REPO = "https://github.com/Acme/Shop.git";
const group = (extra: Record<string, unknown> = {}) => ({ id: 12, title: "Prototype pollution in lodash", type: "open_source", severity: "high", group_status: "new", ...extra });
const issue = { id: 99, group_id: 12, status: "open", affected_package: "lodash", installed_version: "4.17.20", patched_versions: ["4.17.21"], code_repo_name: "Acme/Shop" };

interface Rig {
	hooks: RoleHooks;
	resolved: string[];
	stateDir: string;
	clock: { now: Date };
}

function rig(env: NodeJS.ProcessEnv = {}, resolve?: (id: string | number) => Promise<any>): Rig {
	const stateDir = mkdtempSync(join(tmpdir(), "aikido-hooks-"));
	const resolved: string[] = [];
	const clock = { now: new Date("2026-10-06T09:00:00Z") };
	const settings = loadSettings({ AIKIDO_REPOSITORY_URL: REPO, ...env });
	const hooks = createFixerHooks({
		settings,
		stateDir,
		now: () => clock.now,
		boundary: () => "testbound",
		aikido: { resolveIssue: async (id) => (resolved.push(String(id)), resolve ? resolve(id) : { group: group(), issue }) },
	});
	return { hooks, resolved, stateDir, clock };
}

const request = (extra: Record<string, unknown> = {}) => ({ issue: { id: 12 }, repository: { url: REPO }, budget: { maxTokens: 300_000, maxMinutes: 30 }, ...extra });
const prepare = (r: Rig, taskId: string, input: any = request()) => r.hooks.prepareInput!(input, { taskId, log: () => undefined }) as Promise<any>;

/** A workspace cloned the way the kit does it, with files changed the way the model would. */
async function workspace(files: Record<string, string>) {
	const { remote } = makeRemote();
	const root = mkdtempSync(join(tmpdir(), "aikido-ws-"));
	const dir = join(root, "ws");
	const env = new NodeExecutionEnv({ cwd: root });
	const prepared = await prepareWorkspace({ env, identity: { name: "t", email: "t@t" } }, { repoUrl: remote, ref: "HEAD", taskId: "task", workspace: dir, branch: "agent/aikido-12-test" });
	for (const [name, content] of Object.entries(files)) {
		mkdirSync(join(dir, name, ".."), { recursive: true });
		writeFileSync(join(dir, name), content);
	}
	return { dir, env, prepared, remote };
}

const context = (r: { dir: string; env: NodeExecutionEnv; prepared: { baseSha: string; baseBranch: string } }, taskId: string, answer = "FIXED: bump lodash\n\nDone.") => ({
	taskId,
	input: {},
	instruction: "",
	workspace: r.dir,
	baseSha: r.prepared.baseSha,
	baseBranch: r.prepared.baseBranch,
	envFor: () => r.env,
	client: { uploadArtifact: async () => ({}) as any },
	log: () => undefined,
	answer,
	usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: 0 },
	signal: new AbortController().signal,
	onProgress: () => undefined,
});

describe("preparing a task", () => {
	it("reads the issue, names the workspace after it and asks for the head of the default branch", async () => {
		const r = rig();
		const prepared = await prepare(r, "t1");
		assert.equal(prepared.agentKey, "aikido:12");
		assert.deepEqual(prepared.repository, { url: REPO, ref: "HEAD" });
		assert.deepEqual(r.resolved, ["12"]);
		const instruction = r.hooks.instruction!(prepared, { taskId: "t1" });
		assert.match(instruction, /<<<AIKIDO-testbound/);
		assert.match(instruction, /Prototype pollution in lodash/);
		assert.match(instruction, /package: lodash \(installed 4\.17\.20\), patched in 4\.17\.21/);
	});

	it("keeps a ref the requester asked for", async () => {
		const prepared = await prepare(rig(), "t1", request({ repository: { url: REPO, ref: "release-1" } }));
		assert.equal(prepared.repository.ref, "release-1");
	});

	it("accepts the issue id as a number or a numeric string, and only that", async () => {
		const r = rig();
		await prepare(r, "a", request({ issue: { id: "12" } }));
		for (const id of ["abc", "", "1 2", "12345678901234", null, undefined, {}]) await assert.rejects(prepare(r, `x${String(id)}`, request({ issue: { id } })), InvalidInput, String(id));
	});

	it("refuses a repository it is not configured for, without asking Aikido", async () => {
		const r = rig();
		await assert.rejects(prepare(r, "t1", request({ repository: { url: "https://github.com/acme/other.git" } })), /only fixes the repository it is configured for/);
		await prepare(r, "t2", request({ repository: { url: "https://github.com/ACME/shop" } }));
		assert.deepEqual(r.resolved, ["12"]);
	});

	it("turns an unknown issue and refused credentials into invalid input, and a passing Aikido outage into a retry", async () => {
		const missing = rig({}, async () => { throw new AikidoError("not_found", "Aikido has nothing at /issues/groups", 404); });
		await assert.rejects(prepare(missing, "t1"), (error: Error) => error instanceof InvalidInput && /Aikido has nothing/.test(error.message));
		const refused = rig({}, async () => { throw new AikidoError("unauthorized", "Aikido refused the client credentials (401)", 401); });
		await assert.rejects(prepare(refused, "t1"), InvalidInput);
		const down = rig({}, async () => { throw new AikidoError("unavailable", "Aikido answered 503", 503); });
		await assert.rejects(prepare(down, "t1"), (error: Error) => !(error instanceof InvalidInput) && error instanceof AikidoError);
	});

	it("ends an ineligible task as skipped before the model runs, and does not count it as an attempt", async () => {
		const low = rig({}, async () => ({ group: group({ severity: "low" }), issue }));
		await prepare(low, "t1");
		const gate = await low.hooks.beforeRun!({ ...context({ dir: "/w", env: new NodeExecutionEnv({ cwd: tmpdir() }), prepared: { baseSha: "a".repeat(40), baseBranch: "main" } }, "t1"), signal: new AbortController().signal });
		assert.ok(gate && "blocked" in gate);
		assert.match(gate.blocked.reason, new RegExp(`^${SKIPPED}the severity low is below the threshold high`));
		const eligible = rig();
		await prepare(eligible, "a");
		eligible.clock.now = new Date("2026-10-06T09:01:00Z");
		await prepare(eligible, "a");
		await prepare(eligible, "b");
		const secondGate = await eligible.hooks.beforeRun!({ ...context({ dir: "/w", env: new NodeExecutionEnv({ cwd: tmpdir() }), prepared: { baseSha: "a".repeat(40), baseBranch: "main" } }, "b"), signal: new AbortController().signal });
		assert.ok(secondGate && "blocked" in secondGate);
		assert.match(secondGate.blocked.reason, /less than 180 minutes ago/);
	});

	it("ends an ineligible task before any clone: the workspace gate skips it with the same reason", async () => {
		const low = rig({}, async () => ({ group: group({ severity: "low" }), issue }));
		await prepare(low, "t1");
		const gate = await low.hooks.beforeWorkspace!({}, { taskId: "t1", log: () => {} });
		assert.ok(gate && "blocked" in gate);
		assert.match(gate.blocked.reason, new RegExp(`^${SKIPPED}the severity low is below the threshold high`));
		const eligible = rig();
		await prepare(eligible, "a");
		assert.equal(await eligible.hooks.beforeWorkspace!({}, { taskId: "a", log: () => {} }), undefined);
	});

	it("chooses one branch name per task, from the issue and the commit, and keeps it when the base moves", async () => {
		const r = rig();
		await prepare(r, "t1");
		assert.equal(r.hooks.branchName!({ input: {}, taskId: "t1", baseSha: "0123456789abcdef" }), "agent/aikido-12-01234567");
		assert.equal(r.hooks.branchName!({ input: {}, taskId: "t1", baseSha: "fedcba9876543210" }), "agent/aikido-12-01234567");
		assert.throws(() => r.hooks.branchName!({ input: {}, taskId: "unknown", baseSha: "a" }), InvalidInput);
	});
});

describe("before the change is committed", () => {
	const quickRig = async (env: NodeJS.ProcessEnv = {}, taskId = "t") => {
		const r = rig(env);
		await prepare(r, taskId);
		return r;
	};

	it("discards a change when the agent says there is no safe fix", async () => {
		const r = await quickRig();
		const w = await workspace({ "speculative.txt": "maybe", "README.md": "changed\n" });
		assert.equal(await r.hooks.beforeFinalize!(context(w, "t", "NO_FIX: no patched version exists\n\nThe fix needs a major upgrade.")), undefined);
		assert.equal(sh(w.dir, "status", "--porcelain").trim(), "");
		assert.equal(existsSync(join(w.dir, "speculative.txt")), false);
	});

	it("lets an ordinary change through and remembers its files for the pull request", async () => {
		const r = await quickRig();
		const w = await workspace({ "package.json": "{}\n", "package-lock.json": "{}\n" });
		assert.equal(await r.hooks.beforeFinalize!(context(w, "t")), undefined);
		const pr = r.hooks.pullRequest!({}, { taskId: "t", instruction: "" });
		assert.match(pr.body, /Files changed \(2\): `package-lock\.json`, `package\.json`/);
		assert.equal(pr.title, "fix(security): bump lodash (Aikido #12)");
		assert.ok(pr.commitMessage!.startsWith(pr.title));
	});

	it("holds back a change to a protected path, whatever else is in it", async () => {
		const r = await quickRig();
		const w = await workspace({ "package.json": "{}\n", ".github/workflows/ci.yml": "on: push\n" });
		const gate = await r.hooks.beforeFinalize!(context(w, "t"));
		assert.ok(gate && "blocked" in gate);
		assert.match(gate.blocked.reason, /protected path \(\.github\/workflows\/ci\.yml, rule \.github\/\*\*\); nothing was pushed/);
	});

	it("holds back a change to a key or environment file, and to a deleted protected file", async () => {
		const r = await quickRig();
		const w = await workspace({ "config/.env": "A=1\n" });
		const gate = await r.hooks.beforeFinalize!(context(w, "t"));
		assert.ok(gate && "blocked" in gate);
		assert.match(gate.blocked.reason, /protected path/);
	});

	it("holds back a change with too many files", async () => {
		const r = await quickRig({ AIKIDO_MAX_FILES: "2" });
		const w = await workspace({ "a.txt": "1", "b.txt": "2", "c.txt": "3" });
		const gate = await r.hooks.beforeFinalize!(context(w, "t"));
		assert.ok(gate && "blocked" in gate);
		assert.match(gate.blocked.reason, /touches 3 files, more than the limit of 2/);
	});

	it("holds back a change that adds a secret-like string", async () => {
		const r = await quickRig();
		const w = await workspace({ "src/config.ts": `export const key = "ghp_${"a".repeat(30)}";\n` });
		const gate = await r.hooks.beforeFinalize!(context(w, "t"));
		assert.ok(gate && "blocked" in gate);
		assert.match(gate.blocked.reason, /adds a GitHub token/);
		const keyed = await workspace({ "src/k.txt": "-----BEGIN RSA PRIVATE KEY-----\nabc\n" });
		const second = await r.hooks.beforeFinalize!(context(keyed, "t"));
		assert.ok(second && "blocked" in second);
		assert.match(second.blocked.reason, /private key/);
	});

	it("runs the repository's named check profile and records the result; a failing one blocks the push", async () => {
		const dir = mkdtempSync(join(tmpdir(), "aikido-checks-"));
		const file = join(dir, "checks.json");
		writeFileSync(file, JSON.stringify({ pass: { command: "echo checked && test -f package.json" }, fail: { command: "echo broken >&2; exit 3" } }));
		const passing = await quickRig({ AIKIDO_CHECK_PROFILE: "pass", AIKIDO_CHECK_FILE: file });
		const w = await workspace({ "package.json": "{}\n" });
		assert.equal(await passing.hooks.beforeFinalize!(context(w, "t")), undefined);
		assert.match(passing.hooks.pullRequest!({}, { taskId: "t", instruction: "" }).body, /Check profile `pass`: passed \(checked\)/);

		const failing = await quickRig({ AIKIDO_CHECK_PROFILE: "fail", AIKIDO_CHECK_FILE: file });
		const w2 = await workspace({ "package.json": "{}\n" });
		const gate = await failing.hooks.beforeFinalize!(context(w2, "t"));
		assert.ok(gate && "blocked" in gate);
		assert.match(gate.blocked.reason, /check profile fail failed; nothing was pushed/);
		assert.match(JSON.stringify(gate.blocked.details), /exit code 3: broken/);
	});

	it("does nothing when the agent changed nothing", async () => {
		const r = await quickRig();
		const w = await workspace({});
		assert.equal(await r.hooks.beforeFinalize!(context(w, "t", "FIXED: nothing to do")), undefined);
	});
});

describe("a workspace that already holds an earlier attempt's commit", () => {
	/** The state a retry finds: files committed by `finalizeWorkspace` of an earlier attempt, then the model's new changes (if any). */
	async function persisted(committed: Record<string, string>, fresh: Record<string, string> = {}) {
		const w = await workspace(committed);
		sh(w.dir, "add", "-A");
		sh(w.dir, "commit", "-q", "-m", "earlier attempt");
		for (const [name, content] of Object.entries(fresh)) {
			mkdirSync(join(w.dir, name, ".."), { recursive: true });
			writeFileSync(join(w.dir, name), content);
		}
		return w;
	};
	const prepared = async (env: NodeJS.ProcessEnv = {}) => {
		const r = rig(env);
		await prepare(r, "t");
		return r;
	};

	it("counts the files of the earlier commit and of the new changes together, in the pull request text too", async () => {
		const r = await prepared();
		const w = await persisted({ "bun.lock": "lock\n" }, { "package.json": "{}\n" });
		assert.equal(await r.hooks.beforeFinalize!(context(w, "t")), undefined);
		const body = r.hooks.pullRequest!({}, { taskId: "t", instruction: "" }).body;
		assert.match(body, /Files changed \(2\): `bun\.lock`, `package\.json`/);
	});

	it("reports the earlier commit's file when the model changed nothing more (the retry that produced 'Files changed (0)')", async () => {
		const r = await prepared();
		const w = await persisted({ "bun.lock": "lock\n" });
		assert.equal(sh(w.dir, "status", "--porcelain").trim(), "", "nothing is uncommitted");
		assert.equal(await r.hooks.beforeFinalize!(context(w, "t")), undefined);
		assert.match(r.hooks.pullRequest!({}, { taskId: "t", instruction: "" }).body, /Files changed \(1\): `bun\.lock`/);
	});

	it("holds back a protected path that is inside the earlier commit, whatever the new changes are", async () => {
		const r = await prepared();
		const w = await persisted({ ".github/workflows/ci.yml": "on: push\n", "package.json": "{}\n" }, { "README.md": "more\n" });
		const gate = await r.hooks.beforeFinalize!(context(w, "t"));
		assert.ok(gate && "blocked" in gate);
		assert.match(gate.blocked.reason, /protected path \(\.github\/workflows\/ci\.yml, rule \.github\/\*\*\); nothing was pushed/);
	});

	it("holds back a protected path in the earlier commit even when nothing new was changed", async () => {
		const r = await prepared();
		const w = await persisted({ "config/.env.production": "A=1\n" });
		const gate = await r.hooks.beforeFinalize!(context(w, "t"));
		assert.ok(gate && "blocked" in gate);
		assert.match(gate.blocked.reason, /protected path/);
	});

	it("holds back secret-like text that is inside the earlier commit", async () => {
		const r = await prepared();
		const w = await persisted({ "src/config.ts": `export const key = "ghp_${"b".repeat(30)}";\n` });
		const gate = await r.hooks.beforeFinalize!(context(w, "t"));
		assert.ok(gate && "blocked" in gate);
		assert.match(gate.blocked.reason, /adds a GitHub token/);
	});

	it("counts the earlier commit's files against the file limit", async () => {
		const r = await prepared({ AIKIDO_MAX_FILES: "3" });
		const w = await persisted({ "a.txt": "1", "b.txt": "2" }, { "c.txt": "3", "d.txt": "4" });
		const gate = await r.hooks.beforeFinalize!(context(w, "t"));
		assert.ok(gate && "blocked" in gate);
		assert.match(gate.blocked.reason, /touches 4 files, more than the limit of 3/);
	});

	it("runs the check profile over the whole change, the earlier commit included", async () => {
		const dir = mkdtempSync(join(tmpdir(), "aikido-checks-"));
		const file = join(dir, "checks.json");
		writeFileSync(file, JSON.stringify({ lock: { command: "test -f bun.lock" } }));
		const r = await prepared({ AIKIDO_CHECK_PROFILE: "lock", AIKIDO_CHECK_FILE: file });
		const w = await persisted({ "bun.lock": "lock\n" });
		assert.equal(await r.hooks.beforeFinalize!(context(w, "t")), undefined);
		assert.match(r.hooks.pullRequest!({}, { taskId: "t", instruction: "" }).body, /Check profile `lock`: passed/);
	});

	it("throws away the earlier commit too when the agent now says there is no safe fix", async () => {
		const r = await prepared();
		const w = await persisted({ "bun.lock": "lock\n" }, { "speculative.txt": "maybe\n" });
		assert.equal(await r.hooks.beforeFinalize!(context(w, "t", "NO_FIX: the patched version is gone\n\nNothing to do.")), undefined);
		assert.equal(sh(w.dir, "rev-parse", "HEAD").trim(), w.prepared.baseSha, "back at the commit the work started from");
		assert.equal(sh(w.dir, "status", "--porcelain").trim(), "");
		assert.equal(existsSync(join(w.dir, "bun.lock")), false);
	});
});

describe("approvals", () => {
	it("are refused for every command that asks, and everything else passes through unchanged", async () => {
		const r = rig();
		const seen: { approval?: unknown; signal?: AbortSignal } = {};
		const inner: AgentRuntime = {
			start: async () => undefined,
			health: () => ({ ready: true }),
			close: async () => undefined,
			execute: async (_request, hooks) => {
				seen.approval = await hooks.requestApproval({ tool: "bash", summary: "git push origin HEAD" });
				seen.signal = hooks.signal;
				return { status: "done", answer: "ok", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 } };
			},
		};
		const wrapped = r.hooks.wrapRuntime!(inner);
		const controller = new AbortController();
		const outcome = await wrapped.execute({ requestId: "r", agentKey: "k", instruction: "i", workspace: "/w", budget: { maxTokens: 1, maxMinutes: 1 } }, { signal: controller.signal, onProgress: () => undefined, requestApproval: async () => ({ approved: true }) });
		assert.equal(outcome.status, "done");
		assert.equal((seen.approval as any).approved, false);
		assert.match((seen.approval as any).reason, /no person answers/);
		assert.equal(seen.signal, controller.signal);
		assert.deepEqual(wrapped.health(), { ready: true });
	});
});

describe("the task result", () => {
	const summary = { groupId: "12", summary: undefined as any, input: {} as any, files: ["package.json"] };
	const state = (extra: Record<string, unknown> = {}) => ({ ...summary, input: {}, summary: { groupId: "12" } as any, files: ["package.json"], baseSha: "b".repeat(40), ...extra }) as any;
	const ctx = (extra: Partial<ResultContext>): ResultContext => ({ taskId: "t", input: {}, instruction: "", workspace: "/w", baseSha: "b".repeat(40), baseBranch: "main", envFor: undefined as any, client: undefined as any, log: () => undefined, answer: "", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 }, ...extra });

	it("reports an opened pull request with its branch, commit, files and usage", () => {
		const result = outcomeOf({ usage: { totalTokens: 10, costUsd: 0.1 } }, ctx({ finalize: { status: "completed", branch: "agent/aikido-12-bbbbbbbb", commits: ["c1", "c2"], prUrl: "https://example.test/pr/1", patch: "" } }), state({ parsed: { kind: "fixed", headline: "bump", text: "details" } }));
		assert.deepEqual(result, { outcome: "pr_opened", summary: "bump\n\ndetails", prUrl: "https://example.test/pr/1", branch: "agent/aikido-12-bbbbbbbb", sha: "c2", aikidoIssueId: 12, files: ["package.json"], baseSha: "b".repeat(40), usage: { totalTokens: 10, costUsd: 0.1 } });
	});

	it("reports no_fix with the agent's reason, whether it said so or just changed nothing", () => {
		const said = outcomeOf({}, ctx({ finalize: { status: "no_changes", branch: "b", commits: [], patch: "" } }), state({ parsed: { kind: "no_fix", headline: "no patched version", text: "needs a major upgrade" } }));
		assert.equal(said.outcome, "no_fix");
		assert.match(said.summary as string, /no patched version\n\nneeds a major upgrade/);
		const silent = outcomeOf({}, ctx({ finalize: { status: "no_changes", branch: "b", commits: [], patch: "" } }), state());
		assert.equal(silent.outcome, "no_fix");
		assert.match(silent.summary as string, /changed nothing/);
	});

	it("reports skipped and blocked from the reason of the gate", () => {
		const skipped = outcomeOf({}, ctx({ blocked: { reason: `${SKIPPED}the issue is closed in Aikido` } }), state());
		assert.deepEqual([skipped.outcome, skipped.summary], ["skipped", "the issue is closed in Aikido"]);
		const blocked = outcomeOf({}, ctx({ blocked: { reason: "the change touches a protected path (.github/x)" } }), state({ tests: { profile: "unit", ok: false, summary: "failed" } }));
		assert.equal(blocked.outcome, "blocked");
		assert.deepEqual(blocked.tests, { profile: "unit", ok: false, summary: "failed" });
	});

	it("reports a pushed branch without a pull request as blocked, never as opened", () => {
		const result = outcomeOf({}, ctx({ finalize: { status: "completed", branch: "agent/aikido-12-bbbbbbbb", commits: ["c1"], patch: "" } }), state({ parsed: { kind: "fixed", headline: "bump", text: "" } }));
		assert.equal(result.outcome, "blocked");
		assert.equal(result.branch, "agent/aikido-12-bbbbbbbb");
		assert.match(result.summary as string, /no pull request could be opened/);
		assert.equal(result.prUrl, undefined);
	});

	it("fails (for a retry) when the run finished without a prepared issue", () => {
		const patch = rig().hooks.result!({}, ctx({})) as any;
		assert.equal(patch.failure.code, "job_error");
	});
});

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { Job, JobControl } from "@somework/sdk";
import { BranchExhaustedError, finalizeWorkspace, MAX_BRANCH_SUFFIX, prepareWorkspace, pushedWork, workspaceFor, type GitSession } from "../src/git.ts";
import type { GitHost } from "../src/githost.ts";
import { createHandler } from "../src/handler.ts";
import type { AgentRuntime } from "../src/runtime.ts";
import type { AgentProfile } from "../src/profile.ts";
import { FakeHost, makeRemote, sh } from "../src/testing.ts";

const BRANCH = "agent/fix-1";
let clock = 1_700_000_000;

/** A commit made at a different moment than any other: the same change gets a different commit id, as a rerun does. */
const commitAt = (cwd: string, message: string): void => {
	clock += 60;
	execFileSync("git", ["commit", "-q", "-m", message], { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_AUTHOR_DATE: `${clock} +0000`, GIT_COMMITTER_DATE: `${clock} +0000` } });
};

interface Rig {
	remote: string;
	session: GitSession;
	root: string;
	/** A fresh workspace on the task branch with `files` written, not yet committed. */
	work(files: Record<string, string>, options?: { taskId?: string; branch?: string }): Promise<{ dir: string; baseSha: string; baseBranch: string }>;
	finalize(dir: string, prepared: { baseSha: string; baseBranch: string }, host?: GitHost, extra?: Record<string, unknown>): ReturnType<typeof finalizeWorkspace>;
	tip(branch: string): string | undefined;
}

function rig(): Rig {
	const { remote } = makeRemote();
	const root = mkdtempSync(join(tmpdir(), "finalize-"));
	const session: GitSession = { env: new NodeExecutionEnv({ cwd: root }), identity: { name: "t", email: "t@t" } };
	let n = 0;
	return {
		remote,
		session,
		root,
		async work(files, options = {}) {
			const dir = workspaceFor(join(root, "ws"), `w${++n}`);
			const prepared = await prepareWorkspace(session, { repoUrl: remote, ref: "HEAD", taskId: options.taskId ?? "task_1", workspace: dir, branch: options.branch ?? BRANCH });
			for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
			return { dir, baseSha: prepared.baseSha, baseBranch: prepared.baseBranch };
		},
		finalize(dir, prepared, host = new FakeHost(), extra = {}) {
			// the commit the finalize step makes is stamped with a moving clock, so two runs never share a commit id
			const original = process.env.GIT_COMMITTER_DATE;
			clock += 60;
			process.env.GIT_COMMITTER_DATE = `${clock} +0000`;
			process.env.GIT_AUTHOR_DATE = `${clock} +0000`;
			return finalizeWorkspace(session, host, { repoUrl: remote, ref: "HEAD", taskId: "task_1", workspace: dir, title: "fix", body: "body", baseSha: prepared.baseSha, baseBranch: prepared.baseBranch, branch: BRANCH, ...extra }).finally(() => {
				original === undefined ? delete process.env.GIT_COMMITTER_DATE : (process.env.GIT_COMMITTER_DATE = original);
				delete process.env.GIT_AUTHOR_DATE;
			});
		},
		tip: (branch) => {
			try {
				return sh(remote, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`).trim();
			} catch {
				return undefined;
			}
		},
	};
}

/** A host that records pull requests and can be told to fail creating one. */
class FlakyHost implements GitHost {
	created: { head: string; base: string }[] = [];
	failCreate = 0;
	async findPullRequest(query: { head: string }) {
		return this.created.some((pr) => pr.head === query.head) ? { url: `https://example.test/pr/${query.head}` } : undefined;
	}
	async createPullRequest(request: { head: string; base: string }) {
		if (this.failCreate-- > 0) throw new Error("GitHub POST /pulls answered 502");
		this.created.push({ head: request.head, base: request.base });
		return { url: `https://example.test/pr/${request.head}` };
	}
}

describe("finalize: the first push", () => {
	it("pushes a branch the remote does not have and opens the pull request, as it always did", async () => {
		const r = rig();
		const w = await r.work({ "fix.txt": "fixed\n" });
		const host = new FakeHost();
		const done = await r.finalize(w.dir, w, host);
		assert.equal(done.status, "completed");
		assert.equal(done.branch, BRANCH);
		assert.equal(done.reused, undefined);
		assert.equal(r.tip(BRANCH), done.commits[0]);
		assert.equal(done.prUrl, `https://example.test/pr/${BRANCH}`);
		assert.equal(host.created.length, 1);
	});

	it("reports no changes without touching the remote", async () => {
		const r = rig();
		const w = await r.work({});
		const done = await r.finalize(w.dir, w);
		assert.equal(done.status, "no_changes");
		assert.equal(r.tip(BRANCH), undefined);
	});
});

describe("finalize: the branch already exists on the remote", () => {
	it("reuses it, without pushing, when it holds the same tree under a different commit id", async () => {
		const r = rig();
		const first = await r.work({ "fix.txt": "fixed\n" });
		await r.finalize(first.dir, first);
		const pushed = r.tip(BRANCH)!;

		const rerun = await r.work({ "fix.txt": "fixed\n" });
		const host = new FakeHost();
		const done = await r.finalize(rerun.dir, rerun, host);
		const localHead = sh(rerun.dir, "rev-parse", "HEAD").trim();
		assert.notEqual(localHead, pushed, "the rerun really made another commit");
		assert.equal(sh(rerun.dir, "rev-parse", "HEAD^{tree}").trim(), sh(rerun.dir, "rev-parse", `${pushed}^{tree}`).trim());
		assert.equal(r.tip(BRANCH), pushed, "the remote branch is untouched");
		assert.equal(done.branch, BRANCH);
		assert.equal(done.reused, true);
		assert.deepEqual(done.commits, [pushed], "the commits reported are the remote's");
		assert.equal(done.prUrl, `https://example.test/pr/${BRANCH}`);
		assert.equal(host.created.length, 1, "the pull request is still opened when the first attempt failed to");
	});

	it("does not open a second pull request when one exists", async () => {
		const r = rig();
		const host = new FlakyHost();
		const first = await r.work({ "fix.txt": "fixed\n" });
		await r.finalize(first.dir, first, host);
		const rerun = await r.work({ "fix.txt": "fixed\n" });
		const done = await r.finalize(rerun.dir, rerun, host);
		assert.equal(done.reused, true);
		assert.equal(host.created.length, 1);
	});

	it("moves to <branch>-2 when the remote branch holds different work, and never rewrites the one that is there", async () => {
		const r = rig();
		const first = await r.work({ "fix.txt": "one way\n" });
		await r.finalize(first.dir, first);
		const original = r.tip(BRANCH)!;

		const other = await r.work({ "fix.txt": "another way\n" });
		const host = new FakeHost();
		const done = await r.finalize(other.dir, other, host);
		assert.equal(done.branch, `${BRANCH}-2`);
		assert.equal(r.tip(BRANCH), original, "no force push, ever");
		assert.equal(r.tip(`${BRANCH}-2`), done.commits.at(-1));
		assert.equal(host.created[0]!.head, `${BRANCH}-2`, "the pull request head is the real branch");
		assert.equal(done.reused, undefined);
	});

	it("finds its own earlier suffix branch on a rerun instead of taking the next number", async () => {
		const r = rig();
		for (const content of ["one way\n", "another way\n"]) {
			const w = await r.work({ "fix.txt": content });
			await r.finalize(w.dir, w);
		}
		const again = await r.work({ "fix.txt": "another way\n" });
		const done = await r.finalize(again.dir, again);
		assert.equal(done.branch, `${BRANCH}-2`);
		assert.equal(done.reused, true);
		assert.equal(r.tip(`${BRANCH}-3`), undefined);
	});

	it("takes -3 and -4 as the different versions pile up", async () => {
		const r = rig();
		const branches: string[] = [];
		for (const content of ["a\n", "b\n", "c\n", "d\n"]) {
			const w = await r.work({ "fix.txt": content });
			branches.push((await r.finalize(w.dir, w)).branch);
		}
		assert.deepEqual(branches, [BRANCH, `${BRANCH}-2`, `${BRANCH}-3`, `${BRANCH}-4`]);
	});

	it("fails clearly, pushing nothing, when every name up to the last suffix is taken by different work", async () => {
		const r = rig();
		for (let i = 0; i < MAX_BRANCH_SUFFIX; i++) {
			const w = await r.work({ "fix.txt": `version ${i}\n` });
			await r.finalize(w.dir, w);
		}
		const before = ["", "-2", "-3", "-4", "-5"].map((suffix) => r.tip(`${BRANCH}${suffix}`));
		assert.ok(before.every(Boolean));
		const last = await r.work({ "fix.txt": "one more way\n" });
		await assert.rejects(r.finalize(last.dir, last), (error: unknown) => error instanceof BranchExhaustedError && /different work on agent\/fix-1, agent\/fix-1-2, agent\/fix-1-3, agent\/fix-1-4, agent\/fix-1-5/.test(error.message) && /nothing was pushed/.test(error.message));
		assert.deepEqual(["", "-2", "-3", "-4", "-5"].map((suffix) => r.tip(`${BRANCH}${suffix}`)), before);
		assert.equal(r.tip(`${BRANCH}-6`), undefined);
	});

	it("still pushes plainly (a fast-forward) when the work builds on what the remote branch has", async () => {
		const r = rig();
		const w = await r.work({ "fix.txt": "first\n" });
		const first = await r.finalize(w.dir, w);
		writeFileSync(join(w.dir, "more.txt"), "more\n");
		sh(w.dir, "add", "-A");
		commitAt(w.dir, "more");
		const done = await r.finalize(w.dir, w);
		assert.equal(done.branch, BRANCH);
		assert.equal(done.reused, undefined);
		assert.equal(done.commits.length, 2);
		assert.equal(r.tip(BRANCH), done.commits[1]);
		assert.equal(sh(r.remote, "merge-base", "--is-ancestor", first.commits[0]!, `refs/heads/${BRANCH}`) === "", true);
	});

	it("is repeatable: finalize twice on one workspace changes nothing the second time", async () => {
		const r = rig();
		const host = new FlakyHost();
		const w = await r.work({ "fix.txt": "fixed\n" });
		const first = await r.finalize(w.dir, w, host);
		const second = await r.finalize(w.dir, w, host);
		assert.equal(second.branch, first.branch);
		assert.deepEqual(second.commits, first.commits);
		assert.equal(second.reused, true);
		assert.equal(host.created.length, 1);
	});

	it("keeps the branch name a role chose through its hook, and reports the one it really used", async () => {
		const r = rig();
		const named = "agent/aikido-12-abcdef01";
		const a = await r.work({ "a.txt": "1\n" }, { branch: named });
		const b = await r.work({ "a.txt": "2\n" }, { branch: named });
		assert.equal((await r.finalize(a.dir, a, new FakeHost(), { branch: named })).branch, named);
		assert.equal((await r.finalize(b.dir, b, new FakeHost(), { branch: named })).branch, `${named}-2`);
	});
});

describe("a pull request that failed to open after a successful push", () => {
	it("is opened by the retry without a new push, and the retry's workspace knows what was pushed", async () => {
		const r = rig();
		const host = new FlakyHost();
		host.failCreate = 1;
		const w = await r.work({ "fix.txt": "fixed\n" });
		await assert.rejects(r.finalize(w.dir, w, host), /502/);
		const pushed = r.tip(BRANCH)!;
		assert.ok(pushed, "the branch was pushed before the pull request failed");
		assert.deepEqual(await pushedWork(r.session, { workspace: w.dir, taskId: "task_1", baseSha: w.baseSha }), { branch: BRANCH, sha: pushed });
		const done = await r.finalize(w.dir, w, host);
		assert.equal(r.tip(BRANCH), pushed);
		assert.equal(done.prUrl, `https://example.test/pr/${BRANCH}`);
		assert.equal(host.created.length, 1);
	});

	it("is not reported as pushed work for another task, after HEAD moved, or before any push", async () => {
		const r = rig();
		const w = await r.work({ "fix.txt": "fixed\n" });
		assert.equal(await pushedWork(r.session, { workspace: w.dir, taskId: "task_1", baseSha: w.baseSha }), undefined, "nothing recorded yet");
		await r.finalize(w.dir, w);
		assert.ok(await pushedWork(r.session, { workspace: w.dir, taskId: "task_1", baseSha: w.baseSha }));
		assert.equal(await pushedWork(r.session, { workspace: w.dir, taskId: "task_2", baseSha: w.baseSha }), undefined, "another task");
		writeFileSync(join(w.dir, "later.txt"), "x\n");
		sh(w.dir, "add", "-A");
		commitAt(w.dir, "later");
		assert.equal(await pushedWork(r.session, { workspace: w.dir, taskId: "task_1", baseSha: w.baseSha }), undefined, "HEAD moved on");
	});

	it("is not reported when the remote branch no longer points at the recorded commit", async () => {
		const r = rig();
		const w = await r.work({ "fix.txt": "fixed\n" });
		await r.finalize(w.dir, w);
		sh(r.remote, "update-ref", "-d", `refs/heads/${BRANCH}`);
		assert.equal(await pushedWork(r.session, { workspace: w.dir, taskId: "task_1", baseSha: w.baseSha }), undefined);
	});
});

describe("the handler's retry of a task whose pull request is the only thing missing", () => {
	const profile: AgentProfile = {
		id: "t",
		capabilities: [{ id: "code.fix", version: "1" }],
		approvalPatterns: [],
		defaultBudget: { maxTokens: 1000, maxMinutes: 1 },
		git: { push: true, pullRequest: true, branchPrefix: "agent" },
		skills: { allow: [] },
	};
	const control = (): JobControl => ({ signal: new AbortController().signal, progress: () => undefined, requestInput: async () => ({ approved: false }) }) as unknown as JobControl;

	function handlerFor(r: Rig, host: GitHost, hooks: Record<string, unknown>) {
		const calls = { model: 0, resume: 0 };
		const runtime: AgentRuntime = {
			start: async () => undefined,
			health: () => ({ ready: true }),
			close: async () => undefined,
			execute: async (request) => {
				calls.model += 1;
				writeFileSync(join(request.workspace, "fix.txt"), "fixed\n");
				return { status: "done", answer: "FIXED: by the model", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: 0 } };
			},
		};
		const handler = createHandler({
			runtime,
			session: r.session,
			host,
			workspaceRoot: join(r.root, "handler-ws"),
			client: { uploadArtifact: async () => ({}) as never },
			limits: { maxTokensCap: 1_000_000, maxMinutesCap: 60 },
			profile,
			hooks: {
				branchName: ({ taskId }) => `agent/${taskId}-fix`,
				resume: ({ branch }) => {
					calls.resume += 1;
					return { answer: `FIXED: recovered from ${branch}` };
				},
				...hooks,
			},
		});
		const job = (taskId: string): Job => ({ taskId, capability: { id: "code.fix", version: 1 }, input: { repository: { url: r.remote, ref: "HEAD" }, budget: { maxTokens: 1000, maxMinutes: 1 }, instruction: "fix" }, task: {} }) as unknown as Job;
		return { calls, run: (taskId: string) => handler(job(taskId), control()) };
	}

	it("opens the pull request without running the model again", async () => {
		const r = rig();
		const host = new FlakyHost();
		host.failCreate = 1;
		const h = handlerFor(r, host, {});
		const first = await h.run("t1");
		assert.equal(first.type, "failed");
		assert.equal((first as any).failure.retryable, true, "a failed pull request is retried");
		assert.equal(h.calls.model, 1);
		const pushed = r.tip("agent/t1-fix")!;
		assert.ok(pushed);

		const second = await h.run("t1");
		assert.equal(second.type, "completed", JSON.stringify(second));
		assert.equal(h.calls.model, 1, "no second model run");
		assert.equal(h.calls.resume, 1);
		assert.equal((second as any).result.prUrl, "https://example.test/pr/agent/t1-fix");
		assert.equal((second as any).result.branch, "agent/t1-fix");
		assert.equal(r.tip("agent/t1-fix"), pushed, "nothing was pushed again");
		assert.equal(host.created.length, 1);
	});

	it("runs the model as usual when the role does not offer to resume, and the retry still finds the pushed branch", async () => {
		const r = rig();
		const host = new FlakyHost();
		host.failCreate = 1;
		const h = handlerFor(r, host, { resume: undefined });
		assert.equal((await h.run("t2")).type, "failed");
		const pushed = r.tip("agent/t2-fix")!;
		const second = await h.run("t2");
		assert.equal(second.type, "completed");
		assert.equal(h.calls.model, 2, "the model ran again");
		assert.equal(r.tip("agent/t2-fix"), pushed, "but the branch was reused, not pushed over");
		assert.equal(host.created.length, 1);
	});

	it("does not resume when a pull request already exists, or the role declines", async () => {
		const r = rig();
		const host = new FlakyHost();
		const h = handlerFor(r, host, {});
		assert.equal((await h.run("t3")).type, "completed");
		assert.equal((await h.run("t3")).type, "completed");
		assert.equal(h.calls.resume, 0, "a pull request existed, so there was nothing to resume");
		const declining = handlerFor(r, host, { resume: () => undefined });
		host.failCreate = 0;
		assert.equal((await declining.run("t4")).type, "completed");
	});

	it("fails without retrying when every branch name is taken by different work", async () => {
		const r = rig();
		for (let i = 0; i < MAX_BRANCH_SUFFIX; i++) {
			const w = await r.work({ "fix.txt": `other ${i}\n` }, { branch: "agent/t5-fix" });
			await r.finalize(w.dir, w, new FakeHost(), { branch: "agent/t5-fix" });
		}
		const h = handlerFor(r, new FakeHost(), { resume: undefined });
		const done = await h.run("t5");
		assert.equal(done.type, "failed");
		assert.equal((done as any).failure.code, "branch_exhausted");
		assert.equal((done as any).failure.retryable, false);
	});
});

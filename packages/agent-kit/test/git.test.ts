import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, describe, it } from "node:test";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { branchFor, finalizeWorkspace, GitError, prepareWorkspace, workspaceFor, type GitSession } from "../src/git.ts";
import type { GitHost } from "../src/githost.ts";

const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });

let remote: string;
let root: string;
let session: GitSession;

class FakeHost implements GitHost {
	created: { head: string; base: string; title: string }[] = [];
	async findPullRequest(query: { head: string }) {
		return this.created.some((pr) => pr.head === query.head) ? { url: `https://example.test/pr/${query.head}` } : undefined;
	}
	async createPullRequest(request: { head: string; base: string; title: string }) {
		this.created.push({ head: request.head, base: request.base, title: request.title });
		return { url: `https://example.test/pr/${request.head}` };
	}
}

before(() => {
	root = mkdtempSync(join(tmpdir(), "git-root-"));
	remote = join(root, "remote.git");
	sh(root, "init", "--bare", "-b", "main", remote);
	const seed = join(root, "seed");
	sh(root, "clone", remote, seed);
	writeFileSync(join(seed, "README.md"), "hello\n");
	sh(seed, "add", "-A");
	sh(seed, "commit", "-m", "seed");
	sh(seed, "push", "origin", "HEAD:main");
	session = { env: new NodeExecutionEnv({ cwd: root }), identity: { name: "SomeWork Pi", email: "pi@somework.invalid" } };
});

const params = (taskId: string, workspace: string) => ({ repoUrl: remote, ref: "main", taskId, workspace });

describe("git workflow", () => {
	it("prepares a branch, finalizes it into one commit, one push and one pull request", async () => {
		const workspace = workspaceFor(join(root, "ws"), "repo#1");
		const host = new FakeHost();
		await prepareWorkspace(session, params("task_A", workspace));
		assert.equal(sh(workspace, "rev-parse", "--abbrev-ref", "HEAD").trim(), "agent/task_A");
		writeFileSync(join(workspace, "feature.txt"), "new\n");
		const result = await finalizeWorkspace(session, host, { ...params("task_A", workspace), title: "add feature", body: "by the agent" });
		assert.equal(result.status, "completed");
		assert.equal(result.branch, branchFor("task_A"));
		assert.equal(result.commits.length, 1);
		assert.equal(result.prUrl, "https://example.test/pr/agent/task_A");
		assert.match(result.patch, /feature\.txt/);
		assert.equal(sh(remote, "rev-parse", "refs/heads/agent/task_A").trim(), result.commits[0]);
		assert.equal(host.created.length, 1);
	});

	it("repeating finalize after a crash changes nothing: no second commit, no second pull request", async () => {
		const workspace = workspaceFor(join(root, "ws"), "repo#1");
		const host = new FakeHost();
		await prepareWorkspace(session, params("task_B", workspace));
		writeFileSync(join(workspace, "b.txt"), "b\n");
		const first = await finalizeWorkspace(session, host, { ...params("task_B", workspace), title: "b", body: "" });
		const second = await finalizeWorkspace(session, host, { ...params("task_B", workspace), title: "b", body: "" });
		assert.deepEqual(second.commits, first.commits);
		assert.equal(second.prUrl, first.prUrl);
		assert.equal(host.created.length, 1, "the existing pull request is found, not created again");
	});

	it("a retry of prepare keeps work in progress on the task's branch", async () => {
		const workspace = workspaceFor(join(root, "ws"), "repo#2");
		await prepareWorkspace(session, params("task_C", workspace));
		writeFileSync(join(workspace, "wip.txt"), "unfinished\n");
		await prepareWorkspace(session, params("task_C", workspace));
		assert.ok(existsSync(join(workspace, "wip.txt")), "uncommitted work survives a re-prepare");
		assert.equal(readFileSync(join(workspace, "wip.txt"), "utf8"), "unfinished\n");
	});

	it("a later task on the same key starts fresh from the base ref", async () => {
		const workspace = workspaceFor(join(root, "ws"), "repo#3");
		await prepareWorkspace(session, params("task_D1", workspace));
		writeFileSync(join(workspace, "d1.txt"), "d1\n");
		await finalizeWorkspace(session, new FakeHost(), { ...params("task_D1", workspace), title: "d1", body: "" });
		await prepareWorkspace(session, params("task_D2", workspace));
		assert.ok(!existsSync(join(workspace, "d1.txt")), "the next task does not inherit the previous task's changes");
	});

	it("reports no_changes without pushing or opening a pull request", async () => {
		const workspace = workspaceFor(join(root, "ws"), "repo#4");
		const host = new FakeHost();
		await prepareWorkspace(session, params("task_E", workspace));
		const result = await finalizeWorkspace(session, host, { ...params("task_E", workspace), title: "nothing", body: "" });
		assert.equal(result.status, "no_changes");
		assert.equal(host.created.length, 0);
		assert.throws(() => sh(remote, "rev-parse", "--verify", "refs/heads/agent/task_E"));
	});

	it("never leaks the token into an error message", async () => {
		const workspace = workspaceFor(join(root, "ws"), "repo#5");
		const secret = "ghp_supersecrettoken123";
		const withToken: GitSession = { ...session, token: secret };
		await assert.rejects(
			() => prepareWorkspace(withToken, { repoUrl: `https://x-access-token:${secret}@127.0.0.1:1/nope.git`, ref: "main", taskId: "task_F", workspace }),
			(error: unknown) => error instanceof GitError && !error.message.includes(secret),
		);
	});
});

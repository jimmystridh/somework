import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, describe, it } from "node:test";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { branchFor, finalizeWorkspace, GitError, prepareWorkspace, tokenForCommand, workspaceFor, type GitSession } from "../src/git.ts";
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
	it("asks the token source before authenticated commands and scrubs whatever it returned", async () => {
		const workspace = workspaceFor(join(root, "ws"), "repo#6");
		let asked = 0;
		const withSource: GitSession = { ...session, tokenSource: async () => `ghs_rotating_${++asked}` };
		await prepareWorkspace(withSource, params("task_G", workspace));
		assert.ok(asked > 0, "the source was used");
		assert.equal(withSource.token, `ghs_rotating_${asked}`, "the latest token is kept for scrubbing");
		const failing: GitSession = { ...session, tokenSource: async () => "ghs_rotating_secret" };
		await assert.rejects(
			() => prepareWorkspace(failing, { repoUrl: "https://ghs_rotating_secret@127.0.0.1:1/nope.git", ref: "main", taskId: "task_H", workspace: workspaceFor(join(root, "ws"), "repo#7") }),
			(error: unknown) => error instanceof GitError && !error.message.includes("ghs_rotating_secret"),
		);
	});
});

describe("a token per repository owner", () => {
	const envWith = (originUrl: string | undefined) =>
		({ exec: async (command: string, options: { onOutput?: (text: string) => void }) => {
			if (command === "git remote get-url origin" && originUrl) options.onOutput?.(`${originUrl}\n`);
			return { ok: true, value: { exitCode: command === "git remote get-url origin" && !originUrl ? 2 : 0 } };
		} }) as unknown as GitSession["env"];
	const sessionFor = (originUrl?: string): GitSession => ({ env: envWith(originUrl), token: "default-token", ownerTokens: { jimmystridh: "personal-token" }, identity: { name: "t", email: "t@t" } });

	it("uses the owner's token for a clone of that owner's repository, whatever the case of the name", async () => {
		assert.equal(await tokenForCommand(sessionFor(), "/ws", ["clone", "https://github.com/JimmyStridh/somework.git", "."]), "personal-token");
	});
	it("finds the owner from the checkout's origin for fetch and push", async () => {
		assert.equal(await tokenForCommand(sessionFor("https://github.com/jimmystridh/somework.git"), "/ws", ["push", "origin", "HEAD:refs/heads/agent/x"]), "personal-token");
		assert.equal(await tokenForCommand(sessionFor("https://github.com/Visma-Administration/visma.administration.git"), "/ws", ["fetch", "origin"]), "default-token");
	});
	it("falls back to the session's token when the origin is unknown, and works without any owner token", async () => {
		assert.equal(await tokenForCommand(sessionFor(undefined), "/ws", ["fetch", "origin"]), "default-token");
		assert.equal(await tokenForCommand({ ...sessionFor(), ownerTokens: undefined }, "/ws", ["clone", "https://github.com/jimmystridh/somework.git"]), "default-token");
	});
});

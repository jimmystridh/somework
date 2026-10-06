import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, describe, it } from "node:test";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { loadConfig } from "../src/config.ts";
import { finalizeWorkspace, GitError, mirrorPathFor, prepareWorkspace, refreshMirror, startMirrorRefresh, workspaceFor, type GitSession } from "../src/git.ts";
import { FakeHost } from "../src/testing.ts";

const identity = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...identity } });

let root: string;
let remote: string;
let seed: string;
let session: GitSession;

const pushFile = (name: string, content: string, branch = "main"): string => {
	writeFileSync(join(seed, name), content);
	sh(seed, "add", "-A");
	sh(seed, "commit", "-m", `add ${name}`);
	sh(seed, "push", "origin", `HEAD:${branch}`);
	return sh(seed, "rev-parse", "HEAD").trim();
};

before(() => {
	root = mkdtempSync(join(tmpdir(), "mirror-"));
	remote = join(root, "remote.git");
	sh(root, "init", "--bare", "-b", "main", remote);
	seed = join(root, "seed");
	sh(root, "clone", remote, seed);
	writeFileSync(join(seed, "README.md"), "hello\n");
	sh(seed, "add", "-A");
	sh(seed, "commit", "-m", "seed");
	sh(seed, "push", "origin", "HEAD:main");
	sh(seed, "tag", "v1");
	sh(seed, "push", "origin", "v1");
	session = { env: new NodeExecutionEnv({ cwd: root }), identity: { name: "t", email: "t@t" }, mirrorDir: join(root, "mirrors") };
});

describe("persistent mirror", () => {
	it("creates a bare mirror of branches and tags with HEAD on the default branch, and brings it up to date", async () => {
		const dir = await refreshMirror(session, remote);
		assert.equal(dir, mirrorPathFor(session.mirrorDir!, remote));
		assert.equal(sh(dir, "rev-parse", "--is-bare-repository").trim(), "true");
		assert.equal(sh(dir, "symbolic-ref", "HEAD").trim(), "refs/heads/main");
		assert.match(sh(dir, "tag", "--list"), /v1/);
		const second = pushFile("second.txt", "two\n");
		sh(seed, "push", "origin", "HEAD:refs/heads/side");
		await refreshMirror(session, remote);
		assert.equal(sh(dir, "rev-parse", "refs/heads/main").trim(), second);
		assert.equal(sh(dir, "rev-parse", "refs/heads/side").trim(), second);
		sh(seed, "push", "origin", ":refs/heads/side");
		await refreshMirror(session, remote);
		assert.throws(() => sh(dir, "rev-parse", "--verify", "--quiet", "refs/heads/side"), "a branch deleted on the remote is pruned");
	});

	it("does not mirror the remote's pull request refs", async () => {
		sh(seed, "push", "origin", "HEAD:refs/pull/7/head");
		const dir = await refreshMirror(session, remote);
		assert.equal(sh(dir, "for-each-ref", "refs/pull").trim(), "");
	});

	it("clones a workspace from the mirror, then points origin back at the real remote", async () => {
		const workspace = workspaceFor(join(root, "ws"), "from-mirror");
		const prepared = await prepareWorkspace(session, { repoUrl: remote, ref: "main", taskId: "task_M", workspace });
		assert.match(sh(workspace, "reflog", "--all", "--format=%gs", "-n", "50"), /clone: from .*mirrors\/[0-9a-f]{16}\.git/, "the clone came from the mirror");
		assert.equal(sh(workspace, "remote", "get-url", "origin").trim(), remote);
		assert.equal(prepared.baseSha, sh(remote, "rev-parse", "refs/heads/main").trim());
		assert.equal(prepared.branch, "agent/task_M");
	});

	it("is current at the moment of the task: a commit pushed after the last refresh is in the workspace", async () => {
		await refreshMirror(session, remote);
		const latest = pushFile("late.txt", "late\n");
		const workspace = workspaceFor(join(root, "ws"), "fresh");
		const prepared = await prepareWorkspace(session, { repoUrl: remote, ref: "main", taskId: "task_F", workspace });
		assert.equal(prepared.baseSha, latest);
		assert.ok(existsSync(join(workspace, "late.txt")));
	});

	it("serves concurrent tasks without corrupting the mirror", async () => {
		const results = await Promise.all(
			["a", "b", "c", "d"].map((name) => prepareWorkspace(session, { repoUrl: remote, ref: "main", taskId: `task_${name}`, workspace: workspaceFor(join(root, "ws"), `concurrent-${name}`) })),
		);
		assert.equal(new Set(results.map((r) => r.baseSha)).size, 1);
		sh(mirrorPathFor(session.mirrorDir!, remote), "fsck", "--no-progress");
	});

	it("refuses a mirror call when no mirror directory is configured", async () => {
		await assert.rejects(refreshMirror({ ...session, mirrorDir: undefined }, remote), GitError);
	});

	it("refreshes on a timer round and reports it, without the token or credentials in the log", async () => {
		const events: { event: string; fields: Record<string, unknown> }[] = [];
		const stop = new AbortController();
		startMirrorRefresh({ session: { ...session, token: "secret-token-value" }, repositories: [remote, join(root, "missing.git")], everyMinutes: 60, signal: stop.signal, log: (_level, event, fields) => events.push({ event, fields }) });
		for (let i = 0; i < 100 && events.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 100));
		stop.abort();
		assert.equal(events.find((e) => e.event === "mirror_refreshed")?.fields.repository, remote.replace(/\.git$/, ""));
		const failed = events.find((e) => e.event === "mirror_refresh_failed");
		assert.ok(failed, "a repository that cannot be fetched is reported, not thrown");
		assert.ok(!JSON.stringify(events).includes("secret-token-value"));
	});
});

describe("resolving HEAD", () => {
	it("means the remote's default branch, which becomes the pull request base", async () => {
		const workspace = workspaceFor(join(root, "ws"), "head-ref");
		const prepared = await prepareWorkspace(session, { repoUrl: remote, ref: "HEAD", taskId: "task_H", workspace });
		assert.equal(prepared.baseBranch, "main");
		assert.equal(prepared.refKind, "branch");
		assert.equal(prepared.baseSha, sh(remote, "rev-parse", "refs/heads/main").trim());
	});
});

describe("a role's own branch name and commit message", () => {
	it("names the branch from the commit the work starts from and uses the role's commit message", async () => {
		const workspace = workspaceFor(join(root, "ws"), "named");
		const host = new FakeHost();
		const prepared = await prepareWorkspace(session, { repoUrl: remote, ref: "HEAD", taskId: "task_N", workspace, branch: ({ sha }) => `agent/aikido-123-${sha.slice(0, 8)}` });
		assert.equal(prepared.branch, `agent/aikido-123-${prepared.baseSha.slice(0, 8)}`);
		writeFileSync(join(workspace, "fix.txt"), "fixed\n");
		const done = await finalizeWorkspace(session, host, {
			repoUrl: remote,
			ref: "HEAD",
			taskId: "task_N",
			workspace,
			title: "fix",
			body: "body",
			baseSha: prepared.baseSha,
			baseBranch: prepared.baseBranch,
			branch: prepared.branch,
			commitMessage: "fix(security): bump lodash (Aikido #123)\n\nAikido issue 123, severity high.",
		});
		assert.equal(done.branch, prepared.branch);
		assert.equal(host.created[0]!.head, prepared.branch);
		assert.equal(sh(remote, "log", "-1", "--format=%s", prepared.branch).trim(), "fix(security): bump lodash (Aikido #123)");
		assert.match(sh(remote, "log", "-1", "--format=%b", prepared.branch), /Aikido issue 123/);
	});

	it("refuses a branch name outside the role's prefix or with an unsafe shape", async () => {
		for (const name of ["main", "other/x", "agent/../main", "agent//x", "agent/x.lock", "agent/x y", "agent/"]) {
			const workspace = workspaceFor(join(root, "ws"), `bad-${name}`);
			await assert.rejects(prepareWorkspace(session, { repoUrl: remote, ref: "HEAD", taskId: "task_B", workspace, branch: name }), /not an allowed branch name/, name);
		}
	});

	it("without a name function behaves as before: agent/<taskId>", async () => {
		const workspace = workspaceFor(join(root, "ws"), "default-name");
		const prepared = await prepareWorkspace({ ...session, mirrorDir: undefined }, { repoUrl: remote, ref: "main", taskId: "task_D", workspace });
		assert.equal(prepared.branch, "agent/task_D");
	});
});

describe("mirror settings", () => {
	const base = { SOMEWORK_URL: "https://x", SOMEWORK_KEY_FILE: "/k", SANDBOX_URL: "http://s" };
	it("are off unless GIT_MIRROR_DIR is set, and read the repositories and the interval", () => {
		assert.equal(loadConfig(base).git.mirror, undefined);
		const on = loadConfig({ ...base, GIT_MIRROR_DIR: "/workspace/.mirrors", GIT_MIRROR_REPOS: "https://a/x.git, https://b/y.git", GIT_MIRROR_REFRESH_MINUTES: "15" }).git.mirror;
		assert.deepEqual(on, { dir: "/workspace/.mirrors", repositories: ["https://a/x.git", "https://b/y.git"], refreshMinutes: 15 });
		assert.equal(loadConfig({ ...base, GIT_MIRROR_DIR: "/m" }).git.mirror?.refreshMinutes, 30);
		assert.throws(() => loadConfig({ ...base, GIT_MIRROR_DIR: "/m", GIT_MIRROR_REFRESH_MINUTES: "0" }), /GIT_MIRROR_REFRESH_MINUTES/);
	});
});

describe("GITHUB_API", () => {
	const base = { SOMEWORK_URL: "https://x", SOMEWORK_KEY_FILE: "/k", SANDBOX_URL: "http://s" };
	it("treats an empty value (a compose default) as unset", () => {
		assert.equal(loadConfig({ ...base, GITHUB_API: "" }).git.githubApi, undefined);
		assert.equal(loadConfig({ ...base, GITHUB_API: "https://ghe.example/api/v3" }).git.githubApi, "https://ghe.example/api/v3");
	});
	it("falls back to api.github.com when the host client gets an empty base", async () => {
		const { GitHubHost } = await import("../src/githost.ts");
		const seen: string[] = [];
		const host = new GitHubHost({ token: "t", apiBase: "", fetch: (async (url: string) => { seen.push(url); return new Response("[]", { status: 200 }); }) as typeof fetch });
		await host.findPullRequest({ repoUrl: "https://github.com/o/r.git", head: "agent/x" });
		assert.equal(seen.length, 1);
		assert.ok(seen[0].startsWith("https://api.github.com/repos/o/r/pulls"), seen[0]);
	});
});

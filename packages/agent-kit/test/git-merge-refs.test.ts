import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, describe, it } from "node:test";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { GitError, mergeRefsInto, prepareWorkspace, type GitSession } from "../src/git.ts";

const identity = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...identity } });

let root: string;
let remote: string;
let seed: string;
let session: GitSession;
let workspace: string;

/** Publishes a change as the head of `refs/pull/<number>/head`, the way the code host does for a pull request. */
function openPull(number: number, files: Record<string, string>): string {
	sh(seed, "checkout", "-q", "-B", `pr-${number}`, "origin/main");
	for (const [name, content] of Object.entries(files)) writeFileSync(join(seed, name), content);
	sh(seed, "add", "-A");
	sh(seed, "commit", "-m", `pull ${number}`);
	sh(seed, "push", "origin", `HEAD:refs/pull/${number}/head`);
	return sh(seed, "rev-parse", "HEAD").trim();
}

before(async () => {
	root = mkdtempSync(join(tmpdir(), "merge-refs-"));
	remote = join(root, "remote.git");
	sh(root, "init", "--bare", "-b", "main", remote);
	seed = join(root, "seed");
	sh(root, "clone", remote, seed);
	writeFileSync(join(seed, "shared.txt"), "base\n");
	sh(seed, "add", "-A");
	sh(seed, "commit", "-m", "seed");
	sh(seed, "push", "origin", "HEAD:main");
	sh(seed, "fetch", "origin");
	session = { env: new NodeExecutionEnv({ cwd: root }), identity: { name: "t", email: "t@t" } };
	workspace = join(root, "workspace");
	await prepareWorkspace(session, { repoUrl: remote, ref: "main", taskId: "t1", workspace, detach: true });
});

describe("mergeRefsInto", () => {
	it("merges a front-end and a back-end pull request into the checkout, locally", async () => {
		openPull(1, { "front.txt": "front\n" });
		openPull(2, { "back.txt": "back\n" });
		const result = await mergeRefsInto(session, workspace, ["pull/1/head", "pull/2/head"]);
		assert.equal(result.conflict, undefined);
		assert.deepEqual(result.merged.map((item) => item.ref), ["pull/1/head", "pull/2/head"]);
		assert.ok(existsSync(join(workspace, "front.txt")) && existsSync(join(workspace, "back.txt")));
		assert.equal(result.head, sh(workspace, "rev-parse", "HEAD").trim());
		assert.equal(sh(remote, "rev-parse", "main").trim(), sh(seed, "rev-parse", "origin/main").trim(), "nothing was pushed");
	});

	it("reports a conflict, names the files and leaves the checkout where it was", async () => {
		openPull(3, { "shared.txt": "three\n" });
		openPull(4, { "shared.txt": "four\n" });
		await prepareWorkspace(session, { repoUrl: remote, ref: "main", taskId: "t1", workspace, detach: true });
		sh(workspace, "checkout", "-q", "--force", "--detach", "origin/main");
		const before = sh(workspace, "rev-parse", "HEAD").trim();
		const result = await mergeRefsInto(session, workspace, ["pull/3/head", "pull/4/head"]);
		assert.equal(result.conflict?.ref, "pull/4/head");
		assert.deepEqual(result.conflict?.files, ["shared.txt"]);
		assert.deepEqual(result.merged, []);
		assert.equal(sh(workspace, "rev-parse", "HEAD").trim(), before);
		assert.equal(readFileSync(join(workspace, "shared.txt"), "utf8"), "base\n");
		assert.equal(sh(workspace, "status", "--porcelain").trim(), "");
	});

	it("takes only pull request heads and commit ids, never a branch name or an option", async () => {
		for (const ref of ["main", "--upload-pack=x", "pull/1/merge", "refs/heads/main", "pull/0/head"]) {
			await assert.rejects(() => mergeRefsInto(session, workspace, [ref]), GitError);
		}
	});
});

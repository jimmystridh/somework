import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, describe, it } from "node:test";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { finalizeWorkspace, prepareWorkspace, RefNotFoundError, workspaceFor, type GitSession } from "../src/git.ts";
import { FakeHost, sh } from "../src/testing.ts";

/** A remote with: main (c1, c2), tag v1 = c1, a feature branch, refs/pull/1/head (a branch tip), refs/pull/2/head (reachable from no branch or tag). */
let remote: string;
let root: string;
let session: GitSession;
const shas: Record<string, string> = {};

before(() => {
	root = mkdtempSync(join(tmpdir(), "refs-root-"));
	remote = join(root, "remote.git");
	sh(root, "init", "--bare", "-b", "main", remote);
	const seed = join(root, "seed");
	sh(root, "clone", remote, seed);
	const commit = (file: string, text: string) => {
		writeFileSync(join(seed, file), text);
		sh(seed, "add", "-A");
		sh(seed, "commit", "-m", `add ${file}`);
		return sh(seed, "rev-parse", "HEAD").trim();
	};
	shas.c1 = commit("one.txt", "1\n");
	sh(seed, "tag", "v1");
	shas.c2 = commit("two.txt", "2\n");
	sh(seed, "push", "origin", "HEAD:main", "--tags");
	sh(seed, "checkout", "-b", "feature");
	shas.feature = commit("feature.txt", "f\n");
	sh(seed, "push", "origin", "feature");
	sh(seed, "push", "origin", "feature:refs/pull/1/head");
	sh(seed, "checkout", "--detach", shas.c2);
	shas.loose = commit("loose.txt", "l\n");
	sh(seed, "push", "origin", "HEAD:refs/pull/2/head");
	session = { env: new NodeExecutionEnv({ cwd: root }), identity: { name: "Kit", email: "kit@test.invalid" } };
});

let counter = 0;
const params = (ref: string, extra: Record<string, unknown> = {}) => {
	const n = counter++;
	return { repoUrl: `file://${remote}`, ref, taskId: `task_${n}`, workspace: workspaceFor(join(root, "ws"), `key#${n}`), ...extra };
};
const head = (workspace: string) => sh(workspace, "rev-parse", "HEAD").trim();
const branch = (workspace: string) => sh(workspace, "rev-parse", "--abbrev-ref", "HEAD").trim();

describe("checkout by any ref", () => {
	it("a branch: the work starts from its tip and the pull request targets it", async () => {
		const p = params("feature");
		const prepared = await prepareWorkspace(session, p);
		assert.deepEqual([prepared.baseSha, prepared.baseBranch, prepared.refKind, prepared.detached], [shas.feature, "feature", "branch", false]);
		assert.equal(head(p.workspace), shas.feature);
		assert.equal(branch(p.workspace), p.taskId.replace(/^/, "agent/"));
	});

	it("a tag: resolves to the tagged commit and targets the remote's default branch", async () => {
		const p = params("v1");
		const prepared = await prepareWorkspace(session, p);
		assert.deepEqual([prepared.baseSha, prepared.baseBranch, prepared.refKind], [shas.c1, "main", "tag"]);
		assert.ok(!existsSync(join(p.workspace, "two.txt")), "the checkout is at the tag, not at main");
	});

	it("a full commit SHA, with an explicit base branch", async () => {
		const p = params(shas.c1, { baseRef: "feature" });
		const prepared = await prepareWorkspace(session, p);
		assert.deepEqual([prepared.baseSha, prepared.baseBranch, prepared.refKind], [shas.c1, "feature", "commit"]);
	});

	it("an abbreviated SHA that is reachable from a branch", async () => {
		const prepared = await prepareWorkspace(session, params(shas.c2!.slice(0, 8)));
		assert.deepEqual([prepared.baseSha, prepared.baseBranch, prepared.refKind], [shas.c2, "main", "commit"]);
	});

	it("a pull request head", async () => {
		const p = params("refs/pull/1/head");
		const prepared = await prepareWorkspace(session, p);
		assert.deepEqual([prepared.baseSha, prepared.baseBranch, prepared.refKind], [shas.feature, "main", "pull"]);
		assert.equal(head(p.workspace), shas.feature);
	});

	it("a commit that no branch or tag reaches is fetched by its exact SHA; a short SHA of it is refused with a hint", async () => {
		const prepared = await prepareWorkspace(session, params(shas.loose!));
		assert.deepEqual([prepared.baseSha, prepared.refKind], [shas.loose, "commit"]);
		await assert.rejects(
			() => prepareWorkspace(session, params(shas.loose!.slice(0, 10))),
			(error: unknown) => error instanceof RefNotFoundError && /use the full SHA/.test(error.message),
		);
	});

	it("an unknown ref names what was tried; a malformed or option-like ref never reaches git", async () => {
		await assert.rejects(() => prepareWorkspace(session, params("no-such-ref")), (error: unknown) => error instanceof RefNotFoundError && /not a branch, tag, commit or pull ref/.test(error.message));
		await assert.rejects(() => prepareWorkspace(session, params("0000000000000000000000000000000000000001")), RefNotFoundError);
		for (const bad of ["--upload-pack=touch /tmp/pwned", "a..b", "x y", "refs/pull/abc/head", ""]) {
			await assert.rejects(() => prepareWorkspace(session, params(bad)), RefNotFoundError, bad);
		}
	});

	it("a base branch that does not exist is refused", async () => {
		await assert.rejects(() => prepareWorkspace(session, params("v1", { baseRef: "nope" })), (error: unknown) => error instanceof RefNotFoundError && /base branch "nope"/.test(error.message));
	});

	it("a read-only role gets the commit checked out detached, and a retry changes nothing", async () => {
		const p = params("v1", { detach: true });
		const first = await prepareWorkspace(session, p);
		assert.equal(first.detached, true);
		assert.equal(branch(p.workspace), "HEAD", "detached");
		assert.equal(head(p.workspace), shas.c1);
		writeFileSync(join(p.workspace, "scratch.txt"), "notes\n");
		const second = await prepareWorkspace(session, p);
		assert.equal(second.baseSha, first.baseSha);
		assert.ok(existsSync(join(p.workspace, "scratch.txt")), "already at the commit: nothing is touched");
	});

	it("a retry keeps work in progress on the task branch, for every kind of ref", async () => {
		for (const ref of ["main", "v1", shas.c2!, "refs/pull/1/head"]) {
			const p = params(ref);
			const first = await prepareWorkspace(session, p);
			writeFileSync(join(p.workspace, "wip.txt"), `wip on ${ref}\n`);
			const second = await prepareWorkspace(session, p);
			assert.equal(readFileSync(join(p.workspace, "wip.txt"), "utf8"), `wip on ${ref}\n`, ref);
			assert.equal(second.baseSha, first.baseSha, `the task's base is stable on retry (${ref})`);
		}
	});

	it("finalize measures the work from the base commit and opens the pull request against the base branch", async () => {
		const p = params("v1");
		const prepared = await prepareWorkspace(session, p);
		writeFileSync(join(p.workspace, "new.txt"), "n\n");
		const host = new FakeHost();
		const done = await finalizeWorkspace(session, host, { ...p, title: "t", body: "b", baseSha: prepared.baseSha, baseBranch: prepared.baseBranch });
		assert.equal(done.status, "completed");
		assert.equal(done.commits.length, 1, "only the agent's commit, not main's commits after the tag");
		assert.deepEqual([host.created[0]!.base, host.created[0]!.head], ["main", `agent/${p.taskId}`]);
		assert.match(done.patch, /new\.txt/);
		assert.doesNotMatch(done.patch, /two\.txt/);
		assert.equal(sh(remote, "rev-parse", `refs/heads/agent/${p.taskId}`).trim(), done.commits[0]);
	});

	it("a task branch that already has commits reports its real fork point as the base", async () => {
		const p = params("main");
		const first = await prepareWorkspace(session, p);
		writeFileSync(join(p.workspace, "w.txt"), "w\n");
		sh(p.workspace, "add", "-A");
		sh(p.workspace, "commit", "-m", "wip");
		const again = await prepareWorkspace(session, p);
		assert.equal(again.baseSha, first.baseSha);
		assert.notEqual(head(p.workspace), again.baseSha);
	});
});

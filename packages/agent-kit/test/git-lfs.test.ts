import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { prepareWorkspace } from "../src/git.ts";
import { makeRemote, sh } from "../src/testing.ts";

/** A stand-in for the LFS filter (named differently so a git-lfs installed on the machine does not take over) as git-lfs behaves when it cannot reach its server: it fails, unless told to leave pointer files alone. */
const FILTER = { GIT_CONFIG_COUNT: "3", GIT_CONFIG_KEY_0: "filter.stublfs.smudge", GIT_CONFIG_VALUE_0: 'test "$GIT_LFS_SKIP_SMUDGE" = 1 && cat', GIT_CONFIG_KEY_1: "filter.stublfs.required", GIT_CONFIG_VALUE_1: "true", GIT_CONFIG_KEY_2: "filter.stublfs.clean", GIT_CONFIG_VALUE_2: "cat" };

describe("a repository with Git LFS files", () => {
	const saved: Record<string, string | undefined> = {};
	before(() => {
		for (const [key, value] of Object.entries(FILTER)) {
			saved[key] = process.env[key];
			process.env[key] = value;
		}
	});
	after(() => {
		for (const [key, value] of Object.entries(saved)) value === undefined ? delete process.env[key] : (process.env[key] = value);
	});

	it("is cloned with the pointer files, instead of failing because the LFS server cannot be reached", async () => {
		const { dir, remote } = makeRemote();
		const seed = join(dir, "seed2");
		sh(dir, "clone", remote, seed);
		writeFileSync(join(seed, ".gitattributes"), "*.dat filter=stublfs -text\n");
		mkdirSync(join(seed, "Install_New"));
		writeFileSync(join(seed, "Install_New", "setup.dat"), "version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 3\n");
		sh(seed, "add", "-A");
		sh(seed, "commit", "-m", "add an lfs file");
		sh(seed, "push", "origin", "HEAD:main");
		assert.throws(() => execFileSync("git", ["clone", remote, join(dir, "plain")], { stdio: "pipe" }), /filter/i, "the stand-in filter fails like git-lfs does when it cannot reach its server");
		const root = mkdtempSync(join(tmpdir(), "lfs-ws-"));
		const workspace = join(root, "ws");
		const env = new NodeExecutionEnv({ cwd: root });
		await prepareWorkspace({ env, identity: { name: "t", email: "t@t" } }, { repoUrl: remote, ref: "HEAD", taskId: "task", workspace });
		assert.match(readFileSync(join(workspace, "Install_New", "setup.dat"), "utf8"), /git-lfs\.github\.com/);
	});
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
function git(args: string[]) {
	return spawnSync("git", args, { cwd: root, encoding: "utf8" });
}

test("every tracked gitlink has a submodule URL", () => {
	const index = git(["ls-files", "--stage", "-z"]);
	assert.equal(index.status, 0, index.stderr);
	const links = index.stdout.split("\0").filter(line => line.startsWith("160000 ")).map(line => line.split("\t")[1]!);
	if (links.length === 0) return;
	assert.ok(existsSync(`${root}.gitmodules`), "orphan gitlink: missing .gitmodules breaks the CI clone");
	const paths = git(["config", "--file", ".gitmodules", "--get-regexp", "^submodule\\..*\\.path$"]);
	assert.equal(paths.status, 0);
	for (const path of links) {
		const entry = paths.stdout.split("\n").find(line => line.slice(line.indexOf(" ") + 1) === path);
		assert.ok(entry, `unregistered gitlink: ${path}`);
		const key = entry.slice(0, entry.indexOf(" ")).replace(/\.path$/, ".url");
		const url = git(["config", "--file", ".gitmodules", "--get", key]);
		assert.equal(url.status, 0, `missing submodule URL for ${path}`);
		assert.ok(url.stdout.trim(), `empty submodule URL for ${path}`);
	}
});

test("Plane deployment is ordinary tracked code, not a nested checkout", () => {
	for (const path of ["deploy/plane/deploy.sh", "deploy/plane/compose.yaml", "deploy/plane/upstream/compose.yaml",
		"deploy/plane/generate-secrets.mjs", "deploy/plane/ingress/gateway.mjs", "deploy/plane/storage/s3-smoke.mjs"]) {
		const entry = git(["ls-files", "--stage", "--", path]);
		assert.equal(entry.status, 0);
		assert.match(entry.stdout, /^100(?:644|755) /, `${path} must survive a fresh CI clone`);
		assert.ok(existsSync(`${root}${path}`), `${path} must be checked out`);
	}
});

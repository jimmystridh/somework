import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitHost } from "../src/githost.ts";

const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
export const sh = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8", env });

/** A bare repository with one commit on `main`: the "remote" the agent clones and pushes to. */
export function makeRemote(): { dir: string; remote: string } {
	const dir = mkdtempSync(join(tmpdir(), "pi-remote-"));
	const remote = join(dir, "remote.git");
	sh(dir, "init", "--bare", "-b", "main", remote);
	const seed = join(dir, "seed");
	sh(dir, "clone", remote, seed);
	writeFileSync(join(seed, "README.md"), "hello\n");
	sh(seed, "add", "-A");
	sh(seed, "commit", "-m", "seed");
	sh(seed, "push", "origin", "HEAD:main");
	return { dir, remote };
}

export class FakeHost implements GitHost {
	created: { head: string; base: string; title: string }[] = [];
	async findPullRequest(query: { head: string }) {
		return this.created.some((pr) => pr.head === query.head) ? { url: `https://example.test/pr/${query.head}` } : undefined;
	}
	async createPullRequest(request: { head: string; base: string; title: string }) {
		this.created.push({ head: request.head, base: request.base, title: request.title });
		return { url: `https://example.test/pr/${request.head}` };
	}
}

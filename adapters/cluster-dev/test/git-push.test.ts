import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { makeRemote, sh } from "@somework/agent-kit/testing";
import { createGitPush } from "../src/tools/git-push.ts";
import { callTool } from "./support.ts";

const TOKEN = "ghs_abcdefghijklmnopqrstuvwxyz0123456789";

/** A real bare repository as the organisation's remote and a clone of it in the workspace, with an environment that records what it is asked to run. */
function world(over: { repositoryUrl?: string | undefined; token?: (() => Promise<string>) | undefined } = {}) {
	const { dir, remote } = makeRemote();
	const workspace = mkdtempSync(join(tmpdir(), "git-push-ws-"));
	const checkout = join(workspace, "repo");
	sh(workspace, "clone", remote, "repo");
	sh(checkout, "config", "user.name", "t");
	sh(checkout, "config", "user.email", "t@t");
	const inner = new NodeExecutionEnv({ cwd: workspace });
	const seen: { command: string; env?: Record<string, string>; cwd?: string }[] = [];
	const env = Object.assign(Object.create(inner), {
		cwd: workspace,
		exec: (command: string, options: any, context: unknown) => {
			seen.push({ command, env: options?.env, cwd: options?.cwd });
			return inner.exec(command, options, context as never);
		},
	});
	const tool = createGitPush({
		settings: { repositoryUrl: "repositoryUrl" in over ? over.repositoryUrl : `file://${remote}`, gitRemote: "org" },
		token: "token" in over ? over.token : async () => TOKEN,
		secrets: () => [TOKEN],
	});
	const commit = (name: string): string => {
		writeFileSync(join(checkout, `${name}.txt`), name);
		sh(checkout, "add", "-A");
		sh(checkout, "commit", "-m", name);
		return sh(checkout, "rev-parse", "HEAD").trim();
	};
	return { dir, remote, workspace, checkout, seen, commit, push: (args: Record<string, unknown>) => callTool(tool, args, { env }) };
}

const remoteSha = (remote: string, branch: string): string => sh(remote, "rev-parse", `refs/heads/${branch}`).trim();

describe("git_push", () => {
	it("pushes a branch of a checkout in the workspace to the configured repository", async () => {
		const { push, commit, remote } = world();
		const sha = commit("one");
		const { text, isError } = await push({ branch: "HEAD", to: "fix/thing", directory: "repo" });
		assert.equal(isError, false, text);
		assert.match(text, /pushed HEAD to org\/fix\/thing/);
		assert.equal(remoteSha(remote, "fix/thing"), sha);
	});

	it("pushes to main, which is what starts a deployment, and updates it with a fast-forward", async () => {
		const { push, commit, remote } = world();
		const first = commit("one");
		assert.equal((await push({ branch: "HEAD", to: "main", directory: "repo" })).isError, false);
		assert.equal(remoteSha(remote, "main"), first);
		const second = commit("two");
		assert.equal((await push({ to: "main", directory: "repo", branch: "main" })).isError, false);
		assert.equal(remoteSha(remote, "main"), second);
	});

	it("never forces: a push that is not a fast-forward fails and the remote keeps its history", async () => {
		const { push, commit, remote, checkout } = world();
		const first = commit("one");
		await push({ to: "main", directory: "repo" });
		sh(checkout, "reset", "--hard", "HEAD~1");
		commit("rewritten");
		const { text, isError } = await push({ to: "main", directory: "repo" });
		assert.equal(isError, true);
		assert.match(text, /the push failed/);
		assert.equal(remoteSha(remote, "main"), first);
	});

	it("hands the token to the one git command through its environment, never on the command line, and scrubs it from the answer", async () => {
		const { push, commit, seen } = world();
		commit("one");
		const { text } = await push({ to: "work", directory: "repo" });
		assert.equal(seen.length, 1);
		assert.ok(!seen[0]!.command.includes(TOKEN), "not in the command");
		assert.equal(seen[0]!.env?.GIT_TOKEN, TOKEN);
		assert.equal(seen[0]!.env?.GIT_TERMINAL_PROMPT, "0");
		assert.match(seen[0]!.command, /core\.hooksPath=\/dev\/null/, "repository hooks do not run with the token in the environment");
		assert.match(seen[0]!.command, /'credential\.helper=!f\(\)/);
		assert.match(seen[0]!.command, /'--no-verify'/);
		assert.ok(!text.includes(TOKEN));
		assert.doesNotMatch(seen[0]!.command, /--force|'-f'|--delete|--mirror|--tags|'\+/, "no force, no deletion, no tags, no plus refspec");
		assert.match(seen[0]!.command, /'HEAD:refs\/heads\/work'/);
	});

	it("scrubs a token that git prints", async () => {
		const leaky = createGitPush({ settings: { repositoryUrl: "https://github.com/acme/somework", gitRemote: "org" }, token: async () => TOKEN });
		const env = { cwd: "/workspace/w", exec: async (_command: string, options: any) => (options.onOutput(`fatal: unable to access 'https://x-access-token:${TOKEN}@github.com/x/y.git'`), { ok: true, value: { exitCode: 128 } }) };
		const { text, isError } = await callTool(leaky, { to: "main" }, { env });
		assert.equal(isError, true);
		assert.ok(!text.includes(TOKEN), text);
		assert.match(text, /the push failed \(exit 128\)/);
	});

	it("refuses names that are not plain branches, a directory outside the workspace and a missing setup", async () => {
		const { push, commit, seen } = world();
		commit("one");
		for (const args of [
			{ branch: "+main", to: "main" },
			{ branch: "main", to: ":main" },
			{ branch: "main", to: "refs/tags/v1" },
			{ branch: "main", to: "refs/heads/main" },
			{ branch: "main", to: "a..b" },
			{ branch: "main", to: "feature.lock" },
			{ branch: "main", to: "dir/" },
			{ branch: "a b", to: "main" },
			{ branch: "main", to: "main --force" },
			{ branch: "main", to: "-delete" },
			{ branch: "HEAD" },
			{ to: "main", directory: "/etc" },
			{ to: "main", directory: "../elsewhere" },
			{ to: "main", directory: "~/x" },
		]) {
			const { text, isError } = await push({ directory: "repo", ...args });
			assert.equal(isError, true, JSON.stringify(args));
			assert.match(text, /^refused:/, JSON.stringify(args));
		}
		assert.equal(seen.length, 0, "nothing ran");
		const noRepository = world({ repositoryUrl: undefined });
		assert.match((await noRepository.push({ to: "main" })).text, /no repository is configured/);
		const noToken = world({ token: undefined });
		assert.match((await noToken.push({ to: "main" })).text, /no credential to push with/);
		const noWorkspace = createGitPush({ settings: { repositoryUrl: "https://github.com/a/b", gitRemote: "org" }, token: async () => TOKEN });
		assert.match((await callTool(noWorkspace, { to: "main" }, {})).text, /no workspace/);
	});

	it("only ever pushes to the address in the settings: the model cannot name another repository or remote", async () => {
		const { push, commit, seen, remote } = world();
		commit("one");
		await push({ to: "main", directory: "repo", repo: "https://github.com/public/repo", remote: "origin" } as never);
		assert.equal(seen.length, 1);
		assert.match(seen[0]!.command, new RegExp(`'file://${remote.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}'`));
		assert.ok(!seen[0]!.command.includes("public/repo"));
		assert.ok(!seen[0]!.command.includes("origin"));
	});

	it("is not replayed after a crash, because a second push is a second effect", () => {
		assert.equal(createGitPush({ settings: { repositoryUrl: "https://github.com/a/b", gitRemote: "org" } }).replay, "unsafe");
	});
});

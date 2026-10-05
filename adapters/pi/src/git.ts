import { createHash } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { GitHost } from "./githost.ts";

const ctx = BACKGROUND_CONTEXT;
const MAX_PATCH_BYTES = 1024 * 1024;

export interface GitIdentity {
	name: string;
	email: string;
}

export interface GitSession {
	env: ExecutionEnv;
	/** Repository access token. It is passed only to the commands that need it, while no model tool is running. */
	token?: string;
	identity: GitIdentity;
}

const quote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;
const CREDENTIAL_HELPER = quote("credential.helper=!f() { echo username=x-access-token; echo password=$GIT_TOKEN; }; f");

/** Where an agent key's working copy lives. One workspace per key: follow-up tasks continue in the same checkout. */
export function workspaceFor(root: string, agentKey: string): string {
	return `${root.replace(/\/$/, "")}/${createHash("sha256").update(agentKey).digest("hex").slice(0, 16)}`;
}

export const branchFor = (taskId: string): string => `agent/${taskId}`;

export class GitError extends Error {
	override readonly name = "GitError";
	readonly code: number;
	constructor(message: string, code: number) {
		super(message);
		this.code = code;
	}
}

async function git(session: GitSession, cwd: string, args: string[], options: { allow?: number[]; auth?: boolean } = {}): Promise<{ code: number; output: string }> {
	const env: Record<string, string> = {
		GIT_TERMINAL_PROMPT: "0",
		GIT_AUTHOR_NAME: session.identity.name,
		GIT_AUTHOR_EMAIL: session.identity.email,
		GIT_COMMITTER_NAME: session.identity.name,
		GIT_COMMITTER_EMAIL: session.identity.email,
	};
	if (options.auth && session.token) env.GIT_TOKEN = session.token;
	const prefix = options.auth && session.token ? `-c ${CREDENTIAL_HELPER} ` : "";
	let output = "";
	const result = await session.env.exec(`git ${prefix}${args.map(quote).join(" ")}`, { cwd, env, timeout: 900, onOutput: (text) => (output += text) }, ctx);
	if (!result.ok) throw new GitError(`git ${args[0]} could not run: ${result.error.message}`, -1);
	const code = result.value.exitCode;
	if (code !== 0 && !(options.allow ?? []).includes(code)) throw new GitError(`git ${args[0]} failed (${code}): ${scrub(output, session.token).slice(-400)}`, code);
	return { code, output: scrub(output, session.token) };
}

const scrub = (text: string, token?: string): string => (token ? text.replaceAll(token, "***") : text);

/** Idempotent: a retry finds the clone and the task's branch and changes nothing, so work in progress is never disturbed. */
export async function prepareWorkspace(session: GitSession, params: { repoUrl: string; ref: string; taskId: string; workspace: string }): Promise<void> {
	const { env } = session;
	const made = await env.createDir(params.workspace, { recursive: true }, ctx);
	if (!made.ok) throw new GitError(`cannot create the workspace: ${made.error.message}`, -1);
	const cloned = await env.exists(`${params.workspace}/.git`, ctx);
	if (cloned.ok && cloned.value) await git(session, params.workspace, ["fetch", "--prune", "origin"], { auth: true });
	else await git(session, params.workspace, ["clone", params.repoUrl, "."], { auth: true });
	const branch = branchFor(params.taskId);
	const exists = (await git(session, params.workspace, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { allow: [1] })).code === 0;
	if (exists) await git(session, params.workspace, ["checkout", branch]);
	else await git(session, params.workspace, ["checkout", "-B", branch, `origin/${params.ref}`]);
}

export interface FinalizeResult {
	status: "completed" | "no_changes";
	branch: string;
	commits: string[];
	prUrl?: string;
	patch: string;
}

/** Commit what the agent changed, push the task's branch, open (or find) the pull request. Every step is safe to repeat. */
export async function finalizeWorkspace(
	session: GitSession,
	host: GitHost,
	params: { repoUrl: string; ref: string; taskId: string; workspace: string; title: string; body: string },
): Promise<FinalizeResult> {
	const branch = branchFor(params.taskId);
	const run = (args: string[], options?: { allow?: number[]; auth?: boolean }) => git(session, params.workspace, args, options);
	await run(["add", "-A"]);
	if ((await run(["diff", "--cached", "--quiet"], { allow: [1] })).code === 1) await run(["commit", "-m", `agent: ${params.title}`.slice(0, 120)]);
	const ahead = Number((await run(["rev-list", "--count", `origin/${params.ref}..HEAD`])).output.trim());
	if (ahead === 0) return { status: "no_changes", branch, commits: [], patch: "" };
	const commits = (await run(["rev-list", "--reverse", `origin/${params.ref}..HEAD`])).output.split("\n").filter(Boolean);
	await run(["push", "origin", `HEAD:refs/heads/${branch}`], { auth: true });
	let patch = (await run(["diff", `origin/${params.ref}...HEAD`])).output;
	if (Buffer.byteLength(patch) > MAX_PATCH_BYTES) patch = `${patch.slice(0, MAX_PATCH_BYTES)}\n[patch truncated at ${MAX_PATCH_BYTES} bytes]\n`;
	const existing = await host.findPullRequest({ repoUrl: params.repoUrl, head: branch });
	const pr = existing ?? (await host.createPullRequest({ repoUrl: params.repoUrl, head: branch, base: params.ref, title: params.title, body: params.body }));
	return { status: "completed", branch, commits, prUrl: pr?.url, patch };
}

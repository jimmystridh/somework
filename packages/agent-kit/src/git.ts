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
	/** Hosts the token may be sent to (the credential helper refuses every other host, including redirect targets). */
	tokenHosts?: string[];
	identity: GitIdentity;
	/**
	 * Directory (inside the environment) for persistent bare mirrors of the repositories the agent works on. When set, a workspace is
	 * cloned from the mirror, which is refreshed first, so a task transfers only what changed instead of the whole repository.
	 */
	mirrorDir?: string;
}

const quote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;
export const DEFAULT_TOKEN_HOSTS = ["github.com"];
/** Git calls the helper with `get` and the request on stdin (`host=...`); it answers only for hosts in $GIT_TOKEN_HOSTS. */
export const CREDENTIAL_HELPER_SCRIPT = 'f() { [ "$1" = get ] || exit 0; while IFS= read -r line; do case "$line" in host=*) host="${line#host=}";; "") break;; esac; done; case " $GIT_TOKEN_HOSTS " in *" $host "*) echo username=x-access-token; echo password=$GIT_TOKEN;; esac; }; f';
const CREDENTIAL_HELPER = quote(`credential.helper=!${CREDENTIAL_HELPER_SCRIPT}`);

/** Where an agent key's working copy lives. One workspace per key: follow-up tasks continue in the same checkout. */
export function workspaceFor(root: string, agentKey: string): string {
	return `${root.replace(/\/$/, "")}/${createHash("sha256").update(agentKey).digest("hex").slice(0, 16)}`;
}

export const DEFAULT_BRANCH_PREFIX = "agent";
export const branchFor = (taskId: string, prefix: string = DEFAULT_BRANCH_PREFIX): string => `${prefix}/${taskId}`;

/** Where the mirror of a repository lives under `mirrorDir`. */
export const mirrorPathFor = (mirrorDir: string, repoUrl: string): string => `${mirrorDir.replace(/\/$/, "")}/${createHash("sha256").update(repoUrl).digest("hex").slice(0, 16)}.git`;

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
	if (options.auth && session.token) {
		env.GIT_TOKEN = session.token;
		env.GIT_TOKEN_HOSTS = (session.tokenHosts ?? DEFAULT_TOKEN_HOSTS).join(" ");
	}
	const prefix = options.auth && session.token ? `-c ${CREDENTIAL_HELPER} ` : "";
	let output = "";
	const result = await session.env.exec(`git ${prefix}${args.map(quote).join(" ")}`, { cwd, env, timeout: 900, onOutput: (text) => (output += text) }, ctx);
	if (!result.ok) throw new GitError(`git ${args[0]} could not run: ${result.error.message}`, -1);
	const code = result.value.exitCode;
	if (code !== 0 && !(options.allow ?? []).includes(code)) throw new GitError(`git ${args[0]} failed (${code}): ${scrub(output, session.token).slice(-400)}`, code);
	return { code, output: scrub(output, session.token) };
}

const scrub = (text: string, token?: string): string => (token ? text.replaceAll(token, "***") : text);

/** The ref could not be resolved to a commit (unknown name, unreachable commit, malformed ref). Retrying will not help. */
export class RefNotFoundError extends GitError {
	override readonly name = "RefNotFoundError";
	constructor(message: string) {
		super(message, 128);
	}
}

export type RefKind = "branch" | "tag" | "commit" | "pull";

export interface PrepareParams {
	repoUrl: string;
	/** A branch, a tag, a full or abbreviated commit SHA, or `refs/pull/<n>/head`; `HEAD` means the remote's default branch. Handoffs between agents name a resolved SHA. */
	ref: string;
	taskId: string;
	workspace: string;
	branchPrefix?: string;
	/**
	 * Name of the task branch instead of `<branchPrefix>/<taskId>`: a name, or a function of the commit the work starts from. It must stay
	 * under `<branchPrefix>/` so a role can never write outside its own branches.
	 */
	branch?: string | ((resolved: { sha: string; kind: RefKind }) => string);
	/** Branch the pull request is opened against. Default: `ref` when it is a branch, otherwise the remote's default branch. */
	baseRef?: string;
	/** Check out the resolved commit detached instead of creating the task branch (read-only roles). */
	detach?: boolean;
}

export interface PreparedWorkspace {
	/** The commit the task's work starts from, as a full SHA. */
	baseSha: string;
	/** The task branch the work is on; empty for a detached (read-only) workspace. */
	branch: string;
	/** The branch a pull request targets. */
	baseBranch: string;
	refKind: RefKind;
	detached: boolean;
}

const PLAIN_REF = /^[A-Za-z0-9][A-Za-z0-9._/@+-]*$/;
const PULL_REF = /^refs\/pull\/(\d+)\/(head|merge)$/;
const SHA_PREFIX = /^[0-9a-f]{4,40}$/i;
const FULL_SHA = /^[0-9a-f]{40}$/i;

async function revParse(session: GitSession, workspace: string, name: string): Promise<string | undefined> {
	const result = await git(session, workspace, ["rev-parse", "--verify", "--quiet", `${name}^{commit}`], { allow: [1] });
	return result.code === 0 ? result.output.trim() || undefined : undefined;
}

/** Branch, tag, pull ref, or commit (fetched by exact SHA when it is not already in the clone) to a full commit SHA. */
async function resolveRef(session: GitSession, workspace: string, ref: string): Promise<{ sha: string; kind: RefKind; branch?: string }> {
	if (ref === "HEAD") {
		const name = await remoteDefaultBranch(session, workspace);
		const sha = name ? await revParse(session, workspace, `refs/remotes/origin/${name}`) : undefined;
		if (name && sha) return { sha, kind: "branch", branch: name };
		throw new RefNotFoundError("the remote has no default branch for the ref HEAD to resolve to");
	}
	const pull = PULL_REF.exec(ref);
	if (pull) {
		await git(session, workspace, ["fetch", "origin", `+${ref}:refs/somework/pull/${pull[1]}/${pull[2]}`], { auth: true });
		const sha = await revParse(session, workspace, `refs/somework/pull/${pull[1]}/${pull[2]}`);
		if (sha) return { sha, kind: "pull" };
		throw new RefNotFoundError(`pull ref ${ref} was fetched but does not point to a commit`);
	}
	if (!PLAIN_REF.test(ref) || ref.includes("..") || ref.endsWith(".lock") || ref.endsWith("/")) throw new RefNotFoundError(`"${ref.slice(0, 80)}" is not a usable git ref`);
	const branch = await revParse(session, workspace, `refs/remotes/origin/${ref}`);
	if (branch) return { sha: branch, kind: "branch" };
	const tag = await revParse(session, workspace, `refs/tags/${ref}`);
	if (tag) return { sha: tag, kind: "tag" };
	if (SHA_PREFIX.test(ref)) {
		let sha = await revParse(session, workspace, ref);
		if (!sha && FULL_SHA.test(ref)) {
			// not reachable from any fetched branch or tag (a pull request head, a rewritten branch): ask the remote for exactly this object
			const fetched = await git(session, workspace, ["fetch", "origin", ref], { auth: true, allow: [1, 128] });
			if (fetched.code === 0) sha = await revParse(session, workspace, ref);
		}
		if (sha) return { sha, kind: "commit" };
	}
	const hint = SHA_PREFIX.test(ref) && !FULL_SHA.test(ref) ? " (an abbreviated SHA must be reachable from a branch or tag; use the full SHA otherwise)" : "";
	throw new RefNotFoundError(`ref "${ref}" is not a branch, tag, commit or pull ref of the repository${hint}`);
}

async function remoteDefaultBranch(session: GitSession, workspace: string): Promise<string | undefined> {
	const head = await git(session, workspace, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], { allow: [1] });
	const named = head.code === 0 ? head.output.trim().replace(/^origin\//, "") : "";
	if (named) return named;
	for (const candidate of ["main", "master"]) if (await revParse(session, workspace, `refs/remotes/origin/${candidate}`)) return candidate;
	return undefined;
}

const mirrorLocks = new Map<string, Promise<unknown>>();

/** Runs `work` after every earlier piece of work on the same key has settled, so two tasks never fetch into one mirror at once. */
async function serialized<T>(key: string, work: () => Promise<T>): Promise<T> {
	const previous = mirrorLocks.get(key) ?? Promise.resolve();
	const run = previous.then(work);
	const tail = run.catch(() => undefined);
	mirrorLocks.set(key, tail);
	try {
		return await run;
	} finally {
		if (mirrorLocks.get(key) === tail) mirrorLocks.delete(key);
	}
}

/**
 * Brings the persistent bare mirror of `repoUrl` up to date (created on first use) and points its HEAD at the remote's default branch.
 * Branches and tags only: pull request refs stay on the remote. Safe to call concurrently; the token goes through the same credential
 * helper as every other git call, so it only reaches `tokenHosts`.
 */
export async function refreshMirror(session: GitSession, repoUrl: string): Promise<string> {
	if (!session.mirrorDir) throw new GitError("no mirror directory is configured", -1);
	const dir = mirrorPathFor(session.mirrorDir, repoUrl);
	return serialized(dir, async () => {
		const present = await session.env.exists(`${dir}/HEAD`, ctx);
		if (!(present.ok && present.value)) {
			const made = await session.env.createDir(dir, { recursive: true }, ctx);
			if (!made.ok) throw new GitError(`cannot create the mirror directory: ${made.error.message}`, -1);
			await git(session, dir, ["init", "--bare", "--quiet"]);
			await git(session, dir, ["remote", "add", "origin", repoUrl]);
			await git(session, dir, ["config", "remote.origin.fetch", "+refs/heads/*:refs/heads/*"]);
			await git(session, dir, ["config", "--add", "remote.origin.fetch", "+refs/tags/*:refs/tags/*"]);
		}
		await git(session, dir, ["fetch", "--prune", "--force", "origin"], { auth: true });
		const head = await git(session, dir, ["ls-remote", "--symref", "origin", "HEAD"], { auth: true, allow: [1, 128] });
		const named = /^ref: refs\/heads\/(\S+)\s+HEAD$/m.exec(head.output)?.[1];
		if (named) await git(session, dir, ["symbolic-ref", "HEAD", `refs/heads/${named}`]);
		return dir;
	});
}

/** The mirror to clone from, refreshed; a stale one when the remote cannot be reached right now (the fetch from origin that follows makes the clone current); none when there is no usable mirror. */
async function usableMirror(session: GitSession, repoUrl: string): Promise<string | undefined> {
	if (!session.mirrorDir) return undefined;
	try {
		return await refreshMirror(session, repoUrl);
	} catch {
		const dir = mirrorPathFor(session.mirrorDir, repoUrl);
		const present = await session.env.exists(`${dir}/HEAD`, ctx);
		if (!(present.ok && present.value)) return undefined;
		const refs = await git(session, dir, ["for-each-ref", "--count=1", "refs/heads"], { allow: [1, 128] });
		return refs.code === 0 && refs.output.trim() !== "" ? dir : undefined;
	}
}

/**
 * Refreshes every repository's mirror now and then every `everyMinutes` until `signal` aborts. A failure is reported and the next round
 * tries again; tasks never wait for this loop, they refresh the mirror themselves.
 */
export function startMirrorRefresh(options: { session: GitSession; repositories: string[]; everyMinutes: number; signal: AbortSignal; log?: (level: "info" | "warn", event: string, fields: Record<string, unknown>) => void }): void {
	const label = (url: string): string => url.replace(/^[a-z]+:\/\/[^/@]*@/i, "https://").replace(/\.git$/, "");
	const round = async (): Promise<void> => {
		for (const repository of options.repositories) {
			const started = Date.now();
			try {
				await refreshMirror(options.session, repository);
				options.log?.("info", "mirror_refreshed", { repository: label(repository), ms: Date.now() - started });
			} catch (error) {
				options.log?.("warn", "mirror_refresh_failed", { repository: label(repository), error: scrub(error instanceof Error ? error.message : String(error), options.session.token).slice(0, 300) });
			}
		}
	};
	void round();
	const timer = setInterval(() => void round(), Math.max(1, options.everyMinutes) * 60_000);
	timer.unref();
	options.signal.addEventListener("abort", () => clearInterval(timer), { once: true });
}

/**
 * Idempotent: a retry finds the clone and the task's branch and changes nothing, so work in progress is never disturbed.
 * Returns the commit the work starts from; a read-only role passes `detach` and gets that commit checked out without a branch.
 */
export async function prepareWorkspace(session: GitSession, params: PrepareParams): Promise<PreparedWorkspace> {
	const { env } = session;
	const made = await env.createDir(params.workspace, { recursive: true }, ctx);
	if (!made.ok) throw new GitError(`cannot create the workspace: ${made.error.message}`, -1);
	const cloned = await env.exists(`${params.workspace}/.git`, ctx);
	const mirror = cloned.ok && cloned.value ? undefined : await usableMirror(session, params.repoUrl);
	if (cloned.ok && cloned.value) await git(session, params.workspace, ["fetch", "--prune", "--tags", "--force", "origin"], { auth: true });
	else if (mirror) {
		// clone from the local mirror, then point origin back at the real remote and fetch what changed since the mirror was refreshed
		await git(session, params.workspace, ["clone", mirror, "."]);
		await git(session, params.workspace, ["remote", "set-url", "origin", params.repoUrl]);
		await git(session, params.workspace, ["fetch", "--prune", "--tags", "--force", "origin"], { auth: true });
	} else await git(session, params.workspace, ["clone", params.repoUrl, "."], { auth: true });

	const { sha, kind, branch: resolvedBranch } = await resolveRef(session, params.workspace, params.ref);
	const baseName = params.baseRef ?? (kind === "branch" ? (resolvedBranch ?? params.ref) : await remoteDefaultBranch(session, params.workspace));
	// only work that becomes a pull request needs a base branch; a read-only role just looks at the commit
	if (!params.detach && (!baseName || !(await revParse(session, params.workspace, `refs/remotes/origin/${baseName}`)))) {
		throw new RefNotFoundError(`base branch ${baseName ? `"${baseName}"` : "(the remote has no default branch)"} does not exist on the remote; pass repository.baseRef when the ref is not a branch`);
	}

	if (params.detach) {
		const head = (await git(session, params.workspace, ["rev-parse", "--verify", "--quiet", "HEAD"], { allow: [1] })).output.trim();
		const onBranch = (await git(session, params.workspace, ["symbolic-ref", "--quiet", "HEAD"], { allow: [1] })).code === 0;
		if (head !== sha || onBranch) await git(session, params.workspace, ["checkout", "--force", "--detach", sha]);
		return { baseSha: sha, branch: "", baseBranch: baseName ?? "", refKind: kind, detached: true };
	}
	const branch = taskBranch(params, { sha, kind });
	const exists = (await git(session, params.workspace, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { allow: [1] })).code === 0;
	if (exists) await git(session, params.workspace, ["checkout", branch]);
	else await git(session, params.workspace, ["checkout", "-B", branch, sha]);
	// where the task's work really began: the resolved commit for a new branch, the fork point for a branch that already had commits
	const fork = await git(session, params.workspace, ["merge-base", sha, "HEAD"], { allow: [1] });
	return { baseSha: fork.code === 0 && fork.output.trim() ? fork.output.trim() : sha, branch, baseBranch: baseName!, refKind: kind, detached: false };
}

const BRANCH_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/** The task branch: the default `<prefix>/<taskId>`, or the role's own name, which must stay under `<prefix>/` and be a plain ref. */
function taskBranch(params: Pick<PrepareParams, "taskId" | "branchPrefix" | "branch">, resolved: { sha: string; kind: RefKind }): string {
	const prefix = params.branchPrefix ?? DEFAULT_BRANCH_PREFIX;
	const named = typeof params.branch === "function" ? params.branch(resolved) : params.branch;
	if (named === undefined) return branchFor(params.taskId, prefix);
	if (!named.startsWith(`${prefix}/`) || !BRANCH_NAME.test(named) || named.includes("..") || named.includes("//") || named.endsWith("/") || named.endsWith(".lock") || named.length > 200) throw new GitError(`"${named.slice(0, 80)}" is not an allowed branch name (it must be a plain ref under ${prefix}/)`, -1);
	return named;
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
	params: {
		repoUrl: string;
		ref: string;
		taskId: string;
		workspace: string;
		title: string;
		body: string;
		branchPrefix?: string;
		/** From `prepareWorkspace`. Without them the work is measured against `origin/<ref>` and the pull request targets `ref`. */
		baseSha?: string;
		baseBranch?: string;
		/** The branch `prepareWorkspace` put the work on (default `<branchPrefix>/<taskId>`). */
		branch?: string;
		/** Replaces the commit message `agent: <title>`: the first line is the subject, the rest the body. */
		commitMessage?: string;
	},
): Promise<FinalizeResult> {
	const branch = params.branch ?? branchFor(params.taskId, params.branchPrefix);
	const base = params.baseSha ?? `origin/${params.ref}`;
	const run = (args: string[], options?: { allow?: number[]; auth?: boolean }) => git(session, params.workspace, args, options);
	await run(["add", "-A"]);
	if ((await run(["diff", "--cached", "--quiet"], { allow: [1] })).code === 1) await run(["commit", ...commitMessageArgs(params.commitMessage ?? `agent: ${params.title}`)]);
	const ahead = Number((await run(["rev-list", "--count", `${base}..HEAD`])).output.trim());
	if (ahead === 0) return { status: "no_changes", branch, commits: [], patch: "" };
	const commits = (await run(["rev-list", "--reverse", `${base}..HEAD`])).output.split("\n").filter(Boolean);
	await run(["push", "origin", `HEAD:refs/heads/${branch}`], { auth: true });
	let patch = (await run(["diff", `${base}...HEAD`])).output;
	if (Buffer.byteLength(patch) > MAX_PATCH_BYTES) patch = `${patch.slice(0, MAX_PATCH_BYTES)}\n[patch truncated at ${MAX_PATCH_BYTES} bytes]\n`;
	const existing = await host.findPullRequest({ repoUrl: params.repoUrl, head: branch });
	const pr = existing ?? (await host.createPullRequest({ repoUrl: params.repoUrl, head: branch, base: params.baseBranch ?? params.ref, title: params.title, body: params.body }));
	return { status: "completed", branch, commits, prUrl: pr?.url, patch };
}

/** `-m subject [-m body]` for a message whose first line is the subject (at most 120 characters) and whose remaining lines are the body. */
function commitMessageArgs(message: string): string[] {
	const [subject = "", ...rest] = message.split("\n");
	const body = rest.join("\n").trim();
	return ["-m", subject.slice(0, 120), ...(body ? ["-m", body] : [])];
}

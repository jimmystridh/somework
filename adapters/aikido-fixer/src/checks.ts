import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { CheckProfile } from "./settings.ts";
import { git, run } from "./sandbox.ts";

/** Text that has no business being added to a repository by an automatic fix. */
const SECRET_LIKE: [RegExp, string][] = [
	[/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "a private key"],
	[/\b(?:ghp|gho|ghs|ghu)_[A-Za-z0-9]{20,}/, "a GitHub token"],
	[/\bgithub_pat_[A-Za-z0-9_]{20,}/, "a GitHub token"],
	[/\bAKIA[0-9A-Z]{16}\b/, "an AWS access key"],
	[/\bxox[abprs]-[A-Za-z0-9-]{10,}/, "a Slack token"],
];

const WHOLE = 8_000_000;

export interface ChangeReview {
	files: string[];
	/** What the added lines contain that must not be committed, when something does. */
	secretLike?: string;
}

/**
 * What the model left in the working tree, seen the way the commit will see it: everything is staged (the service stages it anyway), the
 * paths come from the index, and the added lines are scanned. Deleted and renamed files count with both of their paths.
 */
export async function reviewChange(env: ExecutionEnv, workspace: string): Promise<ChangeReview> {
	const staged = await git(env, workspace, "add", "-A");
	if (staged.code !== 0) throw new Error(`git add failed in the workspace: ${staged.output.slice(-200)}`);
	const names = await run(env, "git -c core.quotepath=false diff --cached --name-only --no-renames", workspace, 60, WHOLE);
	const files = names.output.split("\n").map((name) => name.trim()).filter(Boolean);
	if (files.length === 0) return { files };
	const diff = await run(env, "git diff --cached --no-color --unified=0", workspace, 120, WHOLE);
	const added = diff.output.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++")).join("\n");
	const hit = SECRET_LIKE.find(([pattern]) => pattern.test(added));
	return { files, ...(hit ? { secretLike: hit[1] } : {}) };
}

/** Puts the working tree back to the commit: used when the agent says there is no safe fix, so nothing speculative survives. */
export async function discardChange(env: ExecutionEnv, workspace: string): Promise<void> {
	await git(env, workspace, "reset", "--hard");
	await git(env, workspace, "clean", "-fd");
}

export interface CheckResult {
	profile: string;
	ok: boolean;
	summary: string;
}

/** Runs the repository's named check profile, if the deployment configured one. The command comes from the deployment, never from the model. */
export async function runCheck(env: ExecutionEnv, workspace: string, check: { name: string; profile: CheckProfile } | undefined): Promise<CheckResult | undefined> {
	if (!check) return undefined;
	const cwd = check.profile.cwd ? `${workspace.replace(/\/$/, "")}/${check.profile.cwd}` : workspace;
	const result = await run(env, check.profile.command, cwd, check.profile.timeoutSeconds ?? 900);
	const tail = result.output.replace(/\s+/g, " ").trim().slice(-300);
	return { profile: check.name, ok: result.code === 0 && !result.timedOut, summary: result.timedOut ? `timed out after ${check.profile.timeoutSeconds ?? 900} s` : result.code === 0 ? tail : `exit code ${result.code}: ${tail}` };
}

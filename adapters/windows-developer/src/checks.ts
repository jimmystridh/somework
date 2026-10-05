import { BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { checkEncodingPreserved, expectationFor } from "./encoding.ts";
import type { CommandProfile, Profiles, Selection } from "./profiles.ts";
import { redactLog } from "@somework/agent-kit/windows";

export interface StepResult {
	name: string;
	ok: boolean;
	exitCode: number;
	durationMs: number;
	/** Not run because an earlier step it depends on failed. */
	skipped?: boolean;
	/** Why there is no exit code of the command itself ("timeout", "aborted", ...). */
	error?: string;
	logArtifact?: string;
}

export interface EncodingReport {
	ok: boolean;
	checked: number;
	violations: { file: string; reasons: string[] }[];
}

export interface ChecksResult {
	build?: StepResult;
	tests: StepResult[];
	encoding?: EncodingReport;
	/** Reasons nothing was pushed. Empty: the work may be pushed. */
	blocked: string[];
	/** Log files to upload as artifacts, keyed by step name (`build:<name>` / `test:<name>`). */
	logs: Map<string, { filename: string; bytes: string }>;
}

const MAX_LOG_BYTES = 2 * 1024 * 1024;
const MAX_FILES_CHECKED = 500;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const ctx = BACKGROUND_CONTEXT;

export const quote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

async function run(env: ExecutionEnv, command: string, cwd: string, options: { env?: Record<string, string>; timeout?: number; signal?: AbortSignal; onOutput?: (text: string) => void } = {}) {
	const { context, cancel } = withCancel(ctx);
	const onAbort = () => cancel("job stopped");
	if (options.signal?.aborted) onAbort();
	options.signal?.addEventListener("abort", onAbort, { once: true });
	try {
		return await env.exec(command, { cwd, env: options.env, timeout: options.timeout, onOutput: options.onOutput ? (text) => options.onOutput!(text) : undefined }, context);
	} finally {
		options.signal?.removeEventListener("abort", onAbort);
	}
}

/** A resolved commit is used as it is; a branch name means `origin/<branch>`. */
export const baseRevision = (ref: string): string => (/^[0-9a-f]{40}$/i.test(ref) ? ref : `origin/${ref}`);

/** Modified tracked files (working copy against the base ref), their base bytes and their current bytes, checked for encoding damage. */
export async function checkWorkspaceEncoding(env: ExecutionEnv, workspace: string, ref: string, profiles: Profiles, signal?: AbortSignal): Promise<EncodingReport> {
	if (ref.startsWith("-")) return { ok: false, checked: 0, violations: [{ file: "(ref)", reasons: ["the base ref looks like an option"] }] };
	let listing = "";
	const listed = await run(env, `git -c core.quotepath=off diff --name-only -z --diff-filter=M ${quote(baseRevision(ref))}`, workspace, { signal, onOutput: (text) => (listing += text) });
	if (!listed.ok || listed.value.exitCode !== 0) return { ok: false, checked: 0, violations: [{ file: "(git)", reasons: [`could not list the changed files: ${listed.ok ? `git exited with ${listed.value.exitCode}` : listed.error.message}`] }] };
	const files = listing.split("\u0000").filter(Boolean).slice(0, MAX_FILES_CHECKED);
	const violations: EncodingReport["violations"] = [];
	const beforeFile = ".git/somework-before.bin";
	let checked = 0;
	for (const file of files) {
		const shown = await run(env, `git show ${quote(`${baseRevision(ref)}:${file}`)} > ${quote(beforeFile)}`, workspace, { signal });
		if (!shown.ok || shown.value.exitCode !== 0) continue; // new in this change or unreadable: nothing to compare with
		const before = await env.readBinaryFile(`${workspace}/${beforeFile}`, ctx);
		const after = await env.readBinaryFile(`${workspace}/${file}`, ctx);
		if (!before.ok || !after.ok || before.value.length > MAX_FILE_BYTES || after.value.length > MAX_FILE_BYTES) continue;
		checked++;
		const verdict = checkEncodingPreserved(before.value, after.value, { expect: expectationFor(file, profiles.encoding) });
		if (!verdict.ok) violations.push({ file, reasons: verdict.reasons });
	}
	await env.remove(`${workspace}/${beforeFile}`, { force: true }, ctx);
	return { ok: violations.length === 0, checked, violations };
}

async function runProfile(env: ExecutionEnv, workspace: string, name: string, profile: CommandProfile, secrets: string[], signal?: AbortSignal): Promise<{ step: StepResult; log: string }> {
	const started = Date.now();
	let tail = "";
	let dropped = 0;
	const result = await run(env, profile.command, profile.cwd ? `${workspace}/${profile.cwd}` : workspace, {
		env: profile.env,
		timeout: profile.timeoutMinutes * 60,
		signal,
		onOutput: (text) => {
			tail += text;
			if (tail.length > 2 * MAX_LOG_BYTES) {
				dropped += tail.length - MAX_LOG_BYTES;
				tail = tail.slice(-MAX_LOG_BYTES);
			}
		},
	});
	const durationMs = Date.now() - started;
	const exitCode = result.ok ? result.value.exitCode : -1;
	const error = result.ok ? undefined : result.error.code === "timeout" || result.error.code === "aborted" ? result.error.code : result.error.message.slice(0, 200);
	const header = dropped > 0 ? `[${dropped} characters of earlier output dropped]\n` : "";
	const footer = `\n--- ${name}: ${error ? `no exit code (${error})` : `exit code ${exitCode}`} after ${Math.round(durationMs / 1000)} s ---\n`;
	return { step: { name, ok: result.ok && exitCode === 0, exitCode, durationMs, ...(error ? { error } : {}) }, log: redactLog(header + tail + footer, secrets) };
}

/** After the model finished: encoding check, then the selected build, then the selected tests (skipped when the build failed). */
export async function runChecks(args: { env: ExecutionEnv; workspace: string; ref: string; taskId: string; selection: Selection; profiles: Profiles; secrets?: string[]; signal?: AbortSignal }): Promise<ChecksResult> {
	const { env, workspace, selection, profiles, signal } = args;
	const secrets = args.secrets ?? [];
	const result: ChecksResult = { tests: [], blocked: [], logs: new Map() };

	result.encoding = await checkWorkspaceEncoding(env, workspace, args.ref, profiles, signal);
	if (!result.encoding.ok && profiles.encoding.blockPush) result.blocked.push(`encoding: ${result.encoding.violations.map((v) => `${v.file} (${v.reasons.join("; ")})`).join(", ").slice(0, 600)}`);

	if (selection.build) {
		const profile = profiles.build[selection.build]!;
		const { step, log } = await runProfile(env, workspace, selection.build, profile, secrets, signal);
		result.build = step;
		result.logs.set(`build:${selection.build}`, { filename: `${args.taskId}-build-${selection.build}.log`, bytes: log });
		if (!step.ok && profile.blockPushOnFailure) result.blocked.push(`build "${selection.build}" failed (${step.error ?? `exit ${step.exitCode}`})`);
	}
	const buildFailed = result.build !== undefined && !result.build.ok;
	for (const name of selection.tests) {
		if (buildFailed) {
			result.tests.push({ name, ok: false, exitCode: -1, durationMs: 0, skipped: true });
			continue;
		}
		const profile = profiles.test[name]!;
		const { step, log } = await runProfile(env, workspace, name, profile, secrets, signal);
		result.tests.push(step);
		result.logs.set(`test:${name}`, { filename: `${args.taskId}-test-${name}.log`, bytes: log });
		if (!step.ok && profile.blockPushOnFailure) result.blocked.push(`test "${name}" failed (${step.error ?? `exit ${step.exitCode}`})`);
	}
	return result;
}

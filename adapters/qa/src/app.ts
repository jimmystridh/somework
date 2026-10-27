import { readFileSync } from "node:fs";
import { BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { redactLog } from "@somework/agent-kit/windows";

export class AppProfilesError extends Error {
	override readonly name = "AppProfilesError";
}

/** How to bring the application under test up and how to tell that it is. The job picks one by name; it never supplies a command. */
export interface AppProfile {
	/**
	 * Optional command run before `start`, in the same place, for work that takes long and must finish before the application can start (building the
	 * back end of this checkout). It runs in the foreground; the application is started only when it exits 0. Its output is kept for the failure reason.
	 */
	prepare?: string;
	prepareTimeoutSeconds: number;
	/**
	 * Run through bash in the task workspace (or `cwd` below it). It must START the application in the background and return: redirect its
	 * output to a file and detach its input, for example `nohup node server.js > .qa/app.log 2>&1 < /dev/null &`, otherwise the command
	 * waits for the application to exit.
	 */
	start: string;
	/** Loopback URLs that answer (any HTTP status below 500) once the application is up. */
	health: string[];
	/** Optional command that stops it. After it (or instead of it) everything the sweep account started during the job is stopped. */
	stop?: string;
	cwd?: string;
	env: Record<string, string>;
	startupTimeoutSeconds: number;
	/** Optional command whose first output line is the revision of the back end the application talks to (reported as `backendRevision`). */
	backendRevisionCommand?: string;
}

const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SECRET_NAME = /token|secret|passw|credential|api_?key|private_?key/i;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

const fail = (where: string, message: string): never => {
	throw new AppProfilesError(`${where}: ${message}`);
};
const object = (value: unknown, where: string): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : fail(where, "must be an object"));

function command(value: unknown, where: string): string {
	if (typeof value !== "string" || value.trim() === "" || value.length > 4000 || value.includes("\u0000")) fail(where, "must be a non-empty command");
	return value as string;
}

/** `{ "app": { "<name>": { start, health, ... } } }`. Typos are errors, not silently ignored settings. */
export function parseAppProfiles(raw: unknown): Record<string, AppProfile> {
	const root = object(raw, "profiles");
	for (const key of Object.keys(root)) if (key !== "app") fail("profiles", `unknown section "${key}" (allowed: app)`);
	const profiles: Record<string, AppProfile> = {};
	for (const [name, entryRaw] of Object.entries(object(root.app ?? {}, "profiles.app"))) {
		const at = `profiles.app.${name}`;
		if (!NAME.test(name)) fail("profiles.app", `"${name}" is not a valid profile name (lower-case letters, digits, . _ -)`);
		const entry = object(entryRaw, at);
		for (const key of Object.keys(entry)) if (!["start", "health", "stop", "cwd", "env", "startupTimeoutSeconds", "backendRevisionCommand", "prepare", "prepareTimeoutSeconds"].includes(key)) fail(at, `unknown setting "${key}"`);
		const health = entry.health;
		if (!Array.isArray(health) || health.length === 0 || health.length > 8) fail(at, "health must be a list of one to eight loopback URLs");
		for (const url of health as unknown[]) {
			let parsed: URL;
			try {
				parsed = new URL(String(url));
			} catch {
				return fail(at, `health URL is not a URL: ${String(url)}`);
			}
			if (parsed.protocol !== "http:" && parsed.protocol !== "https:") fail(at, `health URL must be http or https: ${String(url)}`);
			if (!LOOPBACK.has(parsed.hostname)) fail(at, `health URL must be on this machine (127.0.0.1, localhost): ${String(url)}`);
		}
		const startup = entry.startupTimeoutSeconds ?? 120;
		if (typeof startup !== "number" || !Number.isInteger(startup) || startup < 5 || startup > 1800) fail(at, "startupTimeoutSeconds must be an integer from 5 to 1800");
		const prepareTimeout = entry.prepareTimeoutSeconds ?? 3600;
		if (typeof prepareTimeout !== "number" || !Number.isInteger(prepareTimeout) || prepareTimeout < 60 || prepareTimeout > 14400) fail(at, "prepareTimeoutSeconds must be an integer from 60 to 14400");
		if (entry.prepareTimeoutSeconds !== undefined && entry.prepare === undefined) fail(at, "prepareTimeoutSeconds needs a prepare command");
		let cwd: string | undefined;
		if (entry.cwd !== undefined) {
			if (typeof entry.cwd !== "string" || /^([A-Za-z]:|[\\/])/.test(entry.cwd) || entry.cwd.split(/[\\/]/).includes("..") || entry.cwd.includes(":")) fail(at, "cwd must be a relative path inside the workspace");
			cwd = (entry.cwd as string).replaceAll("\\", "/");
		}
		const env: Record<string, string> = {};
		for (const [key, value] of Object.entries(object(entry.env ?? {}, `${at}.env`))) {
			if (!ENV_NAME.test(key)) fail(`${at}.env`, `"${key}" is not a valid variable name`);
			if (SECRET_NAME.test(key)) fail(`${at}.env`, `"${key}" looks like a credential; keep credentials out of the profiles file`);
			if (typeof value !== "string") fail(`${at}.env`, `"${key}" must be a string`);
			env[key] = value as string;
		}
		profiles[name] = {
			...(entry.prepare !== undefined ? { prepare: command(entry.prepare, `${at}.prepare`) } : {}),
			prepareTimeoutSeconds: prepareTimeout,
			start: command(entry.start, `${at}.start`),
			health: (health as unknown[]).map(String),
			...(entry.stop !== undefined ? { stop: command(entry.stop, `${at}.stop`) } : {}),
			...(entry.backendRevisionCommand !== undefined ? { backendRevisionCommand: command(entry.backendRevisionCommand, `${at}.backendRevisionCommand`) } : {}),
			...(cwd ? { cwd } : {}),
			env,
			startupTimeoutSeconds: startup,
		};
	}
	return profiles;
}

export function loadAppProfiles(file: string | undefined, read: (path: string) => string = (path) => readFileSync(path, "utf8")): Record<string, AppProfile> {
	if (!file) return {};
	let raw: unknown;
	try {
		raw = JSON.parse(read(file));
	} catch (error) {
		throw new AppProfilesError(`${file}: ${error instanceof Error ? error.message : String(error)}`);
	}
	return parseAppProfiles(raw);
}

/** What the runner needs of an execution environment. The Windows confined environment also has `sweepSince`. */
export type AppEnv = Pick<ExecutionEnv, "exec"> & { sweepSince?(sinceMs: number): Promise<number> };

export type StartResult = { ok: true; startedAtMs: number; backendRevision?: string } | { ok: false; reason: string };

const MAX_OUTPUT = 4000;
const tail = (text: string): string => (text.length <= MAX_OUTPUT ? text : `...${text.slice(-MAX_OUTPUT)}`);

/** Starts the application from a profile, waits until it is healthy, and stops it again. */
export class AppRunner {
	readonly #env: AppEnv;
	readonly #fetch: typeof fetch;
	readonly #secrets: readonly string[];
	readonly #pollMs: number;

	constructor(options: { env: AppEnv; secrets?: readonly string[]; fetch?: typeof fetch; pollMs?: number }) {
		this.#env = options.env;
		this.#fetch = options.fetch ?? fetch;
		this.#secrets = options.secrets ?? [];
		this.#pollMs = options.pollMs ?? 500;
	}

	async #run(commandLine: string, cwd: string, env: Record<string, string>, timeoutSeconds: number, signal?: AbortSignal): Promise<{ ok: boolean; exitCode?: number; output: string; error?: string }> {
		const { context, cancel } = withCancel(BACKGROUND_CONTEXT);
		const onAbort = () => cancel("job stopped");
		if (signal?.aborted) onAbort();
		signal?.addEventListener("abort", onAbort, { once: true });
		let output = "";
		try {
			const result = await this.#env.exec(commandLine, { cwd, env, timeout: timeoutSeconds, onOutput: (text) => (output = tail(output + text)) }, context);
			if (!result.ok) return { ok: false, output, error: `${result.error.code}: ${result.error.message}` };
			return { ok: result.value.exitCode === 0, exitCode: result.value.exitCode, output };
		} finally {
			signal?.removeEventListener("abort", onAbort);
		}
	}

	async #healthy(urls: readonly string[]): Promise<boolean> {
		for (const url of urls) {
			try {
				const response = await this.#fetch(url, { signal: AbortSignal.timeout(3000), redirect: "manual" });
				await response.body?.cancel().catch(() => {});
				if (response.status >= 500) return false;
			} catch {
				return false;
			}
		}
		return true;
	}

	async start(profile: AppProfile, workspace: string, signal?: AbortSignal): Promise<StartResult> {
		const startedAtMs = Date.now();
		const cwd = profile.cwd ? `${workspace}/${profile.cwd}` : workspace;
		if (profile.prepare) {
			const prepared = await this.#run(profile.prepare, cwd, profile.env, profile.prepareTimeoutSeconds, signal);
			if (!prepared.ok) return { ok: false, reason: redactLog(`the preparation command failed${prepared.exitCode !== undefined ? ` (exit ${prepared.exitCode})` : ""}${prepared.error ? `: ${prepared.error}` : ""}\n${prepared.output}`, this.#secrets).trim() };
		}
		const launched = await this.#run(profile.start, cwd, profile.env, profile.startupTimeoutSeconds, signal);
		if (!launched.ok) return { ok: false, reason: redactLog(`the start command failed${launched.exitCode !== undefined ? ` (exit ${launched.exitCode})` : ""}${launched.error ? `: ${launched.error}` : ""}\n${launched.output}`, this.#secrets).trim() };
		const deadline = Date.now() + profile.startupTimeoutSeconds * 1000;
		while (Date.now() < deadline) {
			if (signal?.aborted) return { ok: false, reason: "stopped while waiting for the application" };
			if (await this.#healthy(profile.health)) {
				let backendRevision: string | undefined;
				if (profile.backendRevisionCommand) {
					const revision = await this.#run(profile.backendRevisionCommand, cwd, profile.env, 30, signal);
					if (revision.ok) backendRevision = redactLog(revision.output.split(/\r?\n/).find((line) => line.trim() !== "")?.trim().slice(0, 200) ?? "", this.#secrets) || undefined;
				}
				return { ok: true, startedAtMs, ...(backendRevision ? { backendRevision } : {}) };
			}
			await new Promise((resolve) => setTimeout(resolve, this.#pollMs));
		}
		return { ok: false, reason: `the application did not become healthy within ${profile.startupTimeoutSeconds} s (${profile.health.join(", ")})` };
	}

	/** Never throws: stopping must not turn into a failed job. Returns what it did, for the log. */
	async stop(profile: AppProfile | undefined, workspace: string, startedAtMs: number): Promise<{ stopCommand?: boolean; swept: number }> {
		let stopCommand: boolean | undefined;
		if (profile?.stop) {
			try {
				const cwd = profile.cwd ? `${workspace}/${profile.cwd}` : workspace;
				stopCommand = (await this.#run(profile.stop, cwd, profile.env, 60)).ok;
			} catch {
				stopCommand = false;
			}
		}
		let swept = 0;
		try {
			swept = (await this.#env.sweepSince?.(startedAtMs - 1000)) ?? 0;
		} catch {
			swept = 0;
		}
		return { ...(stopCommand === undefined ? {} : { stopCommand }), swept };
	}
}

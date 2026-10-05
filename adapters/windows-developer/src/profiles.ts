import { readFileSync } from "node:fs";
import { InvalidInput } from "@somework/agent-kit";
import { defaultEncodingPolicy, type EncodingPolicy } from "./encoding.ts";

export class ProfilesError extends Error {
	override readonly name = "ProfilesError";
}

/** A build or test the deployment has configured. The job picks one by name; it never supplies a command. */
export interface CommandProfile {
	/** Run through Git for Windows' bash, in the task workspace (or `cwd` below it). */
	command: string;
	/** Relative to the workspace, `/`-separated, no `..`. */
	cwd?: string;
	timeoutMinutes: number;
	/** Extra variables for this command (no credentials: the configured build script reaches its own stored credentials itself). */
	env: Record<string, string>;
	/** Default true: if this fails, nothing is pushed and the task result says why. */
	blockPushOnFailure: boolean;
}

export interface Profiles {
	build: Record<string, CommandProfile>;
	test: Record<string, CommandProfile>;
	encoding: EncodingPolicy;
}

export const emptyProfiles = (): Profiles => ({ build: {}, test: {}, encoding: defaultEncodingPolicy() });

const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SECRET_NAME = /token|secret|passw|credential|api_?key|private_?key/i;

const fail = (where: string, message: string): never => {
	throw new ProfilesError(`${where}: ${message}`);
};
const object = (value: unknown, where: string): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : fail(where, "must be an object"));
const noUnknown = (value: Record<string, unknown>, allowed: string[], where: string): void => {
	for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(where, `unknown setting "${key}" (allowed: ${allowed.join(", ")})`);
};
const stringList = (value: unknown, where: string): string[] => {
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0 || item.length > 200)) return fail(where, "must be a list of non-empty strings");
	return value as string[];
};

function parseCommand(name: string, raw: unknown, where: string): CommandProfile {
	if (!NAME.test(name)) fail(where, `"${name}" is not a valid profile name (lower-case letters, digits, . _ -)`);
	const entry = object(raw, `${where}.${name}`);
	const at = `${where}.${name}`;
	noUnknown(entry, ["command", "cwd", "timeoutMinutes", "env", "blockPushOnFailure"], at);
	if (typeof entry.command !== "string" || entry.command.trim() === "" || entry.command.length > 4000 || entry.command.includes("\u0000")) fail(at, "command must be a non-empty string");
	const timeoutMinutes = entry.timeoutMinutes ?? 60;
	if (typeof timeoutMinutes !== "number" || !Number.isInteger(timeoutMinutes) || timeoutMinutes < 1 || timeoutMinutes > 240) fail(at, "timeoutMinutes must be an integer from 1 to 240");
	let cwd: string | undefined;
	if (entry.cwd !== undefined) {
		if (typeof entry.cwd !== "string" || /^([A-Za-z]:|[\\/])/.test(entry.cwd) || entry.cwd.split(/[\\/]/).includes("..") || entry.cwd.includes(":")) fail(at, "cwd must be a relative path inside the workspace");
		cwd = (entry.cwd as string).replaceAll("\\", "/");
	}
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(object(entry.env ?? {}, `${at}.env`))) {
		if (!ENV_NAME.test(key)) fail(`${at}.env`, `"${key}" is not a valid variable name`);
		if (SECRET_NAME.test(key)) fail(`${at}.env`, `"${key}" looks like a credential; keep credentials out of the profiles file (the build script must find its own stored credential)`);
		if (typeof value !== "string") fail(`${at}.env`, `"${key}" must be a string`);
		env[key] = value as string;
	}
	if (entry.blockPushOnFailure !== undefined && typeof entry.blockPushOnFailure !== "boolean") fail(at, "blockPushOnFailure must be true or false");
	return { command: entry.command as string, ...(cwd ? { cwd } : {}), timeoutMinutes, env, blockPushOnFailure: entry.blockPushOnFailure !== false };
}

/** Validates the profiles file (typos are errors, not silently ignored settings). */
export function parseProfiles(raw: unknown): Profiles {
	const root = object(raw, "profiles");
	noUnknown(root, ["build", "test", "encoding"], "profiles");
	const profiles = emptyProfiles();
	for (const kind of ["build", "test"] as const) {
		for (const [name, entry] of Object.entries(object(root[kind] ?? {}, `profiles.${kind}`))) profiles[kind][name] = parseCommand(name, entry, `profiles.${kind}`);
	}
	if (root.encoding !== undefined) {
		const encoding = object(root.encoding, "profiles.encoding");
		noUnknown(encoding, ["legacyGlobs", "utf8Globs", "blockPush"], "profiles.encoding");
		if (encoding.blockPush !== undefined && typeof encoding.blockPush !== "boolean") fail("profiles.encoding", "blockPush must be true or false");
		profiles.encoding = {
			legacyGlobs: encoding.legacyGlobs === undefined ? [] : stringList(encoding.legacyGlobs, "profiles.encoding.legacyGlobs"),
			utf8Globs: encoding.utf8Globs === undefined ? [] : stringList(encoding.utf8Globs, "profiles.encoding.utf8Globs"),
			blockPush: encoding.blockPush !== false,
		};
	}
	return profiles;
}

export function loadProfiles(path: string | undefined): Profiles {
	if (!path) return emptyProfiles();
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new ProfilesError(`cannot read the profiles file ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
	return parseProfiles(raw);
}

export interface Selection {
	build?: string;
	tests: string[];
}

/**
 * What the job asked to have run, validated against the configured profiles. A job selects profiles by name only: a `command` (or any
 * other key) in `build` is refused rather than ignored, so a requester can never get its own text executed by this agent.
 */
export function selectProfiles(input: { build?: unknown; tests?: unknown }, profiles: Profiles): Selection {
	const selection: Selection = { tests: [] };
	if (input.build !== undefined) {
		const build = input.build as Record<string, unknown> | null;
		if (!build || typeof build !== "object" || Array.isArray(build)) throw new InvalidInput("build must be {name}");
		for (const key of Object.keys(build)) {
			if (key !== "name") throw new InvalidInput(`build.${key} is not accepted: this agent runs only pre-configured build profiles, selected by build.name`);
		}
		if (typeof build.name !== "string" || !Object.hasOwn(profiles.build, build.name)) throw new InvalidInput(`unknown build profile "${String(build.name)}"; configured: ${Object.keys(profiles.build).join(", ") || "none"}`);
		selection.build = build.name;
	}
	if (input.tests !== undefined) {
		if (!Array.isArray(input.tests) || input.tests.length > 10 || input.tests.some((name) => typeof name !== "string")) throw new InvalidInput("tests must be a list of at most 10 test profile names");
		for (const name of new Set(input.tests as string[])) {
			if (!Object.hasOwn(profiles.test, name)) throw new InvalidInput(`unknown test profile "${name}"; configured: ${Object.keys(profiles.test).join(", ") || "none"}`);
			selection.tests.push(name);
		}
	}
	return selection;
}

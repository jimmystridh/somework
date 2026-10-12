import { posix } from "node:path";
import type { Word } from "./shell.ts";

/** What kind of harm a destructive command would do, for the approval text and for the tests. */
export type Category = "data" | "secrets" | "hypervisor" | "firewall" | "git" | "download" | "system" | "unknown";

export interface Finding {
	category: Category;
	reason: string;
	/** The command is never to run, whoever agrees (a push to a remote that is not the organisation's). */
	forbidden?: boolean;
}

export interface Settings {
	host?: string;
	workspaces: string[];
	remote: string;
	hypervisorHosts: string[];
	ownServices: string[];
	scripts: string[];
	/** An earlier `cd` left the workspace: relative paths no longer mean the workspace. */
	relativeOutside?: boolean;
	/** The directory an earlier `cd` went to, when it was an absolute path inside the workspace. */
	cwd?: string;
	/** An earlier `cd` went into a directory that holds secrets: every relative path now names something in it. */
	secretCwd?: boolean;
}

export interface Shared {
	/** Files the command line downloads, so that running one of them in the same line is seen. */
	downloads: Set<string>;
}

export interface Io {
	stdinText?: string;
	/** What the previous command of the pipeline prints, when that is plain text written in the command line. */
	piped?: string;
	hasPipe: boolean;
}

export interface Call {
	program: string;
	args: Word[];
	io: Io;
	settings: Settings;
	shared: Shared;
	/** Classifies a command given as words (what a wrapper runs), in this or another setting. */
	runWords(words: Word[], settings?: Settings, io?: Io): Finding | undefined;
	/** Classifies a command line given as text (`sh -c`, what ssh runs). */
	runText(text: string, settings?: Settings, io?: Io): Finding | undefined;
}

export const found = (category: Category, reason: string, forbidden?: boolean): Finding => ({ category, reason, ...(forbidden ? { forbidden } : {}) });

export const clip = (text: string, max = 80): string => (text.length > max ? `${text.slice(0, max - 3)}...` : text);

export const word = (text: string, dynamic = false): Word => ({ text, dynamic });

/** A path the agent may change freely: inside its workspace, never a way out of it. */
export function isOwnPath(text: string, settings: Settings): boolean {
	if (text === "-" || text === "") return true;
	if (text.startsWith("~") || settings.workspaces.length === 0) return false;
	if (!text.startsWith("/") && settings.relativeOutside === true) return false;
	const normalized = !text.startsWith("/") && settings.cwd ? posix.resolve(settings.cwd, text) : posix.normalize(text);
	if (!normalized.startsWith("/")) return normalized !== ".." && !normalized.startsWith("../");
	return settings.workspaces.some((root) => normalized === root || normalized.startsWith(`${root}/`));
}

/** `/workspace/*`: a pattern directly under a workspace root reaches every job's directory, not just the agent's own. */
export function isWorkspaceWildcard(text: string, settings: Settings): boolean {
	if (!text.startsWith("/")) return false;
	const normalized = posix.normalize(text);
	return settings.workspaces.some((root) => normalized.startsWith(`${root}/`) && /^[^/]*[*?[]/.test(normalized.slice(root.length + 1)) && !normalized.slice(root.length + 1).includes("/"));
}

export const isWorkspaceRoot = (text: string, settings: Settings): boolean => text.startsWith("/") && settings.workspaces.includes(posix.normalize(text));

const SINKS = /^\/dev\/(?:null|stdout|stderr|tty|zero)$|^\/dev\/fd\/\d+$/;

/** A write to `target`: allowed inside the workspace and to the standard sinks. */
export function checkWrite(target: Word, action: string, settings: Settings): Finding | undefined {
	if (target.dynamic) return found("data", `${action} a path that is computed when the command runs`);
	if (SINKS.test(target.text)) return undefined;
	if (!isOwnPath(target.text, settings)) return found("data", `${action} outside the workspace: ${clip(target.text)}`);
	return undefined;
}

export interface Flag {
	name: string;
	value?: Word;
}

export interface Parsed {
	flags: Flag[];
	positionals: Word[];
}

/** Splits arguments into flags and positional words. `valued` flags take the next word (or `--flag=value`) as their value. */
export function parseArgs(args: Word[], valued: readonly string[] = [], stopAtFirstPositional = false): Parsed {
	const flags: Flag[] = [];
	const positionals: Word[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (positionals.length > 0 && stopAtFirstPositional) {
			positionals.push(arg);
			continue;
		}
		if (arg.text === "--") {
			positionals.push(...args.slice(i + 1));
			break;
		}
		if (arg.text.length > 1 && arg.text.startsWith("-") && !arg.dynamic) {
			const equals = arg.text.startsWith("--") ? arg.text.indexOf("=") : -1;
			if (equals > 0) flags.push({ name: arg.text.slice(0, equals), value: word(arg.text.slice(equals + 1)) });
			else if (valued.includes(arg.text) && i + 1 < args.length) flags.push({ name: arg.text, value: args[++i]! });
			else if (/^-[A-Za-z]{2,}$/.test(arg.text) && valued.some((flag) => flag.length === 2 && arg.text.endsWith(flag.slice(1)) && i + 1 < args.length)) flags.push({ name: arg.text, value: args[++i]! });
			else if (/^-[A-Za-z]\S+$/.test(arg.text) && valued.includes(arg.text.slice(0, 2))) flags.push({ name: arg.text.slice(0, 2), value: word(arg.text.slice(2)) });
			else flags.push({ name: arg.text });
		} else positionals.push(arg);
	}
	return { flags, positionals };
}

/** Whether a flag is present: a long name matches exactly, a single letter matches inside a cluster such as `-rf`. */
export function hasFlag(parsed: Parsed, ...names: string[]): boolean {
	return parsed.flags.some((flag) => names.some((name) => flag.name === name || (name.length === 2 && name.startsWith("-") && !name.startsWith("--") && /^-[A-Za-z0-9]+$/.test(flag.name) && flag.name.includes(name[1]!))));
}

export const valueOf = (parsed: Parsed, ...names: string[]): Word | undefined => parsed.flags.find((flag) => names.includes(flag.name) && flag.value)?.value;

export const texts = (words: Word[]): string[] => words.map((entry) => entry.text);

export const basename = (text: string): string => text.slice(text.lastIndexOf("/") + 1);

/** `sh -c` style text: the words joined the way a shell hands them to the next shell. */
export const joinWords = (words: Word[]): string => texts(words).join(" ");

const DANGEROUS_VARIABLE = /^(?:LD_[A-Z_]+|DYLD_[A-Z_]+|BASH_ENV|ENV|PROMPT_COMMAND|SHELLOPTS|BASHOPTS|PS4|IFS|GIT_SSH|GIT_SSH_COMMAND|GIT_ASKPASS|GIT_EXEC_PATH|GIT_CONFIG[A-Z_]*|DOCKER_HOST|DOCKER_CONFIG|DOCKER_CONTEXT|SSH_AUTH_SOCK|(?:HTTPS?|ALL|NO)_PROXY|(?:https?|all|no)_proxy|LESSOPEN|LESSCLOSE|MANPAGER|VISUAL|EDITOR|GIT_EDITOR|PAGER|GIT_PAGER)$/;
const HARMLESS_VALUE = /^(?:cat|true|:|less|more|less -[A-Za-z]+)$/;

/** `NAME=value` that changes how programs are found, loaded or where they connect. */
export function assignmentFinding(entry: { text: string }, settings: Settings): Finding | undefined {
	const match = /^([A-Za-z_][A-Za-z0-9_]*)\+?=/.exec(entry.text);
	if (!match) return undefined;
	const name = match[1]!;
	const value = entry.text.slice(match[0].length).trim();
	if (/^(?:VISUAL|EDITOR|GIT_EDITOR|PAGER|GIT_PAGER|MANPAGER)$/.test(name) && HARMLESS_VALUE.test(value)) return undefined;
	if (DANGEROUS_VARIABLE.test(name) || (name === "PATH" && settings.workspaces.length === 0)) return found("system", `sets ${name}, which changes how programs are found or loaded, or where they connect`);
	return undefined;
}

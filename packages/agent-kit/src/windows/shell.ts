import { win32 } from "node:path";

/** Where Git for Windows keeps its bash, in the order they are tried. An explicit `WINDOWS_BASH` always wins and is never second-guessed. */
export function bashCandidates(env: Record<string, string | undefined>): string[] {
	const roots = [env.ProgramFiles ?? "C:\\Program Files", env["ProgramFiles(x86)"], env.LOCALAPPDATA ? win32.join(env.LOCALAPPDATA, "Programs") : undefined];
	return roots.filter((root): root is string => Boolean(root)).map((root) => win32.join(root, "Git", "bin", "bash.exe"));
}

/**
 * The bash the kit's git steps and the model's tools run through. The kit quotes commands the POSIX way, so cmd.exe and PowerShell are
 * not options, and the legacy `System32\bash.exe` (WSL) is refused: it would run the command inside a Linux distribution.
 */
export function chooseBash(options: { explicit?: string; candidates: string[]; exists: (path: string) => boolean }): string {
	if (options.explicit) {
		if (isWslLauncher(options.explicit)) throw new Error(`WINDOWS_BASH points at the WSL launcher (${options.explicit}); use the bash.exe of Git for Windows`);
		if (!options.exists(options.explicit)) throw new Error(`WINDOWS_BASH does not exist: ${options.explicit}`);
		return options.explicit;
	}
	const found = options.candidates.find((candidate) => !isWslLauncher(candidate) && options.exists(candidate));
	if (!found) throw new Error(`no Git for Windows bash found; looked in ${options.candidates.join(", ")}. Install Git for Windows or set WINDOWS_BASH`);
	return found;
}

export const isWslLauncher = (path: string): boolean => /^[a-z]:\\windows\\(?:system32|sysnative)\\bash\.exe$/i.test(path.replaceAll("/", "\\"));

/** Names the host passes through to every command, besides what `baseEnvironment` builds (build tools that need more list them in `WINDOWS_PASS_ENV`). */
export const DEFAULT_PASS_ENV = ["SystemRoot", "windir", "ComSpec", "PATHEXT", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "CommonProgramFiles", "CommonProgramFiles(x86)"];

export interface BaseEnvironmentOptions {
	root: string;
	/** The service's own environment: only `DEFAULT_PASS_ENV` and `passEnv` are copied from it. */
	host: Record<string, string | undefined>;
	/** Directories on PATH, in order (git, node, build tools). Default: Git for Windows, Node.js and the system directories. */
	pathDirectories?: string[];
	passEnv?: string[];
}

/** The default PATH of a command: Git for Windows (cmd, usr/bin for the unix tools, mingw64/bin), Node.js, and the Windows directories. */
export function defaultPathDirectories(host: Record<string, string | undefined>): string[] {
	const programFiles = host.ProgramFiles ?? "C:\\Program Files";
	const systemRoot = host.SystemRoot ?? "C:\\Windows";
	return [
		win32.join(programFiles, "Git", "cmd"),
		win32.join(programFiles, "Git", "usr", "bin"),
		win32.join(programFiles, "Git", "mingw64", "bin"),
		win32.join(programFiles, "nodejs"),
		win32.join(systemRoot, "System32"),
		systemRoot,
		win32.join(systemRoot, "System32", "Wbem"),
	];
}

/**
 * The whole environment of a command. Nothing else is inherited from the service (no tokens, no model credentials): HOME, TEMP and the git
 * configuration live inside the workspace root so a job cannot read or write the service account's real profile.
 */
export function baseEnvironment(options: BaseEnvironmentOptions): Record<string, string> {
	const home = win32.join(options.root, ".home");
	const temp = win32.join(options.root, ".tmp");
	const env: Record<string, string> = {
		PATH: (options.pathDirectories ?? defaultPathDirectories(options.host)).join(";"),
		HOME: home,
		USERPROFILE: home,
		TEMP: temp,
		TMP: temp,
		TMPDIR: temp,
		GIT_CONFIG_GLOBAL: win32.join(home, ".gitconfig"),
		GIT_TERMINAL_PROMPT: "0",
		GCM_INTERACTIVE: "never",
	};
	for (const name of [...DEFAULT_PASS_ENV, ...(options.passEnv ?? [])]) {
		const value = options.host[name];
		if (value !== undefined && !(name in env)) env[name] = value;
	}
	return env;
}

/**
 * Content of the per-service git configuration (`<root>\.home\.gitconfig`): long paths, no newline conversion, and an empty
 * `credential.helper`, which resets the helper list of Git for Windows' system configuration (Git Credential Manager) so the only helper
 * that ever answers is the host-restricted one the kit adds per command. The system configuration itself stays in effect: it carries the
 * CA bundle and TLS backend settings that HTTPS needs.
 */
export const GIT_CONFIG = ["[core]", "\tlongpaths = true", "\tautocrlf = false", "\tsafecrlf = false", "[pull]", "\tff = only", "[credential]", "\thelper =", ""].join("\n");

/** What a command's git may authenticate with: the hosts, the default token file and a token file per repository owner (lower case). */
export interface ShellGitAuth {
	hosts: string[];
	tokenFile?: string;
	ownerTokenFiles: Record<string, string>;
}

const shQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;
const forwardSlashes = (path: string): string => path.replaceAll("\\", "/");

/**
 * A git credential helper for the shell (POSIX sh, run by Git for Windows): it answers `get` only for the configured hosts, picks the token
 * file of the repository's owner (the first path segment, so `credential.useHttpPath` must be on) or the default one, and reads the file when
 * git asks, so a rotated token is used at once. It stores nothing and answers nothing for `store` and `erase`.
 */
export function credentialHelperScript(auth: ShellGitAuth): string {
	const owners = Object.entries(auth.ownerTokenFiles).map(([owner, file]) => `\t${shQuote(owner)}) file=${shQuote(forwardSlashes(file))};;`);
	return [
		"#!/bin/sh",
		'[ "$1" = get ] || exit 0',
		'host=""; path=""',
		'while IFS= read -r line; do case "$line" in host=*) host="${line#host=}";; path=*) path="${line#path=}";; "") break;; esac; done',
		`case " ${auth.hosts.join(" ")} " in *" $host "*) ;; *) exit 0;; esac`,
		`file=${shQuote(forwardSlashes(auth.tokenFile ?? ""))}`,
		'owner=$(printf %s "$path" | cut -d/ -f1 | tr "[:upper:]" "[:lower:]")',
		'case "$owner" in',
		...owners,
		"esac",
		'[ -n "$file" ] && [ -r "$file" ] || exit 0',
		"echo username=x-access-token",
		'printf "password=%s\\n" "$(cat "$file")"',
		"",
	].join("\n");
}

/** The per-service git configuration with the credential helper at `helperPath` (the default configuration when there is no auth). */
export function gitConfigFor(helperPath: string | undefined): string {
	if (!helperPath) return GIT_CONFIG;
	return [...GIT_CONFIG.split("\n").slice(0, -1), "\thelper = !sh " + shQuote(forwardSlashes(helperPath)), "\tuseHttpPath = true", ""].join("\n");
}

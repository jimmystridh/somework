import { existsSync } from "node:fs";
import { win32 } from "node:path";
import { resolveInside } from "./paths.ts";
import { bashCandidates, chooseBash, type ShellGitAuth } from "./shell.ts";

/** What every role that runs on Windows needs to know about its machine. Roles add their own settings next to these. */
export interface WindowsEnvSettings {
	/** `C:/somework/workspaces`: every workspace, temporary file and home directory of the agent lives below it. */
	root: string;
	bash: string;
	pathDirectories?: string[];
	passEnv: string[];
	maxOutputBytes?: number;
	/** Account whose leftover processes are stopped after a timeout or abort (the service account); requires one job at a time. */
	sweepUser?: string;
	/** Interface of the health endpoint (an IPv4 address of the machine); loopback unless a dashboard on another machine must read it. */
	healthBind?: string;
	/** Plain git in the shell authenticates with the role's own token files (`WINDOWS_SHELL_GIT_AUTH=1`); absent: the shell has no git credential. */
	shellGitAuth?: ShellGitAuth;
}

export const list = (value: string | undefined, separator: RegExp): string[] => (value ?? "").split(separator).map((item) => item.trim()).filter(Boolean);

/**
 * The settings of the confined Windows environment (a role's own settings, such as its profiles file, are read by the role; the kit's, such
 * as `SOMEWORK_URL` and `PI_PROVIDER`, by the kit).
 *   WINDOWS_WORKSPACE_ROOT  required, absolute path on a drive letter, no UNC
 *   WINDOWS_BASH            Git for Windows' bash.exe (default: looked up in the usual places)
 *   WINDOWS_PATH_DIRS       `;`-separated PATH of every command (default: Git for Windows, Node.js, system directories)
 *   WINDOWS_PASS_ENV        `,`-separated names copied from the service's environment into commands (build tools that need more than the defaults)
 *   WINDOWS_MAX_OUTPUT_BYTES per-command output cap
 *   WINDOWS_SWEEP_USER      the service account; after a timeout or abort every process of that account started during the command is stopped
 *                           (needs PI_CONCURRENCY=1, because the sweep cannot tell two simultaneous jobs apart)
 *   WINDOWS_SHELL_GIT_AUTH  `1`: the model's own git (clone, fetch, push) authenticates with the role's token files (GIT_TOKEN_FILE, GIT_TOKEN_OWNERS, hosts
 *                           GIT_TOKEN_HOSTS) through a host-restricted credential helper; without it the shell holds no git credential and only the kit's own git steps do
 *   WINDOWS_HEALTH_BIND     IPv4 address the health endpoint listens on (default 127.0.0.1; never 0.0.0.0, open the port to one reader with a firewall rule)
 */
export function loadWindowsEnvSettings(env: Record<string, string | undefined>, exists: (path: string) => boolean = existsSync): WindowsEnvSettings {
	const root = env.WINDOWS_WORKSPACE_ROOT;
	if (!root) throw new Error("missing required setting WINDOWS_WORKSPACE_ROOT");
	if (!/^[A-Za-z]:[\\/]/.test(root)) throw new Error(`WINDOWS_WORKSPACE_ROOT must be an absolute path on a drive letter: ${root}`);
	resolveInside(root, root, { flavour: "win32" }); // the same name rules as every path below it (no short names, streams, device names)
	const maxOutputBytes = env.WINDOWS_MAX_OUTPUT_BYTES === undefined ? undefined : Number(env.WINDOWS_MAX_OUTPUT_BYTES);
	if (maxOutputBytes !== undefined && (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 1024)) throw new Error("WINDOWS_MAX_OUTPUT_BYTES must be an integer of at least 1024");
	const pathDirectories = list(env.WINDOWS_PATH_DIRS, /;/);
	const sweepUser = env.WINDOWS_SWEEP_USER || undefined;
	if (sweepUser !== undefined) {
		if (!/^[A-Za-z0-9._$-]{1,64}$/.test(sweepUser)) throw new Error(`WINDOWS_SWEEP_USER is not a usable account name: ${sweepUser}`);
		if (Number(env.PI_CONCURRENCY ?? "2") !== 1) throw new Error("WINDOWS_SWEEP_USER needs PI_CONCURRENCY=1: the sweep cannot tell simultaneous jobs apart");
	}
	const healthBind = env.WINDOWS_HEALTH_BIND || undefined;
	if (healthBind !== undefined && (!/^(\d{1,3}\.){3}\d{1,3}$/.test(healthBind) || healthBind === "0.0.0.0" || healthBind.split(".").some((part) => Number(part) > 255))) {
		throw new Error(`WINDOWS_HEALTH_BIND must be one IPv4 address of this machine, not a wildcard: ${healthBind}`);
	}
	let shellGitAuth: ShellGitAuth | undefined;
	if (env.WINDOWS_SHELL_GIT_AUTH === "1") {
		const ownerTokenFiles: Record<string, string> = {};
		for (const entry of (env.GIT_TOKEN_OWNERS ?? "").split(";").map((item) => item.trim()).filter(Boolean)) {
			const at = entry.indexOf("=");
			if (at <= 0 || at === entry.length - 1) throw new Error("GIT_TOKEN_OWNERS entries look like owner=path, separated by semicolons");
			ownerTokenFiles[entry.slice(0, at).trim().toLowerCase()] = entry.slice(at + 1).trim();
		}
		if (!env.GIT_TOKEN_FILE && Object.keys(ownerTokenFiles).length === 0) throw new Error("WINDOWS_SHELL_GIT_AUTH=1 needs GIT_TOKEN_FILE or GIT_TOKEN_OWNERS");
		shellGitAuth = { hosts: list(env.GIT_TOKEN_HOSTS ?? "github.com", /[\s,]+/), ...(env.GIT_TOKEN_FILE ? { tokenFile: env.GIT_TOKEN_FILE } : {}), ownerTokenFiles };
	}
	return {
		root: win32.normalize(root).replaceAll("\\", "/").replace(/\/+$/, ""),
		bash: chooseBash({ explicit: env.WINDOWS_BASH || undefined, candidates: bashCandidates(env), exists }),
		pathDirectories: pathDirectories.length > 0 ? pathDirectories : undefined,
		passEnv: list(env.WINDOWS_PASS_ENV, /,/),
		maxOutputBytes,
		sweepUser,
		healthBind,
		...(shellGitAuth ? { shellGitAuth } : {}),
	};
}

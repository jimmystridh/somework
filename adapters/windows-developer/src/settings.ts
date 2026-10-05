import { existsSync } from "node:fs";
import { win32 } from "node:path";
import { resolveInside } from "./paths.ts";
import { bashCandidates, chooseBash } from "./shell.ts";

export interface WindowsSettings {
	/** `C:/somework/workspaces`: every workspace, temporary file and home directory of the agent lives below it. */
	root: string;
	bash: string;
	pathDirectories?: string[];
	passEnv: string[];
	profilesFile?: string;
	maxOutputBytes?: number;
}

const list = (value: string | undefined, separator: RegExp): string[] => (value ?? "").split(separator).map((item) => item.trim()).filter(Boolean);

/**
 * Settings that are specific to this role (the kit's own settings, such as `SOMEWORK_URL` and `PI_PROVIDER`, are read by the kit).
 *   WINDOWS_WORKSPACE_ROOT  required, absolute path on a drive letter, no UNC
 *   WINDOWS_BASH            Git for Windows' bash.exe (default: looked up in the usual places)
 *   WINDOWS_PATH_DIRS       `;`-separated PATH of every command (default: Git for Windows, Node.js, system directories)
 *   WINDOWS_PASS_ENV        `,`-separated names copied from the service's environment into commands (build tools that need more than the defaults)
 *   WINDOWS_PROFILES_FILE   JSON with the build/test profiles and the encoding policy
 *   WINDOWS_MAX_OUTPUT_BYTES per-command output cap
 */
export function loadWindowsSettings(env: Record<string, string | undefined>, exists: (path: string) => boolean = existsSync): WindowsSettings {
	const root = env.WINDOWS_WORKSPACE_ROOT;
	if (!root) throw new Error("missing required setting WINDOWS_WORKSPACE_ROOT");
	if (!/^[A-Za-z]:[\\/]/.test(root)) throw new Error(`WINDOWS_WORKSPACE_ROOT must be an absolute path on a drive letter: ${root}`);
	resolveInside(root, root, { flavour: "win32" }); // the same name rules as every path below it (no short names, streams, device names)
	const maxOutputBytes = env.WINDOWS_MAX_OUTPUT_BYTES === undefined ? undefined : Number(env.WINDOWS_MAX_OUTPUT_BYTES);
	if (maxOutputBytes !== undefined && (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 1024)) throw new Error("WINDOWS_MAX_OUTPUT_BYTES must be an integer of at least 1024");
	const pathDirectories = list(env.WINDOWS_PATH_DIRS, /;/);
	return {
		root: win32.normalize(root).replaceAll("\\", "/").replace(/\/+$/, ""),
		bash: chooseBash({ explicit: env.WINDOWS_BASH || undefined, candidates: bashCandidates(env), exists }),
		pathDirectories: pathDirectories.length > 0 ? pathDirectories : undefined,
		passEnv: list(env.WINDOWS_PASS_ENV, /,/),
		profilesFile: env.WINDOWS_PROFILES_FILE || undefined,
		maxOutputBytes,
	};
}

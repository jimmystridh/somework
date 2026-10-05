import { existsSync } from "node:fs";
import { loadWindowsEnvSettings, type WindowsEnvSettings } from "@somework/agent-kit/windows";

export interface WindowsSettings extends WindowsEnvSettings {
	profilesFile?: string;
}

/**
 * This role's settings: the confined environment's (`WINDOWS_WORKSPACE_ROOT`, `WINDOWS_BASH`, `WINDOWS_PATH_DIRS`, `WINDOWS_PASS_ENV`,
 * `WINDOWS_MAX_OUTPUT_BYTES`, `WINDOWS_SWEEP_USER`, read by the kit) and
 *   WINDOWS_PROFILES_FILE   JSON with the build/test profiles and the encoding policy
 * The kit's own settings, such as `SOMEWORK_URL` and `PI_PROVIDER`, are read by the kit.
 */
export function loadWindowsSettings(env: Record<string, string | undefined>, exists: (path: string) => boolean = existsSync): WindowsSettings {
	return { ...loadWindowsEnvSettings(env, exists), profilesFile: env.WINDOWS_PROFILES_FILE || undefined };
}

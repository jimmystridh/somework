import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { RoleHooks } from "../profile.ts";
import { localEnvFactory } from "./local-env.ts";
import type { WindowsEnvSettings } from "./settings.ts";
import { baseEnvironment, credentialHelperScript, gitConfigFor, type ShellGitAuth } from "./shell.ts";

export * from "./approvals.ts";
export * from "./local-env.ts";
export * from "./paths.ts";
export * from "./redact.ts";
export * from "./settings.ts";
export * from "./shell.ts";
export * from "./sweep.ts";

/** `TEMP` and the home directory of every command are inside the workspace root, so spill files and git configuration stay confined. */
export function prepareWindowsRoot(root: string, gitAuth?: ShellGitAuth): void {
	for (const dir of [root, `${root}/.tmp`, `${root}/.home`]) mkdirSync(dir, { recursive: true });
	const helper = `${root}/.home/git-credential-somework`;
	if (gitAuth) {
		const script = credentialHelperScript(gitAuth);
		if (!existsSync(helper) || readFileSync(helper, "utf8") !== script) writeFileSync(helper, script);
	}
	const gitConfig = `${root}/.home/.gitconfig`;
	const config = gitConfigFor(gitAuth ? helper : undefined);
	if (!existsSync(gitConfig) || readFileSync(gitConfig, "utf8") !== config) writeFileSync(gitConfig, config);
	process.env.TEMP = process.env.TMP = `${root}/.tmp`.replaceAll("/", "\\");
}

/**
 * The hooks every Windows role shares: commands and files go through the confined local environment (there is no container sandbox on
 * the machine), the health endpoint stays on loopback unless `WINDOWS_HEALTH_BIND` names one address, and readiness covers bash and a writable workspace root.
 */
export function windowsExecutionHooks(settings: WindowsEnvSettings): Pick<RoleHooks, "envFactory" | "healthBind" | "readinessChecks"> {
	prepareWindowsRoot(settings.root, settings.shellGitAuth);
	return {
		envFactory: localEnvFactory({
			root: settings.root,
			shellPath: settings.bash,
			sweepUser: settings.sweepUser,
			baseEnv: baseEnvironment({ root: settings.root, host: process.env, pathDirectories: settings.pathDirectories, passEnv: settings.passEnv }),
			maxOutputBytes: settings.maxOutputBytes,
		}),
		healthBind: settings.healthBind ?? "127.0.0.1",
		readinessChecks: {
			bash: async () => existsSync(settings.bash),
			workspace: async () => {
				const marker = `${settings.root}/.tmp/ready-${process.pid}`;
				writeFileSync(marker, "ok");
				return existsSync(marker);
			},
		},
	};
}

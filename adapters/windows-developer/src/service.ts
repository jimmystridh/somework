import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { runAgentService, type AgentProfile, type RoleHooks, type ServiceContext } from "@somework/agent-kit";
import { localEnvFactory } from "./local-env.ts";
import { profile as defaultProfile } from "./profile.ts";
import { loadProfiles } from "./profiles.ts";
import { createRole } from "./role.ts";
import { loadWindowsSettings, type WindowsSettings } from "./settings.ts";
import { baseEnvironment, GIT_CONFIG } from "./shell.ts";

/** `TEMP` and the home directory of every command are inside the workspace root, so spill files and git configuration stay confined. */
function prepareRoot(root: string): void {
	for (const dir of [root, `${root}/.tmp`, `${root}/.home`]) mkdirSync(dir, { recursive: true });
	const gitConfig = `${root}/.home/.gitconfig`;
	if (!existsSync(gitConfig) || readFileSync(gitConfig, "utf8") !== GIT_CONFIG) writeFileSync(gitConfig, GIT_CONFIG);
	process.env.TEMP = process.env.TMP = `${root}/.tmp`.replaceAll("/", "\\");
}

/**
 * The Windows developer's hooks for the kit's service: commands and files go through the confined local environment (there is no
 * container sandbox on this machine), the health endpoint stays on loopback, and the role's checks run between the model and git.
 */
export function windowsHooksFor(settings: WindowsSettings, context: ServiceContext): RoleHooks {
	prepareRoot(settings.root);
	const profiles = loadProfiles(settings.profilesFile);
	const role = createRole({ profiles, secrets: context.gitToken ? [context.gitToken] : [], log: context.log });
	context.log("info", "windows_profiles_loaded", { root: settings.root, build: Object.keys(profiles.build), test: Object.keys(profiles.test) });
	return {
		...role.hooks,
		envFactory: localEnvFactory({ root: settings.root, shellPath: settings.bash, sweepUser: settings.sweepUser, baseEnv: baseEnvironment({ root: settings.root, host: process.env, pathDirectories: settings.pathDirectories, passEnv: settings.passEnv }), maxOutputBytes: settings.maxOutputBytes }),
		healthBind: "127.0.0.1",
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

export function runWindowsService(options: { profile?: AgentProfile; env?: NodeJS.ProcessEnv } = {}): void {
	const env = options.env ?? process.env;
	const settings = loadWindowsSettings(env);
	runAgentService({
		profile: options.profile ?? defaultProfile,
		// the kit requires a sandbox URL and workspace root; here the "sandbox" is this process and its root is the confined directory
		env: { ...env, SANDBOX_URL: env.SANDBOX_URL ?? "local://windows", SANDBOX_WORKSPACES: settings.root },
		hooks: (context) => windowsHooksFor(settings, context),
	});
}

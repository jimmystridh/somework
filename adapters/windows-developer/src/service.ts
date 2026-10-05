import { runAgentService, type AgentProfile, type RoleHooks, type ServiceContext } from "@somework/agent-kit";
import { windowsExecutionHooks } from "@somework/agent-kit/windows";
import { profile as defaultProfile } from "./profile.ts";
import { loadProfiles } from "./profiles.ts";
import { createRole } from "./role.ts";
import { loadWindowsSettings, type WindowsSettings } from "./settings.ts";

/**
 * The Windows developer's hooks for the kit's service: commands and files go through the confined local environment (there is no
 * container sandbox on this machine), the health endpoint stays on loopback, and the role's checks run between the model and git.
 */
export function windowsHooksFor(settings: WindowsSettings, context: ServiceContext): RoleHooks {
	const profiles = loadProfiles(settings.profilesFile);
	const role = createRole({ profiles, secrets: context.gitToken ? [context.gitToken] : [], log: context.log });
	context.log("info", "windows_profiles_loaded", { root: settings.root, build: Object.keys(profiles.build), test: Object.keys(profiles.test) });
	return {
		...role.hooks,
		...windowsExecutionHooks(settings),
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

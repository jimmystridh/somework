import { fileURLToPath } from "node:url";
import { jsonLogger, runAgentService, type RoleHooks, type ServiceContext } from "@somework/agent-kit";
import { windowsExecutionHooks } from "@somework/agent-kit/windows";
import { loadAppProfiles, type AppEnv, type AppProfile } from "./app.ts";
import type { BrowserBackend } from "./browser/backend.ts";
import { GitHubPullFinder } from "./github-pulls.ts";
import { qaChat } from "./chat.ts";
import { createQaHooks } from "./hooks.ts";
import { JiraClient } from "./jira.ts";
import { createJiraTools, jiraToolApprovals } from "./jira-tools.ts";
import { qaProfile } from "./profile.ts";
import { QaSession } from "./session.ts";
import { loadQaEventSettings, seedHandler } from "./seed.ts";
import { loadQaSettings, readJiraSecrets, type QaSettings } from "./settings.ts";

const cliPath = fileURLToPath(new URL("./browser/cli.ts", import.meta.url)).replaceAll("\\", "/");

async function launchBrowser(settings: QaSettings, allowHosts: readonly string[]): Promise<BrowserBackend> {
	const { PlaywrightBackend } = await import("./browser/playwright.ts");
	return PlaywrightBackend.launch({ channel: settings.browser.channel, allowHosts });
}

/** Everything the service needs that depends on the machine and the deployment, in one place. */
export function composeQa(settings: QaSettings, context: ServiceContext, session: QaSession, profiles: Record<string, AppProfile>, tools?: ReturnType<typeof createJiraTools>, jiraClient?: JiraClient, jiraSecrets?: { token: string; passphrase?: string }): RoleHooks {
	const execution = windowsExecutionHooks(settings);
	context.log("info", "qa_configured", { profiles: Object.keys(profiles), ticketSystem: Boolean(settings.jira), browser: settings.browser.channel, allowHosts: settings.browser.allowHosts });
	seedHandler({ stateDir: context.config.state.dir, settings: loadQaEventSettings(context.env), log: context.log, reseed: context.env.QA_RESEED_HANDLER === "1" });
	const hooks = createQaHooks({
		root: settings.root,
		ticketPattern: settings.ticketPattern,
		profiles,
		session,
		appEnv: (cwd) => execution.envFactory!(cwd) as unknown as AppEnv,
		browser: (allowHosts) => launchBrowser(settings, allowHosts),
		allowHosts: settings.browser.allowHosts,
		cliPath,
		extensions: tools ? [tools.extension] : undefined,
		hasTicketSystem: Boolean(tools),
		pulls: new GitHubPullFinder({ token: (owner) => context.ownerTokens?.[owner.toLowerCase()] ?? context.gitToken }),
		...(jiraClient ? { ticketText: async (ticket: string) => [(await jiraClient.getIssue(ticket)).fields.description ?? "", ...(await jiraClient.comments(ticket)).map((comment) => comment.body)].join("\n\n") } : {}),
		verifiedLabel: settings.jira?.verifiedLabel ?? "AgentTested",
		client: context.client,
		log: context.log,
		secrets: [context.gitToken, ...Object.values(context.ownerTokens ?? {}), jiraSecrets?.token, jiraSecrets?.passphrase].filter((value): value is string => Boolean(value)),
	});
	return {
		...hooks,
		chat: qaChat(context.env, settings.ticketPattern, tools),
		...execution,
		readinessChecks: {
			...execution.readinessChecks,
			profiles: async () => Object.keys(profiles).length > 0,
			...(jiraClient ? { ticketSystem: async () => Boolean((await jiraClient.myself()).name) } : {}),
		},
	};
}

export function runQaService(options: { env?: NodeJS.ProcessEnv } = {}): void {
	const env = options.env ?? process.env;
	const settings = loadQaSettings(env);
	const profiles = loadAppProfiles(settings.profilesFile);
	if (Object.keys(profiles).length === 0) throw new Error("QA_PROFILES_FILE must configure at least one application profile");
	const session = new QaSession();
	const secrets = settings.jira ? readJiraSecrets(settings.jira) : undefined;
	const client = settings.jira && secrets ? new JiraClient({ baseUrl: settings.jira.url, token: secrets.token, pfx: secrets.pfx, passphrase: secrets.passphrase, ca: secrets.ca }) : undefined;
	const tools = client && settings.jira ? createJiraTools({ jira: client, session, pattern: settings.ticketPattern, testStatus: settings.jira.testStatus, inProgressStatus: settings.jira.inProgressStatus, verifiedLabel: settings.jira.verifiedLabel, log: jsonLogger() }) : undefined;
	runAgentService({
		profile: qaProfile({ toolNames: tools?.toolNames, toolApprovals: settings.jira ? jiraToolApprovals(session, settings.jira.verifiedLabel, settings.jira.inProgressStatus, settings.jira.approve) : undefined }),
		// the kit requires a sandbox URL and workspace root; here the "sandbox" is this process and its root is the confined directory
		env: { ...env, SANDBOX_URL: env.SANDBOX_URL ?? "local://windows", SANDBOX_WORKSPACES: settings.root, PI_CONCURRENCY: "1" },
		hooks: (context) => composeQa(settings, context, session, profiles, tools, client, secrets),
	});
}

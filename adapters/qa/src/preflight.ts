import { githubPreflightFor, type PreflightCheck, type RoleHooks, type ServiceContext } from "@somework/agent-kit";
import type { JiraClient } from "./jira.ts";

export const JIRA_CHECK = "jira";
export const BRANCHES_THROUGH_GIT = "branches are found through git instead";

/** Whether the ticket system answers the agent's own token (`/rest/api/2/myself`, one quick try): a certificate or token that stopped working shows here before a verification needs it. */
export async function jiraCheck(jira: Pick<JiraClient, "myself">): Promise<PreflightCheck> {
	try {
		const me = await jira.myself();
		if (me.name || me.displayName) return { name: JIRA_CHECK, ok: true, severity: "error" };
		return { name: JIRA_CHECK, ok: false, severity: "error", detail: "the ticket system answered without saying who the token belongs to" };
	} catch (error) {
		return { name: JIRA_CHECK, ok: false, severity: "error", detail: (error instanceof Error ? error.message : String(error)).slice(0, 200) };
	}
}

/**
 * What the QA agent cannot do well without, and only notices when a verification goes wrong: the git token reading the repository and its
 * pull requests (without the permission every lookup answers 403 and the agent falls back to branches, or to the default branch), and the
 * ticket system answering. Nothing blocks `/ready`: the existing readiness check already covers the ticket system being down.
 */
export function qaPreflight(context: ServiceContext, options: { jira?: Pick<JiraClient, "myself">; fetch?: typeof fetch } = {}): RoleHooks["preflight"] | undefined {
	const github = githubPreflightFor(context, { withoutPullRequests: BRANCHES_THROUGH_GIT, ...(options.fetch ? { fetch: options.fetch } : {}) });
	const jira = options.jira;
	if (!github && !jira) return undefined;
	return async (preflightContext) => [...(github ? await github(preflightContext) : []), ...(jira ? [await jiraCheck(jira)] : [])];
}

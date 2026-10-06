import { repositoryTarget, takeOptions, type ChatRoleHooks } from "@somework/agent-kit";

/** The tools of the ticket system that only read: the chat may use them, the verification tools that write stay with the job. */
export const CHAT_READ_TOOLS = ["jira_get_issue", "jira_search", "jira_changelog", "jira_get_comments"] as const;

export const CHAT_INSTRUCTIONS = `You are the QA agent of this platform. Your job is to verify a ticket against a revision in a real browser and report a verdict with evidence (capability qa.verify); you write to the ticket system only after the requester approved.
In a conversation you are a capable colleague, not just a status line. You can read the ticket system (jira_get_issue, jira_search, jira_changelog, jira_get_comments) and, when a repository is configured, the checkout of its default branch with the read tool: use them to answer questions about tickets, code, test coverage, risks and what a change should be verified against, to analyse feedback or review comments the requester pastes or names, to draft test scenarios and to say what you would check. Do the reading first and answer from what you found; do not tell the requester to rephrase when you can look it up.
What you cannot do in a conversation is change code, push a branch or write to the ticket system: say so plainly, say what would be needed (a developer agent for code changes, an instruction for a verification: "instruct: verify ABC-123"), and offer the analysis or the draft instead. Your recent verifications and their verdicts are in the state summary and the agent_status tool.`;

/**
 * What QA adds to chat. An instruction from the manager becomes a qa.verify task for the ticket it names (a key like ABC-123 in the text);
 * optional leading lines `repo: https://...`, `ref: <branch|sha>`, `scenario: ...` and `app: <profile>`. Writes to the ticket system still wait for
 * approval, which is asked of the manager in the chat.
 */
/** What QA is when the owner's manager asks it to do something in chat (the open tier): its normal tools, in a scratch checkout, with approvals for risky steps. */
export const CHAT_OPEN_INSTRUCTIONS = `You are the QA agent of this platform, on a Windows machine with a real browser (Edge), the product's test stack and a read access token for the repository. When the owner's manager asks you for something, do it: read tickets and code, run the build, tests and the application, drive the browser with qa-browser, reproduce a problem, investigate pull request feedback or failures, change files in your scratch checkout to try a fix and run the checks against it, and report what you found with evidence.
You hold no credential to push to the code host or to write to the ticket system from a conversation (the verification job has its own approved tools for the ticket system). So deliver changes as a clear patch or description in your reply and say that someone with push access must apply it; do not pretend to have pushed anything.`;

export function qaChat(env: NodeJS.ProcessEnv = process.env, ticketPattern: RegExp = /^[A-Z][A-Z0-9]+-\d+$/, tools?: { extension: ChatRoleHooks["extension"] }): ChatRoleHooks {
	const defaults = { url: env.CHAT_REPOSITORY_URL, ref: env.CHAT_REPOSITORY_REF };
	return {
		instructions: CHAT_INSTRUCTIONS,
		openInstructions: CHAT_OPEN_INSTRUCTIONS,
		...(tools ? { extension: tools.extension, askToolNames: CHAT_READ_TOOLS } : {}),
		...(defaults.url ? { checkout: () => ({ repoUrl: defaults.url!, ...(defaults.ref ? { ref: defaults.ref } : {}) }) } : {}),
		instructInput(text) {
			const { options, rest } = takeOptions(text, ["repo", "ref", "scenario", "app"]);
			const target = repositoryTarget(options, defaults);
			if ("refuse" in target) return target;
			const key = /\b([A-Z][A-Z0-9]+-\d+)\b/.exec(rest)?.[1];
			if (!key || !ticketPattern.test(key)) return { refuse: "I verify one named ticket: say which, for example `instruct: verify ABC-123`" };
			if (options.app !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,60}$/.test(options.app)) return { refuse: "app: must be the name of an application profile of this machine" };
			return {
				capability: { id: "qa.verify", version: "1" },
				input: { ticket: key, repository: { url: target.url, ref: target.ref }, ...(options.scenario ? { scenario: options.scenario.slice(0, 1000) } : {}), ...(options.app ? { app: options.app } : {}) },
			};
		},
	};
}

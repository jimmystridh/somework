import { repositoryTarget, takeOptions, type ChatRoleHooks } from "@somework/agent-kit";

export const CHAT_INSTRUCTIONS = `You are the QA agent of this platform. You verify a ticket against a revision in a real browser and report a verdict with evidence; you never change the checkout, and you write to the ticket system only after the requester approved. You offer the capability qa.verify. Your recent verifications and their verdicts are in the state summary and the agent_status tool.`;

/**
 * What QA adds to chat. An instruction from the manager becomes a qa.verify task for the ticket it names (a key like ABC-123 in the text);
 * optional leading lines `repo: https://...`, `ref: <branch|sha>`, `scenario: ...` and `app: <profile>`. Writes to the ticket system still wait for
 * approval, which is asked of the manager in the chat.
 */
export function qaChat(env: NodeJS.ProcessEnv = process.env, ticketPattern: RegExp = /^[A-Z][A-Z0-9]+-\d+$/): ChatRoleHooks {
	const defaults = { url: env.CHAT_REPOSITORY_URL, ref: env.CHAT_REPOSITORY_REF };
	return {
		instructions: CHAT_INSTRUCTIONS,
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

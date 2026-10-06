import type { ChatRoleHooks } from "@somework/agent-kit";
import { repositoryTarget, takeOptions } from "@somework/agent-kit";

/** Standing orders for answering questions in chat. */
export const CHAT_INSTRUCTIONS = `You are the developer agent of this platform. You change code in a sandbox: you work on a branch named agent/<task>, commit, push it and open a pull request; you never merge or deploy. You offer the capability code.agent. Your recent tasks and their outcomes are in the state summary and the agent_status tool; the workspaces of your recent tasks are readable with the read tool.`;

/**
 * What the developer role adds to chat. An instruction from the manager (`instruct: ...`) becomes a code.agent task of its own: optional leading
 * lines `repo: https://...` and `ref: <branch>` choose the repository (else CHAT_REPOSITORY_URL and CHAT_REPOSITORY_REF), the rest is the
 * instruction. It then runs like any task: same sandbox, same approvals, the branch and pull request are made by the service.
 */
export function developerChat(env: NodeJS.ProcessEnv = process.env): ChatRoleHooks {
	const defaults = { url: env.CHAT_REPOSITORY_URL, ref: env.CHAT_REPOSITORY_REF };
	return {
		instructions: CHAT_INSTRUCTIONS,
		instructInput(text) {
			const { options, rest } = takeOptions(text, ["repo", "ref"]);
			const target = repositoryTarget(options, defaults);
			if ("refuse" in target) return target;
			if (rest === "") return { refuse: "there is no instruction after the repository lines" };
			return { capability: { id: "code.agent", version: "2" }, input: { repository: { url: target.url, ref: target.ref }, instruction: rest } };
		},
	};
}

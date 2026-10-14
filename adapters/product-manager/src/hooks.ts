import { githubPreflightFor, InvalidInput, type RoleHooks, type ServiceContext } from "@somework/agent-kit";
import { productManagerChat } from "./chat.ts";
import { createGuard } from "./guard.ts";

/** The reply to a task for the only capability: it is a conversation, so the task is refused with the way to talk to the agent. */
export const NOT_A_JOB = "product.intake is a conversation: send the agent a message instead of a task";

/**
 * The role's code on top of the kit's conversations:
 *  - the guard that keeps `bash` to plain inspection and a ticket short enough to be approved in full;
 *  - the chat: its standing orders and the read-only checkout of the repository (CHAT_REPOSITORY_URL, CHAT_REPOSITORY_REF);
 *  - `prepareInput` refuses a task: the capability is served in conversation.
 */
export function createProductManagerHooks(env: NodeJS.ProcessEnv = process.env): RoleHooks {
	const url = env.CHAT_REPOSITORY_URL?.trim();
	const ref = env.CHAT_REPOSITORY_REF?.trim();
	return {
		extensions: [createGuard()],
		chat: productManagerChat(url ? { repository: { url, ...(ref ? { ref } : {}) } } : {}),
		prepareInput() {
			throw new InvalidInput(NOT_A_JOB);
		},
	};
}

/** For `runAgentService`: the hooks of the service being composed. */
export function productManagerHooksFor(context: ServiceContext): RoleHooks {
	const preflight = githubPreflightFor(context, { withoutPullRequests: "the product manager reads the repository without the pull request's description, files and checks" });
	return { ...createProductManagerHooks(context.env), ...(preflight ? { preflight } : {}) };
}

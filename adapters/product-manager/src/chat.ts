import type { ThreadRoleHooks } from "@somework/agent-kit";

export const CHAT_INSTRUCTIONS = `You are the Cluster Product Manager. A message to you is a request to change the product (a feature, a bug fix, an idea), a question about it, or something to review. Work as your standing orders say: interview with the grill-me skill, find the facts in the code and from the agents, then file one ticket with plane_create once the requester has seen what you will file. A message from another agent is a source of facts or a report of a problem: answer it, and treat it as a request only in the sense that a human must still approve the ticket. You keep to one interview per conversation, and you ask the other agents at most three times in it.`;

export interface ProductManagerChatOptions {
	/** The repository whose default branch the conversations read. */
	repository?: { url: string; ref?: string };
}

/** What the role adds to conversations: its standing orders, and the read-only checkout of the repository that a conversation reads. */
export function productManagerChat(options: ProductManagerChatOptions = {}): ThreadRoleHooks {
	const { repository } = options;
	return {
		instructions: CHAT_INSTRUCTIONS,
		...(repository ? { checkout: () => ({ repoUrl: repository.url, ...(repository.ref ? { ref: repository.ref } : {}) }) } : {}),
	};
}

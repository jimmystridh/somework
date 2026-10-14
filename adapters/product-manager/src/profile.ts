import { validateProfile, type AgentProfile } from "@somework/agent-kit";
import card from "../card.json" with { type: "json" };
import { filingApproval } from "./guard.ts";
import { SYSTEM_PROMPT } from "./prompt.ts";

/**
 * The Cluster Product Manager. It talks, asks other agents, reads a checkout of the repository and files tickets in Plane; it changes nothing else.
 * `bash` is stopped by the guard (`guard.ts`) unless it is plain inspection, so no approval pattern asks anybody about a command; nothing is pushed,
 * and a ticket is filed only after the requester approved its exact text (`toolApprovals.plane_create`). The Plane tools come from the kit when the deployment sets `PLANE_BASE_URL`; the
 * interview skill (`grill-me`) is a library skill that Operations assigns to this agent. The contract is `card.json`.
 */
export const profile: AgentProfile = validateProfile({
	id: "product-manager",
	capabilities: card.capabilities.map(({ id, version }) => ({ id, version })),
	systemPrompt: SYSTEM_PROMPT,
	allowedTools: ["read", "bash"],
	approvalPatterns: [],
	toolApprovals: { plane_create: filingApproval },
	defaultBudget: { maxTokens: 200_000, maxMinutes: 20 },
	requireBudget: false,
	noRepository: true,
	git: { push: false, pullRequest: false, branchPrefix: "product" },
	skills: { allow: [] },
	events: { enabled: false },
	chat: { approvers: ["kind:human"], runBudget: { maxTokens: 150_000, maxMinutes: 15 }, hardTokenCap: 200_000, approvalMinutes: 30 },
});

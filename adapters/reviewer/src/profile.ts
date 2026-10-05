import { validateProfile, type AgentProfile } from "@somework/agent-kit";
import card from "../card.json" with { type: "json" };
import { REVIEW_APPROVAL_PATTERNS } from "./commands.ts";
import { SYSTEM_PROMPT } from "./prompt.ts";

/**
 * The reviewer role: reads a branch, returns findings. Nothing leaves the workspace (no commit, no push, no pull request), the model is
 * offered only `read` and `bash`, and `bash` is restricted to plain inspection by the approval patterns. The contract is `card.json`.
 * The repository's own review skills are opt-in by name: the default list is empty and the deployment supplies it with SKILLS_ALLOW.
 */
export const profile: AgentProfile = validateProfile({
	id: "reviewer",
	capabilities: card.capabilities.map(({ id, version }) => ({ id, version })),
	systemPrompt: SYSTEM_PROMPT,
	allowedTools: ["read", "bash"],
	approvalPatterns: REVIEW_APPROVAL_PATTERNS,
	defaultBudget: { maxTokens: 300_000, maxMinutes: 20 },
	requireBudget: true,
	git: { push: false, pullRequest: false, branchPrefix: "review" },
	skills: { allow: [] },
});

import { validateProfile, type AgentProfile } from "@somework/agent-kit";
import { WINDOWS_APPROVAL_PATTERNS } from "@somework/agent-kit/windows";
import card from "../card.json" with { type: "json" };
import { SYSTEM_PROMPT } from "./prompt.ts";

/** The QA agent verifies and never changes the checkout: anything that would is asked about, on top of the Windows machine rules. */
export const QA_APPROVAL_PATTERNS: [RegExp, string][] = [
	...WINDOWS_APPROVAL_PATTERNS,
	[/\bgit\s+(commit|add|reset|clean|stash|rebase|merge|cherry-pick|apply|restore|am|revert|rm|mv)\b/, "change the checkout (QA only verifies)"],
];

export interface QaProfileOptions {
	/** Names of the ticket-system tools in play; none when no ticket system is connected. */
	toolNames?: readonly string[];
	toolApprovals?: AgentProfile["toolApprovals"];
}

/**
 * The QA role: reads a revision, runs the application, drives a browser, reports a verdict. Nothing leaves the workspace through git (no
 * commit, no push, no pull request). The model is offered `read`, `bash` and the ticket-system tools; the deployment names the repository's
 * QA skill with SKILLS_ALLOW. The contract is `card.json`.
 */
export function qaProfile(options: QaProfileOptions = {}): AgentProfile {
	return validateProfile({
		id: "qa",
		capabilities: card.capabilities.map(({ id, version }) => ({ id, version })),
		systemPrompt: SYSTEM_PROMPT,
		allowedTools: ["read", "bash", ...(options.toolNames ?? [])],
		approvalPatterns: QA_APPROVAL_PATTERNS,
		...(options.toolApprovals ? { toolApprovals: options.toolApprovals } : {}),
		defaultBudget: { maxTokens: 2_000_000, maxMinutes: 60 },
		// a verification asked for in chat is the same job as the task, with the same needs: the browser run read the whole conversation again on every step
		// and used 800k tokens in 12 minutes at 30k per step, so an instruction may use what the task may, from a chat pool that can carry it
		chat: { instructBudget: { maxTokens: 2_000_000, maxMinutes: 60 }, hardTokenCap: 2_500_000, share: 0.5 },
		requireBudget: true,
		git: { push: false, pullRequest: false, branchPrefix: "qa" },
		skills: { allow: [] },
		events: { enabled: false },
	});
}

export const profile: AgentProfile = qaProfile();

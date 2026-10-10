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
 * QA skill with SKILLS_ALLOW. Events are on: the shipped handler turns a ticket moving into the test status into a `qa.verify` job for the agent
 * itself (`src/handlers/qa-ticket.mjs`). The contract is `card.json`.
 */
export function qaProfile(options: QaProfileOptions = {}): AgentProfile {
	return validateProfile({
		id: "qa",
		capabilities: card.capabilities.map(({ id, version }) => ({ id, version })),
		systemPrompt: SYSTEM_PROMPT,
		allowedTools: ["read", "bash", ...(options.toolNames ?? [])],
		approvalPatterns: QA_APPROVAL_PATTERNS,
		...(options.toolApprovals ? { toolApprovals: options.toolApprovals } : {}),
		defaultBudget: { maxTokens: 4_000_000, maxMinutes: 60 },
		// a conversation of QA reads tickets, code and logs and may drive the browser by hand: it gets more than the default of a conversation (a verification is a job with the budget above)
		chat: { runBudget: { maxTokens: 1_500_000, maxMinutes: 30 }, hardTokenCap: 2_000_000, share: 0.3 },
		requireBudget: true,
		git: { push: false, pullRequest: false, branchPrefix: "qa" },
		skills: { allow: [] },
		events: { enabled: true, notifyTo: "agent/manager", submitBudgetCap: { maxTokens: 4_000_000, maxMinutes: 60 } },
	});
}

export const profile: AgentProfile = qaProfile();

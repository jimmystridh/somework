import { DEFAULT_APPROVAL_PATTERNS, validateProfile, type AgentProfile } from "@somework/agent-kit";
import card from "../card.json" with { type: "json" };
import { SYSTEM_PROMPT } from "./prompt.ts";

/**
 * The developer role's approval patterns plus everything that would change the branch or history behind the service's back. Nobody answers
 * for this agent, so a command that matches is refused (see `AutoDenyRuntime`), which is the intent.
 */
export const FIXER_APPROVAL_PATTERNS: [RegExp, string][] = [
	...DEFAULT_APPROVAL_PATTERNS,
	[/\bgit\s+(commit|checkout|switch|reset|rebase|merge|cherry-pick|revert|branch|tag|remote|config|stash|clean|am|apply)\b/, "change the branch, the history or the git configuration (the service commits and pushes)"],
	[/\b(gh|hub)\s+(pr|repo|api|auth|issue|release|secret)\b/, "use the code host's command line (the service opens the pull request)"],
];

/** The event handler tools would let a prompt-injected run rewrite the gate that starts fix tasks: they need an approval, which is always refused here. */
const HANDLER_WRITES = "change the agent's event handlers";

/**
 * The Aikido fixer: fixes one reported issue in a fresh clone and opens a pull request (a draft when GIT_PR_DRAFT=1). The model gets the coding tools and one
 * read-only Aikido tool; bash goes through the patterns above. Events are on: the shipped handler turns Aikido events into `code.fix`
 * tasks for this same agent. The contract is `card.json`.
 */
export const profile: AgentProfile = validateProfile({
	id: "aikido-fixer",
	capabilities: card.capabilities.map(({ id, version }) => ({ id, version })),
	systemPrompt: SYSTEM_PROMPT,
	allowedTools: ["read", "write", "edit", "bash", "aikido_issue"],
	approvalPatterns: FIXER_APPROVAL_PATTERNS,
	toolApprovals: { handler_save: () => HANDLER_WRITES, handler_disable: () => HANDLER_WRITES, handler_enable: () => HANDLER_WRITES },
	defaultBudget: { maxTokens: 300_000, maxMinutes: 30 },
	requireBudget: true,
	git: { push: true, pullRequest: true, branchPrefix: "agent" },
	skills: { allow: [] },
	events: { enabled: true, notifyTo: "agent/manager", submitBudgetCap: { maxTokens: 300_000, maxMinutes: 30 } },
});

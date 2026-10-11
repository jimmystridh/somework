import { DEFAULT_APPROVAL_PATTERNS, validateProfile, type AgentProfile } from "@somework/agent-kit";
import card from "../card.json" with { type: "json" };
import { SYSTEM_PROMPT } from "./prompt.ts";

/** What a model run of this role is told when it asks to run a command or write a file: it has no use for either, and the answer never depends on a person. */
export const NO_SHELL = "this agent has no use for a shell or for files: use the ticket tools";

/** The event handler tools would let a prompt-injected run rewrite the gate that starts triage jobs: they need an approval, which is always refused here. */
const HANDLER_WRITES = "change the agent's event handlers";

/**
 * The Jira triage role. A triage is code, not a model run: the checklist, the questions, the queue and the writes are `engine.ts`, started by the shipped
 * event handler as a `jira.triage` job that ends in the `result` hook without a model call. The model takes part only in conversations (Slack): it searches
 * tickets, drafts, checks a draft against the checklist and creates the ticket, all through the tools of `chat.ts`. The sandbox has no credentials and no
 * network, and the profile asks for an approval for every command and every file write, which `wrapRuntime` refuses: the model has the ticket tools and
 * nothing else. The contract is `card.json`.
 */
export const profile: AgentProfile = validateProfile({
	id: "jira-triage",
	capabilities: card.capabilities.map(({ id, version }) => ({ id, version })),
	systemPrompt: SYSTEM_PROMPT,
	allowedTools: ["read"],
	approvalPatterns: DEFAULT_APPROVAL_PATTERNS,
	toolApprovals: {
		bash: () => NO_SHELL,
		write: () => NO_SHELL,
		edit: () => NO_SHELL,
		handler_save: () => HANDLER_WRITES,
		handler_disable: () => HANDLER_WRITES,
		handler_enable: () => HANDLER_WRITES,
	},
	defaultBudget: { maxTokens: 50_000, maxMinutes: 10 },
	requireBudget: false,
	noRepository: true,
	git: { push: false, pullRequest: false, branchPrefix: "triage" },
	skills: { allow: [] },
	chat: { runBudget: { maxTokens: 120_000, maxMinutes: 10 } },
	events: { enabled: true, notifyTo: "agent/manager", submitBudgetCap: { maxTokens: 50_000, maxMinutes: 10 } },
});

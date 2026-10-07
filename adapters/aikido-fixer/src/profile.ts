import { DEFAULT_APPROVAL_PATTERNS, validateProfile, type AgentProfile } from "@somework/agent-kit";
import card from "../card.json" with { type: "json" };
import { SYSTEM_PROMPT } from "./prompt.ts";

/** A RegExp whose `test` asks a predicate: `approvalPolicy` only calls `test`, so a pattern can be a function of the command. */
class CommandPattern extends RegExp {
	readonly #matches: (command: string) => boolean;
	constructor(matches: (command: string) => boolean) {
		super("(?:)");
		this.#matches = matches;
	}
	override test(command: string): boolean {
		return this.#matches(command);
	}
}

const ALWAYS_CHANGES = /\bgit\s+(?:-C\s+\S+\s+)?(?:commit|checkout|switch|reset|rebase|merge|cherry-pick|revert|stash|clean|am|apply)\b/;
const BRANCH_READ = new Set(["-a", "-r", "-v", "-vv", "--list", "--show-current", "--contains", "--merged", "--no-merged", "--all", "--remotes"]);

/** Whether a command changes the branch, the history or the git configuration. Looking (status, log, diff, `branch --show-current`, `remote -v`, `config --get`) is not a change. */
export function changesGit(command: string): boolean {
	if (ALWAYS_CHANGES.test(command)) return true;
	for (const match of command.matchAll(/\bgit\s+(?:-C\s+\S+\s+)?(branch|tag|remote|config)\b([^;&|\n]*)/g)) {
		const args = match[2]!.trim().split(/\s+/).filter(Boolean);
		switch (match[1]) {
			case "branch":
				if (!args.every((arg) => BRANCH_READ.has(arg) || !arg.startsWith("-"))) return true;
				if (args.some((arg) => !arg.startsWith("-")) && !args.some((arg) => ["--list", "--contains", "--merged", "--no-merged"].includes(arg))) return true;
				break;
			case "tag":
				if (args.length > 0 && !args.some((arg) => arg === "-l" || arg === "--list")) return true;
				break;
			case "remote":
				if (args.length > 0 && !args.every((arg) => arg === "-v" || arg === "show" || arg === "get-url" || arg === "--verbose" || !arg.startsWith("-"))) return true;
				if (args.some((arg) => ["add", "remove", "rm", "rename", "set-url", "set-head", "set-branches", "prune", "update"].includes(arg))) return true;
				break;
			case "config":
				if (!args.some((arg) => ["--get", "--get-all", "--list", "-l", "--get-regexp"].includes(arg))) return true;
				break;
		}
	}
	return false;
}

/**
 * The developer role's approval patterns plus everything that would change the branch or history behind the service's back. Nobody answers
 * for this agent, so a command that matches is refused (see `AutoDenyRuntime`), which is the intent.
 */
export const FIXER_APPROVAL_PATTERNS: [RegExp, string][] = [
	...DEFAULT_APPROVAL_PATTERNS,
	[new CommandPattern(changesGit), "change the branch, the history or the git configuration (the service commits and pushes)"],
	[/\b(gh|hub)\s+(?!(pr|issue|release)\s+(view|list|diff|checks|status)\b)(pr|repo|api|auth|issue|release|secret)\b/, "use the code host's command line (the service opens the pull request)"],
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

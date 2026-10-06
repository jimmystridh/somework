import { DEFAULT_APPROVAL_PATTERNS, validateProfile, type AgentProfile } from "@somework/agent-kit";
import card from "../card.json" with { type: "json" };
import { bashApproval, checkFileTool, REFUSED, workspaceRelative } from "./commands.ts";
import { DATADOG_TOOLS } from "./datadog/tools.ts";
import { SYSTEM_PROMPT } from "./prompt.ts";

/** The event handler tools would let a prompt-injected run rewrite the gate that starts triage tasks: they need an approval, which is always refused here. */
const HANDLER_WRITES = "change the agent's event handlers";

/** `read` stays inside the workspace: the files the model saved and wrote, nothing else of the sandbox. */
const readApproval = (args: Record<string, unknown>): string | undefined =>
	typeof args.path === "string" && workspaceRelative(args.path) !== undefined ? undefined : `${REFUSED}: read reads files inside the workspace only (data/ and scratch/)`;

/**
 * The Datadog triage role: investigates one monitor alert and reports a structured diagnosis. It works on no repository (`noRepository`:
 * the model gets an empty scratch directory), pushes nothing and has no way to change anything outside that directory. The model is
 * offered the six read-only Datadog tools (which run in the service, where the keys are) plus `read`, `write`, `edit` and `bash` for
 * analysis of saved results; the sandbox has no credentials and no network. `bash` runs only the commands of `commands.ts`, `write` and
 * `edit` only change `data/` and `scratch/`. Events are on: the shipped handler turns Datadog monitor events into `ops.triage` tasks for this
 * same agent. The contract is `card.json`.
 */
export const profile: AgentProfile = validateProfile({
	id: "datadog-triage",
	capabilities: card.capabilities.map(({ id, version }) => ({ id, version })),
	systemPrompt: SYSTEM_PROMPT,
	allowedTools: ["read", "write", "edit", "bash", ...DATADOG_TOOLS],
	approvalPatterns: DEFAULT_APPROVAL_PATTERNS,
	toolApprovals: {
		bash: bashApproval,
		write: (args) => checkFileTool("write", args),
		edit: (args) => checkFileTool("edit", args),
		read: readApproval,
		handler_save: () => HANDLER_WRITES,
		handler_disable: () => HANDLER_WRITES,
		handler_enable: () => HANDLER_WRITES,
	},
	defaultBudget: { maxTokens: 150_000, maxMinutes: 10 },
	requireBudget: true,
	noRepository: true,
	git: { push: false, pullRequest: false, branchPrefix: "triage" },
	skills: { allow: [] },
	events: { enabled: true, notifyTo: "agent/manager", submitBudgetCap: { maxTokens: 300_000, maxMinutes: 20 } },
});

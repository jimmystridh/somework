import { validateProfile, type AgentProfile } from "@somework/agent-kit";
import card from "../card.json" with { type: "json" };
import { bashApproval, currentSettings, fileApproval, hostExecApproval } from "./approvals.ts";
import { SYSTEM_PROMPT } from "./prompt.ts";
import { CLUSTER_TOOLS } from "./tools/index.ts";

/**
 * The cluster development agent: does the work a developer does in this cluster and asks the owner only before destructive actions.
 * The model is offered the coding tools (which run in a sandbox with no secrets and no way into the cluster), the five host-side tools
 * of `tools/` (which run in the service, where the keys and tokens are) and the kit's observe tools over the whole fleet. What needs the
 * owner is decided by `classifier/`: `bash` and `host_exec` ask through the approval gate when the classifier says destructive, and `read`,
 * `write` and `edit` ask for files that hold secrets. Only people may answer. The contract is `card.json`.
 */
export const profile: AgentProfile = validateProfile({
	id: "cluster-dev",
	capabilities: card.capabilities.map(({ id, version }) => ({ id, version })),
	systemPrompt: SYSTEM_PROMPT,
	allowedTools: ["read", "write", "edit", "bash", ...CLUSTER_TOOLS],
	approvalPatterns: [],
	toolApprovals: {
		bash: (args) => bashApproval(args, currentSettings()),
		host_exec: (args) => hostExecApproval(args, currentSettings()),
		read: (args) => fileApproval("read", args),
		write: (args) => fileApproval("write", args),
		edit: (args) => fileApproval("edit", args),
	},
	defaultBudget: { maxTokens: 500_000, maxMinutes: 30 },
	requireBudget: true,
	git: { push: true, pullRequest: true, branchPrefix: "cluster" },
	skills: { allow: [] },
	events: { enabled: false },
	// the whole fleet's logs and metrics: a developer looks at every agent (the deployment turns it on with OBSERVE_ENABLED=1 and the Grafana settings)
	observe: { scope: { fleet: true }, maxRangeHours: 168 },
	chat: { approvers: ["kind:human"], runBudget: { maxTokens: 400_000, maxMinutes: 30 }, hardTokenCap: 500_000, approvalMinutes: 30 },
});

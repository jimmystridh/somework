import { DEFAULT_APPROVAL_PATTERNS, validateProfile, type AgentProfile } from "@somework/agent-kit";
import card from "../card.json" with { type: "json" };

/** The developer role: changes code in a sandbox, pushes `agent/<task>` and opens a pull request. The contract is `card.json`. */
export const profile: AgentProfile = validateProfile({
	id: "developer",
	capabilities: card.capabilities.map(({ id, version }) => ({ id, version })),
	approvalPatterns: DEFAULT_APPROVAL_PATTERNS,
	defaultBudget: { maxTokens: 500_000, maxMinutes: 20 },
	requireBudget: true,
	git: { push: true, pullRequest: true, branchPrefix: "agent" },
	// the repository's own skills are opt-in per deployment: SKILLS_ALLOW=name,name (and SKILLS_OVERLAY_DIR)
	skills: { allow: [] },
	events: { enabled: false },
	// read-only Grafana/Loki tools: still off until OBSERVE_ENABLED=1 and GRAFANA_URL/GRAFANA_TOKEN_FILE are set; a developer may look at the whole fleet
	observe: { scope: { fleet: true } },
});

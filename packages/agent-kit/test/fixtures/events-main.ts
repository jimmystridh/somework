import { DEFAULT_APPROVAL_PATTERNS } from "../../src/policy.ts";
import { runAgentService } from "../../src/service.ts";

/** A minimal role with events turned on, for the end-to-end test: it serves `code.agent` and keeps nothing it does in git. */
runAgentService({
	profile: {
		id: "events-fixture",
		capabilities: [{ id: "code.agent", version: "1" }],
		approvalPatterns: DEFAULT_APPROVAL_PATTERNS,
		defaultBudget: { maxTokens: 100_000, maxMinutes: 5 },
		git: { push: false, pullRequest: false, branchPrefix: "agent" },
		skills: { allow: [] },
		events: { enabled: true, notifyTo: "agent/ts-author", controllers: ["agent/ts-author"], accept: ["test.*"] },
	},
});

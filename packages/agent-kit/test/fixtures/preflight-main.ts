import { DEFAULT_APPROVAL_PATTERNS } from "../../src/policy.ts";
import { runAgentService } from "../../src/service.ts";

/** A minimal role whose preflight answers what PREFLIGHT_FIXTURE says; `$TOKEN` in a detail is replaced by the service's token, to prove that the kit scrubs it. */
runAgentService({
	profile: {
		id: "preflight-fixture",
		capabilities: [{ id: "code.agent", version: "1" }],
		approvalPatterns: DEFAULT_APPROVAL_PATTERNS,
		defaultBudget: { maxTokens: 100_000, maxMinutes: 5 },
		git: { push: false, pullRequest: false, branchPrefix: "agent" },
		noRepository: true,
		requireBudget: false,
		skills: { allow: [] },
	},
	hooks: (context) => ({
		preflight: async () => (JSON.parse(process.env.PREFLIGHT_FIXTURE ?? "[]") as { detail?: string }[]).map((check) => ({ ...check, ...(check.detail ? { detail: check.detail.replace("$TOKEN", context.gitToken ?? "") } : {}) })) as never,
	}),
});

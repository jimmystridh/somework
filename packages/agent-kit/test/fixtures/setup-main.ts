import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { DEFAULT_APPROVAL_PATTERNS } from "../../src/policy.ts";
import { runAgentService } from "../../src/service.ts";

/** A minimal role that runs on the machine (no sandbox) for the test of how the service starts with a stored setup. */
runAgentService({
	profile: {
		id: "setup-fixture",
		capabilities: [{ id: "code.agent", version: "1" }],
		systemPrompt: "You are the fixture.",
		approvalPatterns: DEFAULT_APPROVAL_PATTERNS,
		defaultBudget: { maxTokens: 100_000, maxMinutes: 5 },
		git: { push: false, pullRequest: false, branchPrefix: "agent" },
		noRepository: true,
		requireBudget: false,
		skills: { allow: ["verify-skill"] },
	},
	hooks: { envFactory: (cwd) => new NodeExecutionEnv({ cwd: cwd ?? process.cwd() }) },
});

import { DEFAULT_APPROVAL_PATTERNS } from "../../src/policy.ts";
import { runAgentService } from "../../src/service.ts";

/** A minimal role that answers chat with a model: instructions become code.agent tasks on the repository the test names. */
runAgentService({
	profile: {
		id: "chat-fixture",
		capabilities: [{ id: "code.agent", version: "1" }],
		approvalPatterns: DEFAULT_APPROVAL_PATTERNS,
		defaultBudget: { maxTokens: 100_000, maxMinutes: 5 },
		git: { push: true, pullRequest: false, branchPrefix: "agent" },
		skills: { allow: [] },
		allowedTools: ["read", "write", "edit", "bash"],
	},
	hooks: {
		chat: {
			instructions: "You are the chat fixture.",
			context: () => "fixture fact: the sky is blue",
			instructInput: (text) => ({ capability: { id: "code.agent", version: "1" }, input: { repository: { url: process.env.FIXTURE_REMOTE, ref: "main" }, instruction: text } }),
		},
	},
});

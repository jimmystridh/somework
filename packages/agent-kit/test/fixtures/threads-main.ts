import { Type } from "@earendil-works/pi-ai";
import { DEFAULT_APPROVAL_PATTERNS } from "../../src/policy.ts";
import { runAgentService } from "../../src/service.ts";

/** A minimal role for the end-to-end test of conversations and jobs: it serves `code.agent` without a repository and has one job tool. */
runAgentService({
	profile: {
		id: "threads-fixture",
		capabilities: [{ id: "code.agent", version: "1" }],
		approvalPatterns: DEFAULT_APPROVAL_PATTERNS,
		defaultBudget: { maxTokens: 100_000, maxMinutes: 5 },
		git: { push: false, pullRequest: false, branchPrefix: "agent" },
		noRepository: true,
		requireBudget: false,
		skills: { allow: [] },
		chat: { approvers: ["agent/ts-author"] },
	},
	hooks: {
		chat: {
			jobResources: () => ["demo-stack"],
			jobTools: [
				{
					name: "start_demo",
					description: "Run the demo job for a topic.",
					parameters: Type.Object({ topic: Type.String() }),
					plan: (args: { topic: string }) => ({ capability: { id: "code.agent", version: "1" }, input: { instruction: `demo ${args.topic}` }, label: `demo ${args.topic}` }),
				},
			],
		},
	},
});

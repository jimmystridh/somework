import { Type } from "@earendil-works/pi-ai";
import { repositoryTarget, type JobPlan, type JobTool, type ThreadRoleHooks } from "@somework/agent-kit";

/** Standing orders for conversations. */
export const CHAT_INSTRUCTIONS = `You are the developer agent of this platform. You change code in a sandbox: for a change you start a job that works on a branch named agent/<job>, commits, pushes it and opens a pull request; you never merge or deploy. You offer the capability code.agent.
A change is a job: when someone asks for one, call code_agent with the instruction (and a repository and ref when it is not the default). It runs in the background, the pull request and the patch are posted to the conversation when it is done; say what you started, do not wait. Small questions about code you answer yourself by reading the checkout. Your recent jobs and their outcomes are in the state summary and the job_status tool.`;

export function codeAgentTool(defaults: { url?: string; ref?: string }): JobTool {
	return {
		name: "code_agent",
		description: "Make a code change in a repository: the job works on a branch, commits, pushes it and opens a pull request. Give the instruction in full; `repo`/`ref` choose another repository (https) or branch than the default.",
		parameters: Type.Object({
			instruction: Type.String({ minLength: 1, maxLength: 8000 }),
			repo: Type.Optional(Type.String({ maxLength: 400 })),
			ref: Type.Optional(Type.String({ maxLength: 200 })),
		}),
		plan(args: { instruction?: string; repo?: string; ref?: string }): JobPlan | { refuse: string } {
			const target = repositoryTarget({ ...(args.repo ? { repo: args.repo } : {}), ...(args.ref ? { ref: args.ref } : {}) }, defaults);
			if ("refuse" in target) return target;
			const instruction = String(args.instruction ?? "").trim();
			if (instruction === "") return { refuse: "there is no instruction" };
			return {
				capability: { id: "code.agent", version: "2" },
				input: { repository: { url: target.url, ref: target.ref }, instruction },
				label: `change: ${instruction.split("\n")[0]!.slice(0, 50)}`,
			};
		},
	};
}

/**
 * What the developer role adds to conversations: the code change as a job tool. The repository defaults to CHAT_REPOSITORY_URL and
 * CHAT_REPOSITORY_REF. The job runs like any other: same sandbox, same approvals, the branch and pull request are made by the service.
 */
export function developerChat(env: NodeJS.ProcessEnv = process.env): ThreadRoleHooks {
	const defaults = { url: env.CHAT_REPOSITORY_URL, ref: env.CHAT_REPOSITORY_REF };
	return {
		instructions: CHAT_INSTRUCTIONS,
		jobTools: [codeAgentTool(defaults)],
	};
}

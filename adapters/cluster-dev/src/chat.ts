import { Type } from "@earendil-works/pi-ai";
import { repositoryTarget, type JobPlan, type JobTool, type ThreadRoleHooks } from "@somework/agent-kit";
import { CLUSTER_TOOLS } from "./tools/index.ts";
import type { ClusterSettings } from "./settings.ts";

export const CAPABILITY = { id: "code.cluster", version: "1" } as const;

export const CHAT_INSTRUCTIONS = `You are the cluster development agent. A message to you is a developer's request: look into a problem, change something, test it, push it, deploy it, check it. Do it yourself with your tools and report afterwards; the owner is asked only before destructive actions, and the service decides which those are. Small changes you make yourself in a copy of the repository's checkout and push with git_push. A larger change that should be reviewed as a pull request is a job: call cluster_change with the instruction in full; it runs in the background and its pull request is posted to the conversation when it is done. Say what you started, do not wait.`;

/** The repository the agent changes, and nothing else. */
const sameRepository = (a: string, b: string): boolean => a.replace(/\.git$/, "").replace(/\/+$/, "").toLowerCase() === b.replace(/\.git$/, "").replace(/\/+$/, "").toLowerCase();

export function clusterChangeTool(settings: Pick<ClusterSettings, "repositoryUrl">): JobTool {
	return {
		name: "cluster_change",
		description: "Make a larger code change in the cluster's repository as a background job: it works on a branch, runs the tests, commits, pushes the branch and opens a pull request. Give the instruction in full; `ref` is the branch to start from (default: the repository's default branch).",
		parameters: Type.Object({
			instruction: Type.String({ minLength: 1, maxLength: 8000 }),
			ref: Type.Optional(Type.String({ maxLength: 200 })),
		}),
		plan(args: { instruction?: string; ref?: string }): JobPlan | { refuse: string } {
			if (!settings.repositoryUrl) return { refuse: "no repository is configured for this agent (CLUSTER_DEV_REPOSITORY)" };
			const target = repositoryTarget({ ...(args.ref ? { ref: args.ref } : {}) }, { url: settings.repositoryUrl });
			if ("refuse" in target) return target;
			const instruction = String(args.instruction ?? "").trim();
			if (instruction === "") return { refuse: "there is no instruction" };
			return {
				capability: { ...CAPABILITY },
				input: { repository: { url: target.url, ref: target.ref }, instruction },
				label: `change: ${instruction.split("\n")[0]!.slice(0, 50)}`,
			};
		},
	};
}

export interface ClusterChatOptions {
	settings: ClusterSettings;
}

function facts(settings: ClusterSettings): string {
	return [
		`Repository: ${settings.repositoryUrl ?? "not configured"}; ${
			settings.extraRepositories.length === 0
				? `the only remote you push to is the organisation's (${settings.gitRemote}), through git_push.`
				: `you push to the organisation's remote (${settings.gitRemote})${settings.extraRepositories.map((repository) => ` and to ${repository.name} (${repository.url})`).join("")}, through git_push (its repository argument names which one).`
		}`,
		`Hosts for host_exec: ${settings.hosts.map((host) => host.name).join(", ") || "none configured"}.`,
		`Agents deploy_status reads: ${Object.keys(settings.agentUrls).join(", ") || "none configured"}.`,
		`CI: ${settings.ci ? `Woodpecker, repository ${settings.ci.repository}` : "not configured"}.`,
		`Tools: ${CLUSTER_TOOLS.join(", ")}.`,
	].join("\n");
}

/**
 * What the role adds to conversations: its standing orders, the larger change as a job, the facts about the cluster it is set up for, and
 * the read-only checkout of the repository that a conversation copies and works in.
 */
export function clusterChat(options: ClusterChatOptions): ThreadRoleHooks {
	const { settings } = options;
	return {
		instructions: CHAT_INSTRUCTIONS,
		context: () => facts(settings),
		jobTools: [clusterChangeTool(settings)],
		...(settings.repositoryUrl ? { checkout: () => ({ repoUrl: settings.repositoryUrl! }) } : {}),
	};
}

export { sameRepository };

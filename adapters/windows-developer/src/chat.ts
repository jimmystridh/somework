import { Type } from "@earendil-works/pi-ai";
import { PR_WATCH_INSTRUCTIONS, repositoryTarget, type JobPlan, type JobTool, type ThreadRoleHooks } from "@somework/agent-kit";

export const CHAT_INSTRUCTIONS = `You are the Windows developer agent of this platform. You make code changes that must build and run on Windows, inside a confined environment, with named build and test profiles only; a change is made on a branch named agent/<job>, pushed, and offered as a pull request; you never merge or deploy. You offer the capability code.windows.
A change is a job: when someone asks for one, call windows_develop with the instruction, and the names of a build profile and test profiles of this machine when they are asked for (never a command). It runs in the background, one at a time on this machine, and its pull request and patch are posted to the conversation when it is done; say what you started, do not wait. Your recent jobs and their outcomes are in the state summary and the job_status tool. If you have the watch_pull_request tool, use it on a pull request that was just posted to you, to follow up on its CI or build result and its review comments without polling it. ${PR_WATCH_INSTRUCTIONS}`;

/** Builds are heavy and share persistent workspaces: one change at a time on this machine. */
export const WINDOWS_RESOURCES = ["windows-build"] as const;

const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,60}$/;

export function windowsDevelopTool(defaults: { url?: string; ref?: string }): JobTool {
	return {
		name: "windows_develop",
		description: "Make a code change that must build and run on Windows: the job works on a branch, runs the named build and test profiles, pushes and opens a pull request. Give the instruction in full; `build` and `tests` are names of profiles of this machine, never commands; `repo`/`ref` choose another repository (https) or branch than the default.",
		parameters: Type.Object({
			instruction: Type.String({ minLength: 1, maxLength: 8000 }),
			build: Type.Optional(Type.String({ maxLength: 60 })),
			tests: Type.Optional(Type.Array(Type.String({ maxLength: 60 }), { maxItems: 10 })),
			repo: Type.Optional(Type.String({ maxLength: 400 })),
			ref: Type.Optional(Type.String({ maxLength: 200 })),
		}),
		plan(args: { instruction?: string; build?: string; tests?: string[]; repo?: string; ref?: string }): JobPlan | { refuse: string } {
			const target = repositoryTarget({ ...(args.repo ? { repo: args.repo } : {}), ...(args.ref ? { ref: args.ref } : {}) }, defaults);
			if ("refuse" in target) return target;
			const instruction = String(args.instruction ?? "").trim();
			if (instruction === "") return { refuse: "there is no instruction" };
			const tests = args.tests ?? [];
			if (args.build !== undefined && !PROFILE_NAME.test(args.build)) return { refuse: "build must be the name of a build profile of this machine" };
			if (tests.some((name) => !PROFILE_NAME.test(name))) return { refuse: "tests must be names of test profiles of this machine" };
			return {
				capability: { id: "code.windows", version: "1" },
				input: { repository: { url: target.url, ref: target.ref }, instruction, ...(args.build ? { build: { name: args.build } } : {}), ...(tests.length > 0 ? { tests } : {}) },
				label: `change: ${instruction.split("\n")[0]!.slice(0, 50)}`,
			};
		},
	};
}

/**
 * What the Windows developer adds to conversations: the code change as a job tool. The job runs in the same confined environment, with the same
 * checks, as any other; the machine builds one change at a time.
 */
export function windowsDeveloperChat(env: NodeJS.ProcessEnv = process.env): ThreadRoleHooks {
	const defaults = { url: env.CHAT_REPOSITORY_URL, ref: env.CHAT_REPOSITORY_REF };
	return {
		instructions: CHAT_INSTRUCTIONS,
		jobResources: (capabilityId) => (capabilityId === "code.windows" ? [...WINDOWS_RESOURCES] : undefined),
		jobTools: [windowsDevelopTool(defaults)],
	};
}

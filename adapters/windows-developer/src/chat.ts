import { repositoryTarget, takeOptions, type ChatRoleHooks } from "@somework/agent-kit";

export const CHAT_INSTRUCTIONS = `You are the Windows developer agent of this platform. You make code changes that must build and run on Windows, inside a confined environment, with named build and test profiles only; you push branches named agent/<task> and open pull requests, never merge or deploy. You offer the capability code.windows. Your recent tasks and their outcomes are in the state summary and the agent_status tool.`;

/**
 * What the Windows developer adds to chat. An instruction from the manager becomes a code.windows task: optional leading lines `repo: https://...`,
 * `ref: <branch>`, `build: <profile>` and `tests: <profile>[, <profile>]` (named profiles of this machine only), the rest is the instruction. It runs
 * in the same confined environment, with the same checks, as a task.
 */
export function windowsDeveloperChat(env: NodeJS.ProcessEnv = process.env): ChatRoleHooks {
	const defaults = { url: env.CHAT_REPOSITORY_URL, ref: env.CHAT_REPOSITORY_REF };
	const profileName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,60}$/;
	return {
		instructions: CHAT_INSTRUCTIONS,
		instructInput(text) {
			const { options, rest } = takeOptions(text, ["repo", "ref", "build", "tests"]);
			const target = repositoryTarget(options, defaults);
			if ("refuse" in target) return target;
			if (rest === "") return { refuse: "there is no instruction after the option lines" };
			const tests = options.tests ? options.tests.split(/[\s,]+/).filter(Boolean) : [];
			if (options.build !== undefined && !profileName.test(options.build)) return { refuse: "build: must be the name of a build profile of this machine" };
			if (tests.some((name) => !profileName.test(name))) return { refuse: "tests: must be names of test profiles of this machine" };
			return {
				capability: { id: "code.windows", version: "1" },
				input: { repository: { url: target.url, ref: target.ref }, instruction: rest, ...(options.build ? { build: { name: options.build } } : {}), ...(tests.length > 0 ? { tests } : {}) },
			};
		},
	};
}

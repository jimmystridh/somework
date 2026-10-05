import { createHandler, noPullRequests, type HandlerDeps } from "@somework/agent-kit";
import type { Handler } from "@somework/sdk";
import { createReviewerHooks, type ReviewerOptions } from "./hooks.ts";
import { profile } from "./profile.ts";

export interface ReviewerDeps extends Omit<HandlerDeps, "profile" | "hooks" | "host"> {
	github?: ReviewerOptions["github"];
}

/** The reviewer's job handler without the service around it: the kit's repository handler with the reviewer's profile and hooks. */
export function createReviewerHandler(deps: ReviewerDeps): Handler {
	const { github, ...rest } = deps;
	const hooks = createReviewerHooks({ client: deps.client, log: deps.log, github });
	return createHandler({ ...rest, host: noPullRequests, runtime: hooks.wrapRuntime!(deps.runtime), profile, hooks });
}

import { InvalidInput, silent, type Log, type ResultContext, type ResultPatch, type RoleHooks, type ServiceContext } from "@somework/agent-kit";
import type { SomeWorkClient } from "@somework/sdk";
import { reviewerChat } from "./chat.ts";
import { fetchPullRequestContext } from "./context.ts";
import { buildInstruction, CONTEXT_KEY } from "./prompt.ts";
import { ReviewRuntime } from "./review-runtime.ts";
import { renderReport } from "./result.ts";
import { loadReviewEventSettings, seedHandler } from "./seed.ts";

export interface ReviewerOptions {
	client: Pick<SomeWorkClient, "uploadArtifact">;
	log?: Log;
	/** Optional read-only access to the code host for the pull request context. Without it the review is of the ref alone. */
	github?: { token: string; /** A live token for each call (a GitHub App's tokens expire); `token` is then the first one. */ tokenSource?: () => Promise<string>; apiBase?: string; tokenHosts?: string[]; fetch?: typeof fetch };
}

const MAX_RAW_ARTIFACT = 256 * 1024;
const scrub = (text: string, token?: string): string => (token ? text.replaceAll(token, "***") : text);

/**
 * The reviewer's code on top of the kit's repository handler:
 *  - `prepareInput` adds the pull request context to the input (a failure to fetch it only costs the context);
 *  - `instruction` builds the review brief;
 *  - `wrapRuntime` adds the auto-denial of mutations and the repair turn, and keeps the parsed review for `result`;
 *  - `result` turns the model's answer into the card's result plus the Markdown report, or into an `invalid_review_output` failure that
 *    keeps the raw answer as an artifact.
 */
export function createReviewerHooks(options: ReviewerOptions): RoleHooks {
	const log = options.log ?? silent;
	const github = options.github;
	let guarded: ReviewRuntime | undefined;

	return {
		async prepareInput(input, { taskId }) {
			if (!github || !Number.isInteger(input.pullRequest) || input.pullRequest < 1 || typeof input.repository?.url !== "string") return input;
			try {
				const token = github.tokenSource ? await github.tokenSource() : github.token;
				const context = await fetchPullRequestContext({ repoUrl: input.repository.url, pullRequest: input.pullRequest, ...github, token });
				return context ? { ...input, [CONTEXT_KEY]: context } : input;
			} catch (error) {
				log("warn", "pr_context_failed", { taskId, error: scrub(error instanceof Error ? error.message : String(error), github.token) });
				return input;
			}
		},

		instruction(input) {
			try {
				return buildInstruction(input);
			} catch (error) {
				throw error instanceof InvalidInput ? error : new InvalidInput(error instanceof Error ? error.message : String(error));
			}
		},

		wrapRuntime(inner) {
			guarded = new ReviewRuntime(inner, log);
			return guarded;
		},

		async result(base, context): Promise<ResultPatch> {
			const reviewed = guarded?.take(`somework:${context.taskId}`);
			if (!reviewed) return { failure: { code: "job_error", message: "the run finished without a review to report", retryable: true } };
			if (!reviewed.ok) return invalidOutput(context, reviewed.reason, reviewed.raw, github?.token, options.client, log);
			const input = context.input;
			const report = renderReport(reviewed.review, { repository: input.repository.url, ref: input.repository.ref, pullRequest: input.pullRequest, ticket: input.ticket, taskId: context.taskId, truncated: reviewed.truncated });
			const artifact = await options.client.uploadArtifact({ filename: `${context.taskId}-review.md`, mediaType: "text/markdown", bytes: report, sourceTaskId: context.taskId });
			const usage = (base as { usage?: unknown }).usage;
			return { result: { ...reviewed.review, baseSha: context.baseSha, ...(reviewed.truncated ? { truncated: true } : {}), ...(usage ? { usage } : {}) }, artifacts: [artifact] };
		},

		onSettled(taskId) {
			// a run that never produced a result (failed, stopped) must not leave its parsed review behind
			guarded?.take(`somework:${taskId}`);
		},
	};
}

/** A failed outcome cannot carry artifacts, so the raw answer is uploaded and referenced from the failure's details. */
async function invalidOutput(context: ResultContext, reason: string, raw: string, token: string | undefined, client: ReviewerOptions["client"], log: Log): Promise<ResultPatch> {
	const artifact = (await client.uploadArtifact({ filename: `${context.taskId}-raw-answer.txt`, mediaType: "text/plain", bytes: scrub(raw, token).slice(0, MAX_RAW_ARTIFACT), sourceTaskId: context.taskId })) as { artifactId?: string; uri?: string };
	log("warn", "invalid_review_output", { taskId: context.taskId, reason });
	return { failure: { code: "invalid_review_output", message: `the review could not be turned into a result: ${reason}`, retryable: false, details: { rawAnswer: { artifactId: artifact.artifactId, uri: artifact.uri } } } };
}

/** For `runAgentService`: the hooks of the service being composed (its client, log and optional read-only token). */
export function reviewerHooksFor(context: ServiceContext): RoleHooks {
	seedHandler({ stateDir: context.config.state.dir, settings: loadReviewEventSettings(context.env), log: context.log, reseed: context.env.REVIEWER_RESEED_HANDLER === "1" });
	return reviewerHooks(context);
}

const reviewerHooks = (context: ServiceContext): RoleHooks => ({
	chat: reviewerChat(context.env),
	...createReviewerHooks({
		client: context.client,
		log: context.log,
		// one read-only token serves the clone and the pull request context; the kit never sends it to a host outside GIT_TOKEN_HOSTS
		github: context.gitToken ? { token: context.gitToken, tokenSource: context.gitTokenSource, apiBase: context.config.git.githubApi, tokenHosts: context.config.git.tokenHosts } : undefined,
	}),
});

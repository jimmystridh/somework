import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { InvalidInput, silent, type AgentRuntime, type TimersClient, type Log, type ResultContext, type ResultPatch, type RoleHooks, type ServiceContext } from "@somework/agent-kit";
import type { Outcome } from "@somework/sdk";
import { AikidoClient, AikidoError, readCredentials } from "./aikido/client.ts";
import { eligibility, summariseIssue, type IssueSummary } from "./aikido/issue.ts";
import { createAikidoTools } from "./aikido/tool.ts";
import { AttemptLedger } from "./attempts.ts";
import { fixerChat } from "./chat.ts";
import { discardChange, reviewChange, runCheck, type CheckResult } from "./checks.ts";
import { matchesAny } from "./paths.ts";
import { run } from "./sandbox.ts";
import { GitHubPullRequestReader, parseFollowUp, pullRequestRepository, type FollowUpInput, type PullRequestReader, type PullRequestState } from "./followup.ts";
import { aikidoUrl, buildFollowUpInstruction, buildInstruction, defang, parseAnswer, pullRequestText, type FixInput, type ParsedAnswer } from "./prompt.ts";
import { seedHandler } from "./seed.ts";
import { loadSettings, normaliseRepositoryUrl, repositoryFullName, type FixerSettings } from "./settings.ts";

export const SKIPPED = "skipped: ";

interface TaskState {
	input: FixInput;
	summary: IssueSummary;
	skip?: string;
	baseSha?: string;
	workspace?: string;
	env?: ExecutionEnv;
	parsed?: ParsedAnswer;
	/** An earlier attempt of this task pushed the work and only the pull request was missing: the guards ran then. */
	resumed?: boolean;
	files: string[];
	tests?: CheckResult;
	/** A follow-up on this agent's own pull request, as the reader found it when the task was prepared. */
	followUp?: { input: FollowUpInput; pullRequest: PullRequestState };
	/** The next look at the pull request, decided when the result is known and asked of the hub once the task has settled. */
	nextCheck?: { round: number; minutes: number; pullRequest: string; branch: string };
}

export interface FixerOptions {
	settings: FixerSettings;
	aikido: Pick<AikidoClient, "resolveIssue">;
	/** Reads the agent's pull requests for follow-ups. Without it a follow-up task is refused. */
	reader?: PullRequestReader;
	/** Asks the event hub for the next look at a pull request. Without it no follow-up is scheduled. */
	timers?: Pick<TimersClient, "request">;
	stateDir: string;
	log?: Log;
	now?: () => Date;
	/** For tests: the boundary markers around Aikido text. */
	boundary?: () => string;
}

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 3)}...` : text);

/** Approval requests are refused: a fix is started by an event, and nobody answers for this agent. The model is told and picks another step. */
class AutoDenyRuntime implements AgentRuntime {
	readonly #inner: AgentRuntime;
	readonly #log: Log;
	constructor(inner: AgentRuntime, log: Log) {
		this.#inner = inner;
		this.#log = log;
	}
	start = () => this.#inner.start();
	health = () => this.#inner.health();
	close = () => this.#inner.close();
	execute: AgentRuntime["execute"] = (request, hooks) =>
		this.#inner.execute(request, {
			...hooks,
			requestApproval: async (approval) => {
				this.#log("info", "fixer_approval_refused", { requestId: request.requestId, tool: approval.tool });
				return { approved: false, reason: "no person answers approval requests for this agent; choose a step that needs none, or finish with NO_FIX" };
			},
		});
}

function parseInput(input: any): FixInput {
	const id = input?.issue?.id;
	const key = typeof id === "number" ? String(id) : typeof id === "string" ? id.trim() : "";
	if (!/^[0-9]{1,12}$/.test(key)) throw new InvalidInput("issue.id must be the whole-number id of an Aikido issue");
	if (typeof input?.repository?.url !== "string" || input.repository.url === "") throw new InvalidInput("repository.url is required");
	return {
		issue: { id: key, ...(typeof input.issue.url === "string" ? { url: input.issue.url } : {}), ...(typeof input.issue.repository === "string" ? { repository: input.issue.repository } : {}) },
		repository: { url: input.repository.url, ...(typeof input.repository.ref === "string" && input.repository.ref !== "" ? { ref: input.repository.ref } : {}) },
		...(typeof input.hint === "string" && input.hint.trim() !== "" ? { hint: input.hint.slice(0, 2000) } : {}),
	};
}

/**
 * The role's code on top of the kit's repository handler:
 *  - `prepareInput` checks the repository, reads the issue from Aikido, decides whether the issue is this agent's to fix and counts the
 *    attempt on the service host;
 *  - `beforeWorkspace` ends an ineligible task as `skipped` before anything is cloned or a token is spent (`beforeRun` keeps the same check);
 *  - `resume` lets a retry of a task whose branch was already pushed open the missing pull request without running the model again;
 *  - `beforeFinalize` turns "no safe fix" into an untouched tree and holds back a change that touches protected paths, is too large,
 *    contains secret-like text or fails the repository's check profile; it judges everything since the base commit, so a commit an earlier
 *    attempt left in a persisted workspace is held to the same guards as the model's fresh changes;
 *  - `pullRequest` and `branchName` give the pull request its title, body, commit message and `agent/aikido-<issue>-<sha>`;
 *  - `result` reports `pr_opened`, `no_fix`, `skipped` or `blocked`;
 *  - a `code.fix.followup` task looks at the agent's own open pull request for reviews, comments and failing checks that came after its newest
 *    commit and, when there are some, works on the pull request's branch; after a pull request is opened and after each look, the next look is
 *    asked of the event hub (`settings.followUpMinutes`).
 */
export function createFixerHooks(options: FixerOptions): RoleHooks {
	const { settings } = options;
	const log = options.log ?? silent;
	const now = options.now ?? (() => new Date());
	const boundary = options.boundary ?? (() => randomBytes(8).toString("hex"));
	const attempts = new AttemptLedger(join(options.stateDir, "aikido-attempts.json"), { maxAttemptsPerIssue: settings.maxAttemptsPerIssue, cooldownMinutes: settings.cooldownMinutes, dailyCap: settings.dailyCap }, now);
	if (settings.ledgerImport) {
		const imported = attempts.importHistory(settings.ledgerImport);
		log("info", "fixer_ledger_imported", { file: settings.ledgerImport, ...imported });
	}
	const allowedRepositories = new Set(settings.repositories.map(normaliseRepositoryUrl));
	const tasks = new Map<string, TaskState>();
	let current: string | undefined;
	const tools = createAikidoTools({ aikido: options.aikido, current: () => current, log });

	const stateOf = (taskId: string): TaskState => {
		const state = tasks.get(taskId);
		if (!state) throw new InvalidInput("the task has no prepared Aikido issue");
		return state;
	};

	return {
		extensions: [tools.extension],

		async prepareInput(input, { taskId }) {
			const parsed = parseInput(input);
			if (!allowedRepositories.has(normaliseRepositoryUrl(parsed.repository.url))) throw new InvalidInput("this agent only fixes the repository it is configured for");
			const followUp = input?.followUp === undefined ? undefined : parseFollowUp(input.followUp);
			if (followUp && pullRequestRepository(followUp.pullRequest) !== repositoryFullName(parsed.repository.url)) throw new InvalidInput("the pull request belongs to another repository");
			if (followUp && !options.reader) throw new InvalidInput("this agent is not set up to follow up on pull requests");
			let found;
			try {
				found = await options.aikido.resolveIssue(parsed.issue.id);
			} catch (error) {
				if (error instanceof AikidoError && error.permanent) throw new InvalidInput(error.message);
				throw error;
			}
			const summary = summariseIssue(found);
			if (followUp) {
				const pullRequest = await options.reader!.read(followUp.pullRequest);
				const skip = pullRequest.state !== "open" ? `the pull request is ${pullRequest.state}` : pullRequest.feedback.length === 0 && !parsed.hint ? "the pull request has no new review feedback since its newest commit" : undefined;
				tasks.set(taskId, { input: parsed, summary, followUp: { input: followUp, pullRequest }, ...(skip ? { skip } : {}), files: [] });
				log("info", "fixer_followup_prepared", { taskId, issue: summary.groupId, round: followUp.round, state: pullRequest.state, feedback: pullRequest.feedback.length, ciVisible: pullRequest.ci.visible, ciPending: pullRequest.ci.pending, skipped: skip !== undefined });
				return { ...input, agentKey: `aikido-followup:${summary.groupId}`, repository: { ...input.repository, ref: followUp.branch } };
			}
			const verdict = eligibility(summary, settings, parsed.issue.repository);
			let skip = verdict.eligible ? undefined : verdict.reason;
			if (!skip) {
				const begun = attempts.begin(summary.groupId, taskId);
				if (!begun.ok) skip = begun.reason;
			}
			tasks.set(taskId, { input: parsed, summary, ...(skip ? { skip } : {}), files: [] });
			log("info", "fixer_prepared", { taskId, issue: summary.groupId, type: summary.type, severity: summary.severity, skipped: skip !== undefined });
			return { ...input, agentKey: `aikido:${summary.groupId}`, repository: { ...input.repository, ref: parsed.repository.ref ?? "HEAD" } };
		},

		instruction(_input, { taskId }) {
			const state = stateOf(taskId);
			if (state.followUp) return buildFollowUpInstruction(state.followUp.input.pullRequest, state.summary, state.followUp.pullRequest.feedback, boundary(), state.input.hint);
			return buildInstruction(state.input, state.summary, boundary());
		},

		branchName({ taskId, baseSha }) {
			const state = stateOf(taskId);
			if (state.followUp) return state.followUp.input.branch;
			return attempts.branchFor(taskId, () => `agent/aikido-${state.summary.groupId}-${baseSha.slice(0, 8)}`);
		},

		beforeWorkspace(_input, { taskId }) {
			const state = stateOf(taskId);
			if (state.skip) return { blocked: { reason: `${SKIPPED}${state.skip}`, details: { issue: state.summary.groupId } } };
		},

		async beforeRun(context) {
			const state = stateOf(context.taskId);
			state.baseSha = context.baseSha;
			state.workspace = context.workspace;
			state.env = context.envFor(context.workspace);
			if (state.skip) return { blocked: { reason: `${SKIPPED}${state.skip}`, details: { issue: state.summary.groupId } } };
			current = state.summary.groupId;
		},

		async resume(context) {
			const state = stateOf(context.taskId);
			const env = context.envFor(context.workspace);
			const subject = (await run(env, `git log -1 --format=%s ${context.sha}`, context.workspace, 60)).output.trim();
			const changed = await run(env, `git -c core.quotepath=false diff --name-only --no-renames ${context.baseSha}..${context.sha}`, context.workspace, 60, 8_000_000);
			state.files = changed.output.split("\n").map((name) => name.trim()).filter(Boolean);
			state.resumed = true;
			log("info", "fixer_resumed", { taskId: context.taskId, issue: state.summary.groupId, branch: context.branch, files: state.files.length });
			const headline = subject.replace(/^fix\(security\):\s*/, "").replace(/\s*\(Aikido #\d+\)\s*$/, "") || "fix pushed by an earlier attempt";
			return { answer: `FIXED: ${headline}\n\nThis branch was pushed by an earlier attempt of the same task and only the pull request was missing, so it was opened now without running the model again. The protected-path, size and secret checks ran before that push.` };
		},

		async afterRun(context) {
			if (tasks.get(context.taskId)?.summary.groupId === current) current = undefined;
		},

		async beforeFinalize(context) {
			const state = stateOf(context.taskId);
			const env = context.envFor(context.workspace);
			state.parsed = parseAnswer(context.answer);
			if (state.resumed) return;
			if (state.parsed.kind === "no_fix") {
				await discardChange(env, context.workspace, context.baseSha);
				log("info", "fixer_no_fix", { taskId: context.taskId, issue: state.summary.groupId });
				return;
			}
			const review = await reviewChange(env, context.workspace, context.baseSha);
			state.files = review.files;
			if (review.files.length === 0) return;
			const protectedPath = review.files.map((file) => ({ file, pattern: matchesAny(file, settings.protectedPaths) })).find((hit) => hit.pattern !== undefined);
			if (protectedPath) return { blocked: { reason: `the change touches a protected path (${protectedPath.file}, rule ${protectedPath.pattern}); nothing was pushed`, details: { files: review.files.slice(0, 50) } } };
			if (review.files.length > settings.maxFiles) return { blocked: { reason: `the change touches ${review.files.length} files, more than the limit of ${settings.maxFiles}; nothing was pushed`, details: { files: review.files.slice(0, 50) } } };
			if (review.secretLike) return { blocked: { reason: `the change adds ${review.secretLike}; nothing was pushed`, details: { files: review.files.slice(0, 50) } } };
			state.tests = await runCheck(env, context.workspace, settings.checkProfile);
			if (state.tests && !state.tests.ok) return { blocked: { reason: `the repository's check profile ${state.tests.profile} failed; nothing was pushed`, details: { tests: state.tests, files: review.files.slice(0, 50) } } };
		},

		pullRequest(_input, { taskId }) {
			const state = stateOf(taskId);
			if (state.followUp) {
				const title = `fix(security): address review feedback (Aikido #${state.summary.groupId})`;
				const body = `Follow-up to ${state.followUp.input.pullRequest}.\n\n${defang(state.parsed?.text || state.parsed?.headline || "(the agent gave no description)").slice(0, 6000)}\n\n---\nGenerated by an agent (SomeWork aikido-fixer, task ${taskId}). **Nobody has reviewed it: review before merge.**`;
				return { title, body, commitMessage: [title, "", `Follow-up to ${state.followUp.input.pullRequest}.`, "", "Generated by an agent (SomeWork aikido-fixer), not reviewed by a person."].join("\n") };
			}
			return pullRequestText({
				summary: state.summary,
				issueUrl: aikidoUrl(state.input.issue.url),
				answer: state.parsed ?? { kind: "unmarked", headline: "", text: "" },
				files: state.files,
				...(state.tests ? { tests: state.tests } : {}),
				baseSha: state.baseSha ?? "",
				taskId,
			});
		},

		wrapRuntime: (inner) => new AutoDenyRuntime(inner, log),

		result(base, context): ResultPatch {
			const state = tasks.get(context.taskId);
			if (!state) return { failure: { code: "job_error", message: "the run finished without its Aikido issue", retryable: true } };
			const result = outcomeOf(base, context, state);
			state.nextCheck = nextCheck(settings, state, result);
			if (state.followUp) return { result };
			attempts.recordOutcome(context.taskId, {
				groupId: state.summary.groupId,
				outcome: String(result.outcome),
				...(typeof result.branch === "string" ? { branch: result.branch } : {}),
				...(typeof result.prUrl === "string" ? { prUrl: result.prUrl } : {}),
				...(tokensOf(result.usage) !== undefined ? { tokens: tokensOf(result.usage)! } : {}),
			});
			return { result };
		},

		onSettled(taskId, outcome: Outcome) {
			const state = tasks.get(taskId);
			tasks.delete(taskId);
			if (state?.nextCheck && outcome.type === "completed") scheduleCheck(options.timers, state.nextCheck, state.summary.groupId, log);
			if (!state?.env || !state.workspace || outcome.type !== "completed") return;
			// the result is reported and the branch is pushed (or nothing was to be): the checkout has done its job
			void state.env.remove(state.workspace, { recursive: true, force: true }, BACKGROUND_CONTEXT).catch(() => undefined);
		},
	};
}

const tokensOf = (usage: unknown): number | undefined => {
	const total = (usage as { totalTokens?: unknown; tokens?: unknown } | undefined);
	const value = total?.totalTokens ?? total?.tokens;
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
};

const PULL_REQUEST_NUMBER = /\/pull\/([0-9]+)$/;

/** When the pull request should be looked at next, given how this task ended: after a pull request was opened, and after each look while it is open and rounds are left. */
export function nextCheck(settings: Pick<FixerSettings, "followUpMinutes" | "ciWatchMinutes">, state: TaskState, result: Record<string, unknown>): TaskState["nextCheck"] {
	const minutes = settings.followUpMinutes;
	if (state.followUp) {
		const { round } = state.followUp.input;
		const open = state.followUp.pullRequest.state === "open";
		const settled = result.outcome === "followup_pushed" || result.outcome === "no_followup_needed" || (result.outcome === "skipped" && open);
		if (!open || !settled || round >= minutes.length) return undefined;
		// a pushed commit starts the repository's CI: look again soon, then back to the table
		const soon = result.outcome === "followup_pushed" ? Math.min(minutes[round]!, settings.ciWatchMinutes) : minutes[round]!;
		return { round: round + 1, minutes: soon, pullRequest: state.followUp.input.pullRequest, branch: state.followUp.input.branch };
	}
	if (result.outcome !== "pr_opened" || typeof result.prUrl !== "string" || typeof result.branch !== "string" || minutes.length === 0) return undefined;
	return PULL_REQUEST_NUMBER.test(result.prUrl) ? { round: 1, minutes: minutes[0]!, pullRequest: result.prUrl, branch: result.branch } : undefined;
}

function scheduleCheck(timers: FixerOptions["timers"], check: NonNullable<TaskState["nextCheck"]>, issue: string, log: Log): void {
	if (!timers) {
		log("info", "fixer_followup_not_scheduled", { reason: "the event hub timers are not configured" });
		return;
	}
	const number = PULL_REQUEST_NUMBER.exec(check.pullRequest)?.[1];
	void timers
		.request({
			delaySeconds: check.minutes * 60,
			key: `pr-followup:${number}`,
			note: `Look at pull request #${number} again for review feedback and failing checks (check ${check.round}).`,
			payload: { kind: "pr-followup", pullRequest: check.pullRequest, branch: check.branch, issue: Number(issue), round: check.round },
		})
		.then((timer) => log("info", "fixer_followup_scheduled", { pullRequest: check.pullRequest, round: check.round, dueAt: timer.dueAt }))
		.catch((error: unknown) => log("warn", "fixer_followup_not_scheduled", { pullRequest: check.pullRequest, round: check.round, error: error instanceof Error ? error.message.slice(0, 160) : "error" }));
}

/** The card's result for a settled task. */
export function outcomeOf(base: Record<string, unknown>, context: ResultContext, state: TaskState): Record<string, unknown> {
	const usage = (base as { usage?: unknown }).usage;
	if (state.followUp) return followUpOutcome(base, context, state, usage);
	const common = { aikidoIssueId: Number(state.summary.groupId), files: state.files.slice(0, 100), ...(state.baseSha ? { baseSha: state.baseSha } : {}), ...(state.tests ? { tests: state.tests } : {}), ...(usage ? { usage } : {}) };
	if (context.blocked) {
		const skipped = context.blocked.reason.startsWith(SKIPPED);
		return { outcome: skipped ? "skipped" : "blocked", summary: clip(skipped ? context.blocked.reason.slice(SKIPPED.length) : context.blocked.reason, 4000), ...common };
	}
	const done = context.finalize;
	if (!done || done.status === "no_changes") {
		const why = state.parsed?.kind === "no_fix" ? [state.parsed.headline, state.parsed.text].filter(Boolean).join("\n\n") : "the agent changed nothing";
		return { outcome: "no_fix", summary: clip(why || "the agent found no safe fix and changed nothing", 4000), ...common };
	}
	const sha = done.commits.at(-1);
	if (!done.prUrl) return { outcome: "blocked", summary: `the branch ${done.branch} was pushed but no pull request could be opened: ${clip(state.parsed?.headline ?? "", 300)}`, branch: done.branch, ...(sha ? { sha } : {}), ...common };
	return { outcome: "pr_opened", summary: clip([state.parsed?.headline, state.parsed?.text].filter(Boolean).join("\n\n") || "a pull request was opened", 4000), prUrl: done.prUrl, branch: done.branch, ...(sha ? { sha } : {}), ...common };
}

function followUpOutcome(_base: Record<string, unknown>, context: ResultContext, state: TaskState, usage: unknown): Record<string, unknown> {
	const common = { aikidoIssueId: Number(state.summary.groupId), prUrl: state.followUp!.input.pullRequest, branch: state.followUp!.input.branch, files: state.files.slice(0, 100), round: state.followUp!.input.round, ...(state.baseSha ? { baseSha: state.baseSha } : {}), ...(state.tests ? { tests: state.tests } : {}), ...(usage ? { usage } : {}) };
	if (context.blocked) {
		const skipped = context.blocked.reason.startsWith(SKIPPED);
		return { outcome: skipped ? "skipped" : "blocked", summary: clip(skipped ? context.blocked.reason.slice(SKIPPED.length) : context.blocked.reason, 4000), ...common };
	}
	const done = context.finalize;
	if (!done || done.status === "no_changes") {
		const why = state.parsed?.kind === "no_fix" ? [state.parsed.headline, state.parsed.text].filter(Boolean).join("\n\n") : "the agent changed nothing";
		return { outcome: "no_followup_needed", summary: clip(why || "the agent found nothing to change", 4000), ...common };
	}
	const sha = done.commits.at(-1);
	return { outcome: "followup_pushed", summary: clip([state.parsed?.headline, state.parsed?.text].filter(Boolean).join("\n\n") || "a follow-up commit was pushed", 4000), ...(sha ? { sha } : {}), ...common, branch: done.branch };
}

/** For `runAgentService`: the hooks of the service being composed. Fails at startup when the deployment cannot work. */
export async function aikidoFixerHooksFor(context: ServiceContext): Promise<RoleHooks> {
	const settings = loadSettings(context.env);
	if (!context.gitToken) throw new Error("the Aikido fixer needs GIT_TOKEN_FILE or a GitHub App (GITHUB_APP_ID): a credential that can push agent/* branches and open pull requests on its repository");
	if (context.config.concurrency !== 1) throw new Error("the Aikido fixer runs one fix at a time: PI_CONCURRENCY must be 1");
	readCredentials(settings.credentialsFile);
	const aikido = new AikidoClient({ region: settings.region, credentials: () => readCredentials(settings.credentialsFile), apiBase: settings.apiBase, oauthUrl: settings.oauthUrl });
	seedHandler({ stateDir: context.config.state.dir, settings, log: context.log, reseed: context.env.AIKIDO_RESEED_HANDLER === "1" });
	const reader = new GitHubPullRequestReader({ apiBase: context.config.git.githubApi, token: async () => (context.gitTokenSource ? await context.gitTokenSource() : context.gitToken!) });
	const hooks = createFixerHooks({ settings, aikido, reader, ...(context.timers ? { timers: context.timers } : {}), stateDir: context.config.state.dir, log: context.log });
	const chat = fixerChat({ settings, aikido, stateDir: context.config.state.dir, mirrorDir: context.config.git.mirror?.dir, log: context.log });
	return { ...hooks, chat, readinessChecks: { aikido_credentials: async () => !!readCredentials(settings.credentialsFile) } };
}

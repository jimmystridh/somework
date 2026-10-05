import type { Extension } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { Failure, Outcome, ProgressUpdate, SomeWorkClient } from "@somework/sdk";
import type { ChatConfig } from "./chat.ts";
import { validateEventsProfile } from "./events/config.ts";
import type { EventsProfile } from "./events/types.ts";
import type { FinalizeResult } from "./git.ts";
import type { Log } from "./log.ts";
import type { AgentRuntime, Budget, Usage } from "./runtime.ts";

/**
 * Everything that makes one agent role different from another. A role is `card.json` (the contract other agents see), a profile
 * (this), and a `main.ts` that hands the profile to `createAgentService`. Roles never import each other: what two roles share
 * belongs in this package.
 */
export interface AgentProfile {
	/** Short role name for logs ("developer", "reviewer", ...). The SomeWork agent id comes from the key the service runs with. */
	id: string;
	/** Capabilities this role serves; must be listed in its `card.json`. A task for any other capability is refused. */
	capabilities: { id: string; version: string }[];
	/** Appended to the model's instructions for every conversation (the role's standing orders). */
	systemPrompt?: string;
	/** The tools the model is offered, by name. Unset offers every coding tool (read, write, edit, bash, ...). */
	allowedTools?: string[];
	/** Commands that wait for a human, as `[pattern, reason]`. Start from `DEFAULT_APPROVAL_PATTERNS` and add to it. */
	approvalPatterns: [RegExp, string][];
	/**
	 * Tools other than `bash` that wait for a human, by tool name: given the call's arguments, a summary of what is about to happen, or
	 * `undefined` when this call needs no approval. A role's own tools (a ticket system, a deployment) use this for their side effects.
	 */
	toolApprovals?: Record<string, (args: Record<string, unknown>) => string | undefined>;
	/** Used when a job brings no budget and `requireBudget` is false. */
	defaultBudget: Budget;
	/** Default true: a job without a budget is rejected (the card should then also require one). */
	requireBudget?: boolean;
	git: {
		/** Commit and push the task branch after the run. False for read-only roles: nothing leaves the workspace. */
		push: boolean;
		/** Open (or find) a pull request after pushing. Only meaningful with `push`. */
		pullRequest: boolean;
		/** Task branches are `<branchPrefix>/<taskId>`. */
		branchPrefix: string;
	};
	skills: {
		/** Names of the repository skills this role may use; empty turns the feature off. Only these are ever shown to the model. */
		allow: string[];
		/** Directory (on the service host) with `<skill>.md` overlays that state only the differences from the repository's skill. */
		overlayDir?: string;
	};
	/**
	 * What happens to a direct chat message sent to the agent. By default each sender gets one automatic notice ("I take tasks, not chat",
	 * with the capability list); no model reads the message. `CHAT_AUTOREPLY=0` in the environment turns it off for a deployment.
	 */
	chat?: ChatConfig;
	/**
	 * Events (see docs/EVENTS.md): when `enabled`, the agent receives the events its subscriptions wake it for, runs its own handlers on them
	 * and has the handler tools. Off by default: a role that does not opt in behaves exactly as before.
	 */
	events?: EventsProfile;
}

/** A role's decision that the work must not leave the workspace (a failed check, damaged files): no commit, no push, no pull request. */
export interface Blocked {
	reason: string;
	details?: unknown;
}

/** What a hook may know about the job it is called for. */
export interface JobContext {
	taskId: string;
	input: any;
	/** The instruction the model was given. */
	instruction: string;
	workspace: string;
	/** The commit the work started from, as a full SHA (resolved from `repository.ref`: branch, tag, commit or pull ref). */
	baseSha: string;
	/** The branch a pull request targets. */
	baseBranch: string;
	/** The execution environment of a working directory: the sandbox, or the role's own (`envFactory`). */
	envFor(cwd?: string): ExecutionEnv;
	client: Pick<SomeWorkClient, "uploadArtifact">;
	log: Log;
}

/** Before the model runs: the job as prepared, with the signal that stops it. */
export interface RunContext extends JobContext {
	signal: AbortSignal;
}

/** After the model finished, before anything is committed. */
export interface FinalizeContext extends JobContext {
	answer: string;
	usage: Usage;
	signal: AbortSignal;
	onProgress(update: ProgressUpdate): void;
}

/** After the work is settled (pushed, nothing to push, or blocked), before the task result is reported. */
export interface ResultContext extends JobContext {
	answer: string;
	usage: Usage;
	/** Present when the role's `beforeFinalize` blocked the push. */
	blocked?: Blocked;
	/** The git outcome; absent for read-only roles and for blocked runs. */
	finalize?: FinalizeResult;
}

/** What a `result` hook changes. */
export interface ResultPatch {
	/** Replaces the kit's result (spread `base` to extend it instead). */
	result?: Record<string, unknown>;
	/** Added to the artifacts the kit already attaches (the diff). */
	artifacts?: unknown[];
	/** Ends the task as failed instead. */
	failure?: Failure;
}

/** Everything a hook factory may use of the service that is being composed. */
export interface ServiceContext {
	env: NodeJS.ProcessEnv;
	config: import("./config.ts").Config;
	log: Log;
	client: SomeWorkClient;
	/** The git token, when the service has one (it never goes to a host outside `GIT_TOKEN_HOSTS`). */
	gitToken?: string;
}

/** Role-specific behaviour that is code rather than data. Every member is optional; the defaults are the developer role's. */
export interface RoleHooks {
	/** Async preparation of the job input before the instruction is built (fetching context, for example). Throw `InvalidInput` to refuse. */
	prepareInput?(input: any, context: { taskId: string; log: Log }): Promise<any> | any;
	/** Turns the job input into the model's instruction. Throw `InvalidInput` to refuse the job. Default: `input.instruction`. */
	instruction?(input: any, context: { taskId: string }): string;
	/** Pull request title and body for a task (called after `beforeFinalize`). */
	pullRequest?(input: any, context: { taskId: string; instruction: string }): { title: string; body: string };
	/** Extra Pi Durable extensions (tools, prompt sections, hooks) for this role. */
	extensions?: Extension<any>[];
	/** Extra readiness checks next to the sandbox: name to ok. */
	readinessChecks?: Record<string, () => Promise<boolean>>;
	/**
	 * The role's own execution environment for the model's tools and the git steps (a role that runs on a machine without the container
	 * sandbox). When set, the kit neither needs a sandbox URL token nor checks the sandbox's health.
	 */
	envFactory?(cwd: string | undefined): ExecutionEnv;
	/** Interface the health endpoint listens on. Default `0.0.0.0`. */
	healthBind?: string;
	/**
	 * After the workspace is ready and before the model runs (start the application under test, prepare fixtures). Return `{ blocked }` to
	 * skip the model: the task completes with `status: "blocked"` without spending a token (the `result` hook says why). Throwing fails the
	 * job as a retryable `job_error`. `afterRun` is always called after this has been called, whatever it returned.
	 */
	beforeRun?(context: RunContext): Promise<void | { blocked: Blocked }>;
	/**
	 * After the model run, whatever happened (answer, failure, stop, detach, blocked, a throwing `beforeRun`): stop what `beforeRun` started.
	 * Called once per attempt as soon as the workspace was ready (not when the ref could not be resolved); an error it throws is logged and
	 * never changes the outcome.
	 */
	afterRun?(context: JobContext): Promise<void>;
	/**
	 * Between "the model finished" and commit/push, for every role (read-only ones too). Return `{ blocked }` to stop the work from leaving
	 * the workspace: the task completes with `status: "blocked"` (metrics label `blocked`, log event `job_blocked`) and the `result` hook
	 * can say why. Throwing fails the job as a retryable `job_error`.
	 */
	beforeFinalize?(context: FinalizeContext): Promise<void | { blocked: Blocked }>;
	/** Reshape or extend the task result and attach artifacts once the work is settled (completed, no changes, or blocked). */
	result?(base: Record<string, unknown>, context: ResultContext): Promise<ResultPatch | void> | ResultPatch | void;
	/** Wrap the agent runtime (repair turns, output validation). Applied once, around the Pi Durable runtime. */
	wrapRuntime?(runtime: AgentRuntime): AgentRuntime;
	/** Called once per job when the handler is done with it for good (not when it detaches), so a role can drop per-job state. */
	onSettled?(taskId: string, outcome: Outcome): void;
}

/** Thrown from `RoleHooks.instruction` when the input is not acceptable; becomes a non-retryable `invalid_input` failure. */
export class InvalidInput extends Error {
	override readonly name = "InvalidInput";
}

export function validateProfile(profile: AgentProfile): AgentProfile {
	if (!profile.id) throw new Error("profile.id is required");
	if (profile.capabilities.length === 0) throw new Error(`profile ${profile.id} serves no capability`);
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(profile.git.branchPrefix)) throw new Error(`profile ${profile.id}: branchPrefix must be a plain ref segment`);
	if (profile.git.pullRequest && !profile.git.push) throw new Error(`profile ${profile.id}: a pull request needs the branch to be pushed`);
	if (!(profile.defaultBudget.maxTokens > 0) || !(profile.defaultBudget.maxMinutes > 0)) throw new Error(`profile ${profile.id}: defaultBudget must be positive`);
	if (profile.chat !== undefined) {
		if (typeof profile.chat !== "object" || profile.chat === null) throw new Error(`profile ${profile.id}: chat must be an object`);
		if (profile.chat.autoReply !== undefined && typeof profile.chat.autoReply !== "boolean") throw new Error(`profile ${profile.id}: chat.autoReply must be true or false`);
		if (profile.chat.replyTemplate !== undefined && typeof profile.chat.replyTemplate !== "function") throw new Error(`profile ${profile.id}: chat.replyTemplate must be a function`);
	}
	validateEventsProfile(profile.id, profile.events);
	return profile;
}

import { createServer, type Server } from "node:http";
import type { Failure, Handler, Job, JobControl, Outcome, SomeWorkClient } from "@somework/sdk";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { BranchExhaustedError, DEFAULT_BRANCH_PREFIX, finalizeWorkspace, prepareScratchWorkspace, prepareWorkspace, pushedWork, RefNotFoundError, workspaceFor, type FinalizeResult, type GitSession } from "./git.ts";
import { noPullRequests, type GitHost } from "./githost.ts";
import { describeOutcome, type JobJournal } from "./journal.ts";
import type { DailyLedger } from "./ledger.ts";
import { silent, type Log } from "./log.ts";
import { Metrics } from "./metrics.ts";
import { InvalidInput, type AgentProfile, type JobContext, type ResultContext, type RoleHooks } from "./profile.ts";
import { isAllowed, type ModelRef } from "./providers/allowlist.ts";
import type { AgentOutcome, AgentRuntime, ApprovalDecision, Usage } from "./runtime.ts";
import { ownsKey, type ShardTable } from "./shards.ts";

export interface Limits {
	/** Largest per-job budget a requester may ask for. */
	maxTokensCap: number;
	maxMinutesCap: number;
}

export interface HandlerDeps {
	runtime: AgentRuntime;
	session: GitSession;
	host: GitHost;
	/** Root directory of the workspaces, inside the sandbox. */
	workspaceRoot: string;
	client: Pick<SomeWorkClient, "uploadArtifact">;
	limits: Limits;
	/** What the daily budget check and the usage record talk to: the tasks pool, or a pool of its own (chat instructions). */
	ledger?: Pick<DailyLedger, "remaining" | "record">;
	shards?: { table: ShardTable; agentId: string };
	/** Models a job may request with `input.model`. Without it (or without a match) the request is refused. */
	allowedModels?: readonly ModelRef[];
	metrics?: Metrics;
	log?: Log;
	/** The role. Without one the handler behaves as the developer role always has (branch prefix `agent`, push and pull request on). */
	profile?: AgentProfile;
	hooks?: RoleHooks;
	/** Environment of a working directory for the hooks (default: the session's). */
	envFor?: (cwd?: string) => ExecutionEnv;
	/** The tools every conversation of this handler is offered instead of the runtime's list (a narrower set only). */
	requestTools?: readonly string[];
	/** Where finished jobs are noted for the chat's state summary. */
	journal?: JobJournal;
	/** Which kind of job this handler runs, for the journal. */
	source?: "job" | "task" | "chat";
}

/** The service's metrics, in one place so the names are stable. */
export function createServiceMetrics(metrics: Metrics) {
	return {
		jobs: metrics.counter("somework_pi_jobs_total", "Jobs finished, by status"),
		duration: metrics.histogram("somework_pi_job_duration_seconds", "Job duration", [10, 30, 60, 120, 300, 600, 1800, 3600]),
		tokens: metrics.counter("somework_pi_tokens_total", "Model tokens used, by kind"),
		cost: metrics.counter("somework_pi_cost_usd_total", "Model cost in USD"),
		tools: metrics.counter("somework_pi_tool_calls_total", "Tool calls started, by tool"),
		active: metrics.gauge("somework_pi_active_jobs", "Jobs running now"),
		approvals: metrics.counter("somework_pi_approvals_total", "Approval requests, by decision"),
		detached: metrics.counter("somework_pi_detached_total", "Jobs left running when the worker stopped or lost its lease"),
	};
}

const fail = (code: string, message: string, retryable = false): Outcome => ({ type: "failed", failure: { code, message, retryable } satisfies Failure });

function requestedModel(value: unknown): ModelRef | "invalid" | undefined {
	if (value === undefined) return undefined;
	const { provider, id } = (value ?? {}) as { provider?: unknown; id?: unknown };
	return typeof provider === "string" && provider && typeof id === "string" && id ? { provider, modelId: id } : "invalid";
}

const DEVELOPER_DEFAULTS = {
	git: { push: true, pullRequest: true, branchPrefix: DEFAULT_BRANCH_PREFIX },
	requireBudget: true,
};

function parseApproval(answer: unknown): ApprovalDecision {
	if (answer && typeof answer === "object" && "approved" in answer) return { approved: (answer as any).approved === true, reason: typeof (answer as any).reason === "string" ? (answer as any).reason : undefined };
	return { approved: false, reason: "no answer" };
}

/** The handler of a repository task: validate, budget, prepare the workspace, run the model, finalize, report. Roles differ by profile and hooks. */
export function createHandler(deps: HandlerDeps): Handler {
	const handle = createJobHandler(deps);
	const onSettled = deps.hooks?.onSettled;
	const journal = deps.journal;
	if (!onSettled && !journal) return handle;
	return async (job: Job, control: JobControl): Promise<Outcome> => {
		const started = Date.now();
		const outcome = await handle(job, control);
		if (outcome.type !== "detach") {
			try {
				onSettled?.(job.taskId, outcome);
			} catch (error) {
				(deps.log ?? silent)("warn", "on_settled_failed", { taskId: job.taskId, error: error instanceof Error ? error.message : String(error) });
			}
			try {
				const described = describeOutcome(outcome);
				if (journal && described) journal.record({ taskId: job.taskId, capability: `${job.capability?.id ?? "?"}@${job.capability?.version ?? "?"}`, source: deps.source ?? "job", at: new Date().toISOString(), startedAt: new Date(started).toISOString(), ms: Date.now() - started, ...described });
			} catch (error) {
				(deps.log ?? silent)("warn", "journal_failed", { taskId: job.taskId, error: error instanceof Error ? error.message : String(error) });
			}
		}
		return outcome;
	};
}

function createJobHandler(deps: HandlerDeps): Handler {
	const log = deps.log ?? silent;
	const m = createServiceMetrics(deps.metrics ?? new Metrics());
	const profile = deps.profile;
	const hooks = deps.hooks;
	const git = profile?.git ?? DEVELOPER_DEFAULTS.git;
	const requireBudget = profile?.requireBudget ?? DEVELOPER_DEFAULTS.requireBudget;
	const host = git.pullRequest ? deps.host : noPullRequests;
	const envFor = deps.envFor ?? (() => deps.session.env);

	return async (job: Job, control: JobControl): Promise<Outcome> => {
		const input = job.input ?? {};
		const taskId = job.taskId;
		const served = profile?.capabilities;
		if (served && typeof job.capability?.id === "string" && !served.some((c) => c.id === job.capability.id && (job.capability.version === undefined || c.version === String(job.capability.version)))) {
			return fail("unsupported_capability", `this agent serves ${served.map((c) => `${c.id}@${c.version}`).join(", ")}, not ${job.capability.id}@${job.capability.version}`);
		}
		let prepared = input;
		let instruction: string;
		try {
			if (hooks?.prepareInput) prepared = (await hooks.prepareInput(input, { taskId, log })) ?? input;
			instruction = hooks?.instruction ? hooks.instruction(prepared, { taskId }) : prepared.instruction;
		} catch (error) {
			if (error instanceof InvalidInput) return fail("invalid_input", error.message);
			log("error", "job_failed", { taskId, error: error instanceof Error ? error.message : String(error) });
			return fail("job_error", error instanceof Error ? error.message.slice(0, 500) : "unknown error", true);
		}
		// what the role's `prepareInput` returned is the job from here on (it may fill in the ref, name the conversation, add context)
		const repository = prepared.repository;
		const scratch = profile?.noRepository === true;
		if (scratch) {
			if (typeof instruction !== "string") return fail("invalid_input", "an instruction is required");
		} else {
			if (typeof instruction !== "string" || typeof repository?.url !== "string" || typeof repository?.ref !== "string") return fail("invalid_input", "instruction and repository {url, ref} are required");
			if (repository.baseRef !== undefined && typeof repository.baseRef !== "string") return fail("invalid_input", "repository.baseRef must be a branch name");
		}
		const requested = prepared.budget && prepared.budget.maxTokens > 0 && prepared.budget.maxMinutes > 0 ? prepared.budget : undefined;
		if (!requested && (requireBudget || !profile)) return fail("budget_required", "a job without a token and time budget is not accepted");
		const asked = requested ?? profile!.defaultBudget;
		const budget = { maxTokens: Math.min(asked.maxTokens, deps.limits.maxTokensCap), maxMinutes: Math.min(asked.maxMinutes, deps.limits.maxMinutesCap) };
		const agentKey: string = prepared.agentKey ?? `${scratch ? "scratch" : repository.url}#${job.task.conversationId ?? taskId}`;
		if (deps.shards && !ownsKey(deps.shards.table, deps.shards.agentId, agentKey)) return fail("wrong_shard", "this agent does not own the shard of that agentKey; route the task with targetAgentId from the shard table");
		if (deps.ledger && deps.ledger.remaining() < budget.maxTokens) {
			m.jobs({ status: "budget_exhausted" });
			log("warn", "job_refused", { taskId, reason: "budget_exhausted", requestedTokens: budget.maxTokens, remainingTokens: deps.ledger.remaining() });
			return fail("budget_exhausted", "the daily token budget does not cover this job");
		}

		const model = requestedModel(prepared.model);
		if (model === "invalid") return fail("invalid_input", "model must be {provider, id}");
		if (model && !isAllowed(deps.allowedModels ?? [], model)) return fail("model_not_allowed", `model ${model.provider}/${model.modelId} is not enabled on this agent`);

		const started = Date.now();
		m.active.add(1);
		const workspace = workspaceFor(deps.workspaceRoot, agentKey);
		const fields = { taskId, agentKey };
		let runStarted: JobContext | undefined;
		try {
			if (hooks?.beforeWorkspace) {
				const gate = await hooks.beforeWorkspace(prepared, { taskId, log });
				if (gate && "blocked" in gate) {
					m.duration((Date.now() - started) / 1000, { status: "blocked" });
					m.jobs({ status: "blocked" });
					log("info", "job_blocked", { ...fields, reason: gate.blocked.reason.slice(0, 200), before: "workspace" });
					const unstarted: JobContext = { taskId, input: prepared, instruction, workspace: "", baseSha: "", baseBranch: "", envFor, client: deps.client, log };
					const patch = await hooks.result?.({ status: "blocked", summary: "", usage: { totalTokens: 0, costUsd: 0 } }, { ...unstarted, answer: "", usage: emptyUsageValue(), blocked: gate.blocked });
					if (patch?.failure) return { type: "failed", failure: patch.failure };
					return { type: "completed", result: patch?.result ?? { status: "blocked", summary: "", usage: { totalTokens: 0, costUsd: 0 } }, artifacts: patch?.artifacts ?? [] };
				}
			}
			let base;
			try {
				if (scratch) base = await prepareScratchWorkspace(deps.session, workspace);
				else
					base = await prepareWorkspace(deps.session, {
						repoUrl: repository.url,
						ref: repository.ref,
						baseRef: repository.baseRef,
						taskId,
						workspace,
						branchPrefix: git.branchPrefix,
						detach: !git.push,
						...(hooks?.branchName ? { branch: (resolved) => hooks.branchName!({ input: prepared, taskId, baseSha: resolved.sha }) } : {}),
					});
			} catch (error) {
				if (error instanceof RefNotFoundError) {
					m.jobs({ status: "ref_not_found" });
					log("warn", "job_refused", { ...fields, reason: "ref_not_found" });
					return fail("ref_not_found", error.message);
				}
				throw error;
			}
			log("info", "workspace_ready", { ...fields, ref: repository?.ref, refKind: base.refKind, baseSha: base.baseSha, baseBranch: base.baseBranch });
			const jobContext: JobContext = { taskId, input: prepared, instruction, workspace, baseSha: base.baseSha, baseBranch: base.baseBranch, envFor, client: deps.client, log };
			const settled = async (result: Record<string, unknown>, artifacts: unknown[], answer: string, usage: Usage, extra: Partial<ResultContext>): Promise<Outcome> => {
				const patch = await hooks?.result?.(result, { ...jobContext, answer, usage, ...extra });
				if (patch?.failure) return { type: "failed", failure: patch.failure };
				return { type: "completed", result: patch?.result ?? result, artifacts: [...artifacts, ...(patch?.artifacts ?? [])] };
			};
			runStarted = jobContext;
			if (hooks?.beforeRun) {
				const gate = await hooks.beforeRun({ ...jobContext, signal: control.signal });
				if (gate && "blocked" in gate) {
					m.duration((Date.now() - started) / 1000, { status: "blocked" });
					m.jobs({ status: "blocked" });
					log("info", "job_blocked", { ...fields, reason: gate.blocked.reason.slice(0, 200), before: "run" });
					return await settled({ status: "blocked", summary: "", usage: { totalTokens: 0, costUsd: 0 } }, [], "", emptyUsageValue(), { blocked: gate.blocked });
				}
			}
			const resumed = await resumeFromPushedWork(deps.session, host, hooks, git.push, jobContext, base.baseSha);
			if (resumed) log("info", "job_resumed", { ...fields, branch: resumed.branch, sha: resumed.sha });
			const outcome: AgentOutcome = resumed
				? { status: "done", answer: resumed.answer, usage: emptyUsageValue() }
				: await deps.runtime.execute(
						{ requestId: `somework:${taskId}`, agentKey, instruction, workspace, budget, ...(model ? { model } : {}), ...(deps.requestTools ? { tools: deps.requestTools } : {}) },
						{
							signal: control.signal,
							onProgress: (update) => control.progress(update),
							onTool: (name) => m.tools({ tool: name }),
							requestApproval: async (request) => {
								log("info", "approval_requested", { ...fields, tool: request.tool });
								const decision = parseApproval(await control.requestInput({ kind: "approval", tool: request.tool, summary: request.summary }));
								m.approvals({ decision: decision.approved ? "approved" : "denied" });
								return decision;
							},
						},
					);
			if (outcome.status === "detached") {
				m.detached();
				return { type: "detach" };
			}
			recordUsage(outcome.usage, deps, m);
			log("info", "job_finished", {
				...fields,
				status: outcome.status === "aborted" ? outcome.reason : outcome.status,
				inputTokens: outcome.usage.inputTokens,
				outputTokens: outcome.usage.outputTokens,
				totalTokens: outcome.usage.totalTokens,
				costUsd: outcome.usage.costUsd,
				durationMs: Date.now() - started,
			});
			if (outcome.status !== "done") {
				m.duration((Date.now() - started) / 1000, { status: outcome.status });
				m.jobs({ status: outcome.status === "aborted" ? outcome.reason : outcome.status });
				if (outcome.status === "aborted") return fail(outcome.reason, `the run was stopped: ${outcome.reason}`);
				return fail("model_failed", `the model run ended without an answer: ${outcome.reason}`);
			}

			const usage = { totalTokens: outcome.usage.totalTokens, costUsd: outcome.usage.costUsd };

			const gate = await hooks?.beforeFinalize?.({ ...jobContext, answer: outcome.answer, usage: outcome.usage, signal: control.signal, onProgress: (update) => control.progress(update) });
			if (gate && "blocked" in gate) {
				m.duration((Date.now() - started) / 1000, { status: "blocked" });
				m.jobs({ status: "blocked" });
				log("info", "job_blocked", { ...fields, reason: gate.blocked.reason.slice(0, 200) });
				return await settled({ status: "blocked", summary: outcome.answer.slice(0, 4000), usage }, [], outcome.answer, outcome.usage, { blocked: gate.blocked });
			}
			m.duration((Date.now() - started) / 1000, { status: "done" });
			m.jobs({ status: "done" });

			if (!git.push) {
				log("info", "job_done", { ...fields, status: "completed", commits: 0 });
				return await settled({ status: "completed", summary: outcome.answer.slice(0, 4000), usage }, [], outcome.answer, outcome.usage, {});
			}
			const pullRequest = hooks?.pullRequest?.(prepared, { taskId, instruction }) ?? { title: instruction.split("\n")[0]!.slice(0, 72), body: `Opened by the SomeWork Pi agent for task ${taskId}.` };
			const done: FinalizeResult = await finalizeWorkspace(deps.session, host, {
				repoUrl: repository.url,
				ref: repository.ref,
				baseSha: base.baseSha,
				baseBranch: base.baseBranch,
				taskId,
				workspace,
				title: pullRequest.title,
				body: pullRequest.body,
				branchPrefix: git.branchPrefix,
				branch: base.branch || undefined,
				...(pullRequest.commitMessage ? { commitMessage: pullRequest.commitMessage } : {}),
			});
			const artifacts: unknown[] = [];
			if (done.patch) artifacts.push(await deps.client.uploadArtifact({ filename: `${taskId}.diff`, mediaType: "text/x-diff", bytes: done.patch, sourceTaskId: taskId }));
			log("info", "job_done", { ...fields, status: done.status, commits: done.commits.length });
			return await settled(
				{ status: done.status, summary: outcome.answer.slice(0, 4000), branch: done.branch, commits: done.commits, ...(done.prUrl ? { prUrl: done.prUrl } : {}), usage },
				artifacts,
				outcome.answer,
				outcome.usage,
				{ finalize: done },
			);
		} catch (error) {
			log("error", "job_failed", { ...fields, error: error instanceof Error ? error.message : String(error) });
			m.jobs({ status: "error" });
			// every branch name the work could go on is taken by different work: another attempt would find the same
			if (error instanceof BranchExhaustedError) return fail("branch_exhausted", error.message.slice(0, 500));
			// infrastructure trouble (git, sandbox): another attempt may succeed, and every step is idempotent
			return fail("job_error", error instanceof Error ? error.message.slice(0, 500) : "unknown error", true);
		} finally {
			m.active.add(-1);
			if (runStarted && hooks?.afterRun) {
				try {
					await hooks.afterRun(runStarted);
				} catch (error) {
					log("warn", "after_run_failed", { ...fields, error: error instanceof Error ? error.message.slice(0, 300) : String(error) });
				}
			}
		}
	};
}

/**
 * A retry of a task whose work was already pushed from this workspace, when the role says it can finish without the model and the pull
 * request is the only thing missing: the answer the role recovered, else undefined (run the model as usual).
 */
async function resumeFromPushedWork(session: GitSession, host: GitHost, hooks: RoleHooks | undefined, pushes: boolean, context: JobContext, baseSha: string): Promise<{ answer: string; branch: string; sha: string } | undefined> {
	if (!pushes || !hooks?.resume) return undefined;
	const pushed = await pushedWork(session, { workspace: context.workspace, taskId: context.taskId, baseSha });
	if (!pushed) return undefined;
	const repoUrl = context.input?.repository?.url;
	if (typeof repoUrl !== "string" || (await host.findPullRequest({ repoUrl, head: pushed.branch }))) return undefined;
	const recovered = await hooks.resume({ ...context, branch: pushed.branch, sha: pushed.sha });
	return recovered ? { answer: recovered.answer, ...pushed } : undefined;
}

const emptyUsageValue = (): Usage => ({ inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 });

function recordUsage(usage: Usage, deps: HandlerDeps, m: ReturnType<typeof createServiceMetrics>): void {
	m.tokens({ kind: "input" }, usage.inputTokens);
	m.tokens({ kind: "output" }, usage.outputTokens);
	m.cost({}, usage.costUsd);
	deps.ledger?.record(usage.totalTokens);
}

import { createServer, type Server } from "node:http";
import type { Failure, Handler, Job, JobControl, Outcome, SomeWorkClient } from "@somework/sdk";
import { finalizeWorkspace, prepareWorkspace, workspaceFor, type GitSession } from "./git.ts";
import type { GitHost } from "./githost.ts";
import type { DailyLedger } from "./ledger.ts";
import { silent, type Log } from "./log.ts";
import { Metrics } from "./metrics.ts";
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
	ledger?: DailyLedger;
	shards?: { table: ShardTable; agentId: string };
	/** Models a job may request with `input.model`. Without it (or without a match) the request is refused. */
	allowedModels?: readonly ModelRef[];
	metrics?: Metrics;
	log?: Log;
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

function parseApproval(answer: unknown): ApprovalDecision {
	if (answer && typeof answer === "object" && "approved" in answer) return { approved: (answer as any).approved === true, reason: typeof (answer as any).reason === "string" ? (answer as any).reason : undefined };
	return { approved: false, reason: "no answer" };
}

export function createHandler(deps: HandlerDeps): Handler {
	const log = deps.log ?? silent;
	const m = createServiceMetrics(deps.metrics ?? new Metrics());

	return async (job: Job, control: JobControl): Promise<Outcome> => {
		const input = job.input ?? {};
		const repository = input.repository;
		const taskId = job.taskId;
		if (typeof input.instruction !== "string" || typeof repository?.url !== "string" || typeof repository?.ref !== "string") return fail("invalid_input", "instruction and repository {url, ref} are required");
		if (!input.budget || !(input.budget.maxTokens > 0) || !(input.budget.maxMinutes > 0)) return fail("budget_required", "a job without a token and time budget is not accepted");
		const budget = { maxTokens: Math.min(input.budget.maxTokens, deps.limits.maxTokensCap), maxMinutes: Math.min(input.budget.maxMinutes, deps.limits.maxMinutesCap) };
		const agentKey: string = input.agentKey ?? `${repository.url}#${job.task.conversationId ?? taskId}`;
		if (deps.shards && !ownsKey(deps.shards.table, deps.shards.agentId, agentKey)) return fail("wrong_shard", "this agent does not own the shard of that agentKey; route the task with targetAgentId from the shard table");
		if (deps.ledger && deps.ledger.remaining() < budget.maxTokens) {
			m.jobs({ status: "budget_exhausted" });
			log("warn", "job_refused", { taskId, reason: "budget_exhausted", requestedTokens: budget.maxTokens, remainingTokens: deps.ledger.remaining() });
			return fail("budget_exhausted", "the daily token budget does not cover this job");
		}

		const model = requestedModel(input.model);
		if (model === "invalid") return fail("invalid_input", "model must be {provider, id}");
		if (model && !isAllowed(deps.allowedModels ?? [], model)) return fail("model_not_allowed", `model ${model.provider}/${model.modelId} is not enabled on this agent`);

		const started = Date.now();
		m.active.add(1);
		const workspace = workspaceFor(deps.workspaceRoot, agentKey);
		const fields = { taskId, agentKey };
		try {
			await prepareWorkspace(deps.session, { repoUrl: repository.url, ref: repository.ref, taskId, workspace });
			const outcome: AgentOutcome = await deps.runtime.execute(
				{ requestId: `somework:${taskId}`, agentKey, instruction: input.instruction, workspace, budget, ...(model ? { model } : {}) },
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
			m.duration((Date.now() - started) / 1000, { status: outcome.status });
			m.jobs({ status: outcome.status === "aborted" ? outcome.reason : outcome.status });
			if (outcome.status === "aborted") return fail(outcome.reason, `the run was stopped: ${outcome.reason}`);
			if (outcome.status === "unanswered") return fail("model_failed", `the model run ended without an answer: ${outcome.reason}`);

			const done = await finalizeWorkspace(deps.session, deps.host, { repoUrl: repository.url, ref: repository.ref, taskId, workspace, title: input.instruction.split("\n")[0]!.slice(0, 72), body: `Opened by the SomeWork Pi agent for task ${taskId}.` });
			const artifacts: unknown[] = [];
			if (done.patch) artifacts.push(await deps.client.uploadArtifact({ filename: `${taskId}.diff`, mediaType: "text/x-diff", bytes: done.patch, sourceTaskId: taskId }));
			log("info", "job_done", { ...fields, status: done.status, commits: done.commits.length });
			return {
				type: "completed",
				result: { status: done.status, summary: outcome.answer.slice(0, 4000), branch: done.branch, commits: done.commits, ...(done.prUrl ? { prUrl: done.prUrl } : {}), usage: { totalTokens: outcome.usage.totalTokens, costUsd: outcome.usage.costUsd } },
				artifacts,
			};
		} catch (error) {
			log("error", "job_failed", { ...fields, error: error instanceof Error ? error.message : String(error) });
			m.jobs({ status: "error" });
			// infrastructure trouble (git, sandbox): another attempt may succeed, and every step is idempotent
			return fail("job_error", error instanceof Error ? error.message.slice(0, 500) : "unknown error", true);
		} finally {
			m.active.add(-1);
		}
	};
}

function recordUsage(usage: Usage, deps: HandlerDeps, m: ReturnType<typeof createServiceMetrics>): void {
	m.tokens({ kind: "input" }, usage.inputTokens);
	m.tokens({ kind: "output" }, usage.outputTokens);
	m.cost({}, usage.costUsd);
	deps.ledger?.record(usage.totalTokens);
}

export interface HealthOptions {
	runtime: AgentRuntime;
	metrics: Metrics;
	/** Extra readiness checks (sandbox reachable, ...): name -> ok. */
	checks?: Record<string, () => Promise<boolean>>;
}

/** `/live`: the process is up. `/ready`: it can accept a job (storage open and resumed, dependencies reachable). `/metrics`: Prometheus. */
export function createHealthServer(options: HealthOptions): Server {
	return createServer(async (req, res) => {
		if (req.url === "/live") return void res.writeHead(200).end("live\n");
		if (req.url === "/metrics") return void res.writeHead(200, { "content-type": "text/plain; version=0.0.4" }).end(options.metrics.render());
		if (req.url === "/ready") {
			const runtime = options.runtime.health();
			const failed: string[] = runtime.ready ? [] : [`runtime: ${runtime.reason}`];
			for (const [name, check] of Object.entries(options.checks ?? {})) if (!(await check().catch(() => false))) failed.push(name);
			return void res.writeHead(failed.length ? 503 : 200, { "content-type": "application/json" }).end(JSON.stringify({ ready: failed.length === 0, failed }));
		}
		res.writeHead(404).end();
	});
}

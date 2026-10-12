import { randomBytes } from "node:crypto";
import type { Handler, Job, JobControl, Outcome, StopReason } from "../job-types.ts";
import type { JobGate } from "../gate.ts";
import { silent, type Log } from "../log.ts";
import type { ApprovalDecision } from "../runtime.ts";
import { JOB_PREFIX } from "./artifacts.ts";
import type { Hold, ResourceRegistry } from "./resources.ts";
import type { DurableTable } from "./store.ts";

export interface Party {
	kind: string;
	id: string;
}

/** What starts a job: who asked, where the answer goes, and what it must have to itself while it runs. */
export interface JobSpec {
	capability: { id: string; version: string };
	input: Record<string, unknown>;
	/** A few words for status lines and events: "verify SAD-2273". */
	label: string;
	requestedBy: Party;
	conversationId?: string;
	/** The message that asked for it, when one did. */
	replyTo?: string;
	/** Who hears how it ended, besides the requester (the others of a group conversation). */
	audience?: Party[];
	/** Singleton resources the job holds for its whole run. */
	resources?: readonly string[];
	/** Lower numbers go first when jobs wait for the same resource (people before agents). */
	priority?: number;
	source: "message" | "event" | "restart";
}

export type JobState = "waiting" | "running" | "finished";

export interface JobEntry extends JobSpec {
	id: string;
	state: JobState;
	createdAt: number;
	startedAt?: number;
	finishedAt?: number;
	/** What the job waits for while `waiting`. */
	waitingFor?: string;
	end?: { kind: "completed" | "failed" | "cancelled"; summary?: string; code?: string };
}

/** What the job manager tells the outside world; the service turns these into messages and events. */
export interface JobReporter {
	waiting(entry: JobEntry, blocking: readonly Hold[]): Promise<void>;
	started(entry: JobEntry): Promise<void>;
	finished(entry: JobEntry, outcome: Outcome | undefined, artifacts: unknown[]): Promise<void>;
}

export interface JobManagerDeps {
	/** The role's job pipeline (see `createHandler`); it receives a synthetic job whose id is the job's. */
	handler: Handler;
	resources: ResourceRegistry;
	gate: JobGate;
	store: DurableTable<JobEntry>;
	reporter: JobReporter;
	/** The references of what the job uploaded (see `JobArtifacts`). */
	takeArtifacts: (jobId: string) => unknown[];
	/** Hands text to the model run of a job at its next turn boundary; false when no run of it is active now. */
	steer: (jobId: string, text: string) => Promise<boolean>;
	/** A step of the job that needs a person's approval. */
	approve: (entry: JobEntry, request: { tool: string; summary: string }, signal: AbortSignal) => Promise<ApprovalDecision>;
	/** The singleton resources a capability's jobs hold while they run, whoever asked for them (the role knows). */
	resourcesFor?: (capabilityId: string, input: Record<string, unknown>) => string[] | undefined;
	/** What a job may use unless it asks for less: the handler clamps it to the role's own limits. */
	budget: { maxTokens: number; maxMinutes: number };
	/** Aborted at shutdown: running jobs are left as they are and picked up again at the next start. */
	signal?: AbortSignal;
	log?: Log;
	now?: () => number;
	/** How often a note for a job whose model run has not started is tried again. */
	noteRetryMs?: number;
}

const FINISHED_KEPT = 200;
const NOTE_RETRY_MS = 1500;

export const newJobId = (): string => `${JOB_PREFIX}${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;

/** The request id of a job's model run: how its run is found again for steering and after a restart. */
export const requestIdOf = (jobId: string): string => `somework:${jobId}`;

/** Whether a model run belongs to a job (its answer is a structured result) and not to a conversation (its answer is a chat reply). */
export const isJobRequest = (requestId: string): boolean => requestId.startsWith("somework:");

/**
 * The jobs of an agent: work that takes a while and runs in the background while the agent keeps talking. A job waits for the singleton
 * resources it needs and for a free job slot, runs through the role's handler, and ends with one result message in its conversation. A message
 * for a running job is handed to its model as a note at the next turn boundary; the job's model decides what to do with it (also with
 * a request to stop). Running jobs are written to disk and started again, under the same run id, after a restart.
 */
export class JobManager {
	readonly #deps: JobManagerDeps;
	readonly #log: Log;
	readonly #now: () => number;
	readonly #running = new Map<string, { abort: AbortController; done: Promise<void> }>();
	readonly #notes = new Map<string, string[]>();
	readonly #noteTimers = new Map<string, ReturnType<typeof setTimeout>>();

	constructor(deps: JobManagerDeps) {
		this.#deps = deps;
		this.#log = deps.log ?? silent;
		this.#now = deps.now ?? Date.now;
	}

	get(jobId: string): JobEntry | undefined {
		return this.#deps.store.get(jobId);
	}

	/** Jobs that have not finished, oldest first. */
	active(): JobEntry[] {
		return this.#deps.store
			.all()
			.filter((entry) => entry.state !== "finished")
			.sort((a, b) => a.createdAt - b.createdAt);
	}

	/** Jobs that finished lately, newest first. */
	recent(limit = 10): JobEntry[] {
		return this.#deps
			.store
			.all()
			.filter((entry) => entry.state === "finished")
			.sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))
			.slice(0, limit);
	}

	/** Active jobs started in a conversation. */
	activeIn(conversationId: string): JobEntry[] {
		return this.active().filter((entry) => entry.conversationId === conversationId);
	}

	/** Starts a job. A job with this id that already exists is returned as it is: the same request never starts the same work twice. */
	start(spec: JobSpec, id = newJobId()): JobEntry {
		const existing = this.get(id);
		if (existing) return existing;
		const resources = spec.resources ?? this.#deps.resourcesFor?.(spec.capability.id, spec.input);
		const entry: JobEntry = { ...spec, ...(resources && resources.length > 0 ? { resources } : {}), id, state: "waiting", createdAt: this.#now() };
		this.#deps.store.put(entry);
		this.#launch(entry);
		return entry;
	}

	/** Starts again every job a previous run left unfinished, under its own id so the model run resumes where it was. */
	recover(): JobEntry[] {
		const open = this.active().filter((entry) => !this.#running.has(entry.id));
		for (const entry of open) this.#launch({ ...entry, state: "waiting", waitingFor: undefined });
		return open;
	}

	/**
	 * A request to stop. A job that has not started simply does not: no model is working on it to decide anything. A running job is told, and
	 * its model decides what to do about it (finish a step, wrap up, carry on).
	 */
	async stop(jobId: string, by: Party, reason?: string): Promise<"cancelled" | "told" | "finished" | "unknown"> {
		const entry = this.get(jobId);
		if (!entry) return "unknown";
		if (entry.state === "finished") return "finished";
		if (entry.state === "waiting") {
			this.#running.get(jobId)?.abort.abort("cancel_requested" satisfies StopReason);
			return "cancelled";
		}
		await this.note(jobId, `${by.id} asks you to stop${reason ? `: ${reason}` : "."} It is your decision how and when: finish what is safe to finish, say what you did, or carry on if you have a good reason.`);
		return "told";
	}

	/** Gives text to a job's model, at its next turn boundary. A note for a job that has not reached its model yet is kept until it has. */
	async note(jobId: string, text: string): Promise<boolean> {
		const entry = this.get(jobId);
		if (!entry || entry.state === "finished") return false;
		const queue = this.#notes.get(jobId) ?? [];
		queue.push(text);
		this.#notes.set(jobId, queue);
		await this.#deliver(jobId);
		return true;
	}

	async #deliver(jobId: string): Promise<void> {
		const queue = this.#notes.get(jobId);
		if (!queue || queue.length === 0) return void this.#notes.delete(jobId);
		const entry = this.get(jobId);
		if (!entry || entry.state === "finished") return void this.#notes.delete(jobId);
		while (queue.length > 0) {
			let delivered = false;
			try {
				delivered = entry.state === "running" && (await this.#deps.steer(jobId, queue[0]!));
			} catch (error) {
				this.#log("warn", "job_note_failed", { jobId, error: error instanceof Error ? error.message.slice(0, 160) : String(error) });
			}
			if (!delivered) break;
			queue.shift();
		}
		if (queue.length === 0) {
			this.#notes.delete(jobId);
			return;
		}
		if (this.#noteTimers.has(jobId)) return;
		this.#noteTimers.set(
			jobId,
			setTimeout(() => {
				this.#noteTimers.delete(jobId);
				void this.#deliver(jobId);
			}, this.#deps.noteRetryMs ?? NOTE_RETRY_MS),
		);
	}

	/** Resolves when no job is waiting or running (tests, shutdown). */
	async idle(): Promise<void> {
		while (this.#running.size > 0) await Promise.allSettled([...this.#running.values()].map((run) => run.done));
	}

	#launch(entry: JobEntry): void {
		const abort = new AbortController();
		const forward = (): void => abort.abort("shutdown" satisfies StopReason);
		this.#deps.signal?.addEventListener("abort", forward, { once: true });
		const done = this.#run(entry, abort)
			.catch((error) => this.#log("error", "job_manager_failed", { jobId: entry.id, error: error instanceof Error ? error.message : String(error) }))
			.finally(() => {
				this.#deps.signal?.removeEventListener("abort", forward);
				this.#running.delete(entry.id);
				const timer = this.#noteTimers.get(entry.id);
				if (timer) clearTimeout(timer);
				this.#noteTimers.delete(entry.id);
				this.#notes.delete(entry.id);
			});
		this.#running.set(entry.id, { abort, done });
	}

	async #run(entry: JobEntry, abort: AbortController): Promise<void> {
		const { reporter } = this.#deps;
		const safely = async (what: string, call: () => Promise<void>): Promise<void> => {
			try {
				await call();
			} catch (error) {
				this.#log("warn", "job_report_failed", { jobId: entry.id, what, error: error instanceof Error ? error.message.slice(0, 160) : String(error) });
			}
		};
		let outcome: Outcome | undefined;
		let cancelled = false;
		let releaseResources: (() => void) | undefined;
		let releaseSlot: (() => void) | undefined;
		try {
			const names = entry.resources ?? [];
			if (names.length > 0) {
				releaseResources = await this.#deps.resources.acquire(names, { holder: entry.id, label: entry.label }, {
					signal: abort.signal,
					priority: entry.priority,
					onWait: (blocking) => {
						const waiting = { ...entry, waitingFor: blocking.map((hold) => `${hold.resource} (held by ${hold.label})`).join(", ") };
						this.#deps.store.put(waiting);
						void safely("waiting", () => reporter.waiting(waiting, blocking));
					},
				});
			}
			releaseSlot = await this.#deps.gate.acquire("task", abort.signal);
			const running: JobEntry = { ...this.get(entry.id)!, state: "running", startedAt: this.#now(), waitingFor: undefined };
			this.#deps.store.put(running);
			await safely("started", () => reporter.started(running));
			void this.#deliver(entry.id);
			outcome = await this.#deps.handler(this.#synthetic(running), this.#control(running, abort));
		} catch (error) {
			if (abort.signal.reason === ("cancel_requested" satisfies StopReason)) cancelled = true;
			else if (abort.signal.reason === ("shutdown" satisfies StopReason)) outcome = { type: "detach" };
			else outcome = { type: "failed", failure: { code: "job_error", message: error instanceof Error ? error.message.slice(0, 500) : String(error), retryable: false } };
		} finally {
			releaseSlot?.();
			releaseResources?.();
		}
		if (outcome?.type === "detach") {
			this.#log("info", "job_detached", { jobId: entry.id });
			return;
		}
		const current = this.get(entry.id)!;
		const finished: JobEntry = { ...current, state: "finished", finishedAt: this.#now(), waitingFor: undefined, end: describeEnd(outcome, cancelled) };
		this.#deps.store.put(finished);
		this.#trim();
		const artifacts = uniqueArtifacts([...(outcome?.type === "completed" ? (outcome.artifacts ?? []) : []), ...this.#deps.takeArtifacts(entry.id)]);
		await safely("finished", () => reporter.finished(finished, outcome, artifacts));
	}

	#synthetic(entry: JobEntry): Job {
		const input = { ...entry.input, budget: entry.input.budget ?? this.#deps.budget };
		return { taskId: entry.id, capability: entry.capability, input, task: { conversationId: entry.conversationId, jobId: entry.id, label: entry.label, source: entry.source, requestedBy: entry.requestedBy, ...(entry.replyTo ? { replyTo: entry.replyTo } : {}) }, fencingToken: 0, runtimeInstanceId: "threads" } as unknown as Job;
	}

	#control(entry: JobEntry, abort: AbortController): JobControl {
		return {
			signal: abort.signal,
			get stopReason() {
				return abort.signal.aborted ? (abort.signal.reason as StopReason) : undefined;
			},
			progress: () => undefined,
			requestInput: async (question: unknown) => {
				const asked = question && typeof question === "object" ? (question as { tool?: unknown; summary?: unknown }) : {};
				return this.#deps.approve(entry, { tool: String(asked.tool ?? "a step").slice(0, 60), summary: String(asked.summary ?? "").slice(0, 400) }, abort.signal);
			},
		};
	}

	#trim(): void {
		const finished = this.recent(Number.MAX_SAFE_INTEGER);
		for (const old of finished.slice(FINISHED_KEPT)) this.#deps.store.remove(old.id);
	}
}

function describeEnd(outcome: Outcome | undefined, cancelled: boolean): NonNullable<JobEntry["end"]> {
	if (cancelled || !outcome) return { kind: "cancelled" };
	if (outcome.type === "failed") return { kind: "failed", code: outcome.failure.code, summary: outcome.failure.message.slice(0, 300) };
	const result = outcome.type === "completed" ? ((outcome.result ?? {}) as Record<string, unknown>) : {};
	return { kind: "completed", ...(typeof result.summary === "string" ? { summary: result.summary.slice(0, 300) } : {}) };
}

/** A hook that uploads through the wrapped client and also returns the reference in its result would carry the artifact twice. */
function uniqueArtifacts(artifacts: unknown[]): unknown[] {
	const seen = new Set<string>();
	return artifacts.filter((ref) => {
		const id = (ref as { artifactId?: unknown } | null)?.artifactId;
		if (typeof id !== "string") return true;
		if (seen.has(id)) return false;
		seen.add(id);
		return true;
	});
}

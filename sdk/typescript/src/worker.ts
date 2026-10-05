import { Backoff, sleep } from "./backoff.ts";
import { SomeWorkError, TERMINAL_STATES, type Failure, type SomeWorkClient } from "./client.ts";
import { runWakes, type Wake } from "./wake.ts";

/** Why the SDK asked the handler to stop. The handler decides what each means (e.g. abort vs. detach). */
export type StopReason = "cancel_requested" | "timeout" | "lease_lost" | "shutdown";

export type Outcome =
	| { type: "completed"; result: unknown; artifacts?: unknown[] }
	| { type: "failed"; failure: Failure }
	/** Report nothing and keep the work: the lease lapses and the task is re-queued, so a later claim can re-attach. */
	| { type: "detach" };

export interface Job {
	task: any;
	input: any;
	capability: any;
	fencingToken: number;
	taskId: string;
	runtimeInstanceId: string;
}

export interface ProgressUpdate {
	message?: string;
	percent?: number;
	checkpoint?: unknown;
}

export interface JobControl {
	/** Aborted when the SDK wants the handler to stop; see `stopReason`. */
	readonly signal: AbortSignal;
	readonly stopReason: StopReason | undefined;
	/** Throttled into durable checkpoints. */
	progress(update: ProgressUpdate): void;
	/**
	 * Ask the requester a question and wait for the answer (the task shows `input_required`; the lease keeps being extended).
	 * Rejects with the stop reason if the job is stopped meanwhile.
	 */
	requestInput(question: unknown): Promise<unknown>;
}

export type Handler = (job: Job, control: JobControl) => Promise<Outcome>;

export interface Logger {
	(level: "debug" | "info" | "warn", message: string, fields?: Record<string, unknown>): void;
}

export interface WorkerOptions {
	handler: Handler;
	concurrency?: number;
	leaseSeconds?: number;
	/** Fraction of the lease after which it is extended. */
	heartbeatRatio?: number;
	/** `auto`: learn about work over NATS when the domain offers it, HTTP otherwise. `poll`: short HTTP lookups only. Never a held-open request. */
	wake?: "auto" | "poll";
	/** How often queued tasks are looked up over HTTP while NATS is healthy (the safety net for lost notifications). */
	sweepEveryMs?: number;
	/** Interval of the short HTTP lookups when NATS is unavailable or `wake` is `poll`. */
	pollEveryMs?: number;
	progressThrottleMs?: number;
	runtimeHeartbeatSeconds?: number;
	/** After shutdown starts, how long running handlers get before the worker gives up waiting. */
	shutdownGraceMs?: number;
	logger?: Logger;
}

/** Errors that mean "this task is no longer ours": stop, discard the outcome, do not report. */
const LEASE_LOSS = new Set(["stale_fencing_token", "lease_expired", "task_terminal", "invalid_transition", "not_found", "policy_denied"]);
/** A claim that failed for a reason that will not change by retrying. */
const CLAIM_NOT_NEEDED = new Set(["already_claimed", "task_terminal", "invalid_transition", "not_found", "policy_denied", "stale_revision", "validation_failed"]);

const code = (error: unknown): string => (error instanceof SomeWorkError ? error.code : "");

const acknowledge = async (offers: Wake[]): Promise<void> => {
	await Promise.allSettled(offers.map((offer) => offer.ack()));
};

/** The agent's own claim loop: wait for a wake, claim, keep the lease, run the handler, commit exactly one outcome under the fencing token. */
export class Worker {
	readonly #client: SomeWorkClient;
	readonly #options: Required<Omit<WorkerOptions, "logger">> & { logger: Logger };
	readonly #inflight = new Set<string>();
	/** Task ids to look at, with the wakes to acknowledge once a claim decision is made. */
	readonly #pending = new Map<string, Wake[]>();
	#pendingWaiters: (() => void)[] = [];
	#slotWaiters: (() => void)[] = [];
	#cooldownUntil = 0;
	readonly #seenInputs = new Set<string>();

	constructor(client: SomeWorkClient, options: WorkerOptions) {
		this.#client = client;
		this.#options = {
			concurrency: 1,
			leaseSeconds: 30,
			heartbeatRatio: 0.33,
			wake: "auto",
			sweepEveryMs: 25_000,
			pollEveryMs: 2_000,
			progressThrottleMs: 250,
			runtimeHeartbeatSeconds: 10,
			shutdownGraceMs: 10_000,
			logger: () => {},
			...options,
		};
	}

	/** Runs until `signal` aborts, then lets running handlers finish (they are told `shutdown`) within the grace period. */
	async run(signal: AbortSignal): Promise<void> {
		const log = this.#options.logger;
		await this.#registerRuntime(signal);
		if (signal.aborted) return;
		const heartbeats = this.#runtimeHeartbeats(signal);
		const running = new Set<Promise<void>>();
		const stopWakes = new AbortController();
		const wakes = runWakes(this.#client, AbortSignal.any([signal, stopWakes.signal]), (wake) => this.#offer(wake), {
			mode: this.#options.wake,
			kinds: ["task"],
			sweepEveryMs: this.#options.sweepEveryMs,
			pollEveryMs: this.#options.pollEveryMs,
			logger: log,
		});

		while (!signal.aborted) {
			if (this.#inflight.size >= this.#options.concurrency) {
				await this.#slotFree(signal);
				continue;
			}
			if (Date.now() < this.#cooldownUntil) {
				await sleep(this.#cooldownUntil - Date.now(), signal);
				continue;
			}
			const next = this.#takePending();
			if (!next) {
				await this.#pendingOffered(signal);
				continue;
			}
			const [taskId, offers] = next;
			if (this.#inflight.has(taskId)) {
				await acknowledge(offers);
				continue;
			}
			this.#inflight.add(taskId);
			const job = this.#claimAndRun(taskId, offers, signal).finally(() => {
				this.#inflight.delete(taskId);
				running.delete(job);
				this.#wakeSlotWaiters();
			});
			running.add(job);
		}

		// graceful stop: handlers were told `shutdown`; wait for them, then end the runtime
		await Promise.race([Promise.allSettled([...running]), sleep(this.#options.shutdownGraceMs)]);
		stopWakes.abort();
		await wakes.catch(() => {});
		heartbeats.stop();
		await this.#client.endRuntime().catch(() => {});
	}

	#offer(wake: Wake): void {
		if (wake.kind !== "task") return void wake.ack();
		const offers = this.#pending.get(wake.taskId) ?? [];
		offers.push(wake);
		this.#pending.set(wake.taskId, offers);
		const waiters = this.#pendingWaiters;
		this.#pendingWaiters = [];
		for (const resolve of waiters) resolve();
	}

	#takePending(): [string, Wake[]] | undefined {
		const first = this.#pending.entries().next();
		if (first.done) return undefined;
		this.#pending.delete(first.value[0]);
		return first.value;
	}

	#pendingOffered(signal: AbortSignal): Promise<void> {
		return new Promise((resolve) => {
			if (signal.aborted || this.#pending.size > 0) return resolve();
			this.#pendingWaiters.push(resolve);
			signal.addEventListener("abort", () => resolve(), { once: true });
		});
	}

	async #registerRuntime(signal: AbortSignal): Promise<void> {
		const backoff = new Backoff(1000, 30_000);
		while (!signal.aborted) {
			try {
				await this.#client.registerRuntime({ sdk: "@somework/sdk" });
				return;
			} catch (error) {
				const delay = backoff.nextDelayMs();
				this.#options.logger("warn", "runtime registration failed; retrying", { error: String(error), retryInMs: Math.round(delay) });
				await sleep(delay, signal);
			}
		}
	}

	#runtimeHeartbeats(signal: AbortSignal): { stop(): void } {
		const stop = new AbortController();
		const both = AbortSignal.any([signal, stop.signal]);
		void (async () => {
			while (!both.aborted) {
				await sleep(this.#options.runtimeHeartbeatSeconds * 1000, both);
				if (both.aborted) break;
				await this.#client.runtimeHeartbeat().catch((error) => this.#options.logger("warn", "runtime heartbeat failed", { error: String(error) }));
			}
		})();
		return { stop: () => stop.abort() };
	}

	#slotFree(signal: AbortSignal): Promise<void> {
		return new Promise((resolve) => {
			if (signal.aborted) return resolve();
			const done = () => resolve();
			this.#slotWaiters.push(done);
			signal.addEventListener("abort", done, { once: true });
		});
	}

	#wakeSlotWaiters(): void {
		const waiters = this.#slotWaiters;
		this.#slotWaiters = [];
		for (const wake of waiters) wake();
	}

	async #claimAndRun(taskId: string, offers: Wake[], shutdown: AbortSignal): Promise<void> {
		const log = this.#options.logger;
		let claim;
		try {
			claim = await this.#client.claimTask(taskId, this.#options.leaseSeconds);
		} catch (error) {
			if (CLAIM_NOT_NEEDED.has(code(error))) {
				await acknowledge(offers);
				return log("debug", "claim not needed", { taskId, code: code(error) });
			}
			// the offer stays unacknowledged and is looked at again after the cooldown; do not hammer
			this.#cooldownUntil = Date.now() + 1000;
			for (const offer of offers) this.#offer(offer);
			return log("warn", "claim failed transiently", { taskId, error: String(error) });
		}
		await acknowledge(offers);
		try {
			await this.#execute(claim, shutdown);
		} catch (error) {
			log("warn", "task execution ended without a committed outcome", { taskId, error: String(error) });
		}
	}

	async #execute(claim: any, shutdown: AbortSignal): Promise<void> {
		const { task, capability } = claim;
		const taskId: string = task.taskId;
		const fence: number = claim.fencingToken;
		const log = this.#options.logger;
		const abort = new AbortController();
		let reason: StopReason | undefined;
		const stop = (why: StopReason) => {
			reason ??= why;
			abort.abort(why);
		};
		const lease = this.#keepLease(taskId, fence, stop);
		const timeoutMs = typeof capability?.timeoutSeconds === "number" ? capability.timeoutSeconds * 1000 : undefined;
		const timer = timeoutMs === undefined ? undefined : setTimeout(() => stop("timeout"), timeoutMs);
		const onShutdown = () => stop("shutdown");
		if (shutdown.aborted) onShutdown();
		else shutdown.addEventListener("abort", onShutdown, { once: true });
		const progress = new ProgressPump(this.#client, taskId, fence, this.#options.progressThrottleMs, log);

		try {
			try {
				await this.#client.progressTask(taskId, { fencingToken: fence, status: "running", message: "started" });
			} catch (error) {
				if (LEASE_LOSS.has(code(error))) return log("warn", "lease lost before start", { taskId });
				throw error;
			}
			const control: JobControl = {
				signal: abort.signal,
				get stopReason() {
					return reason;
				},
				progress: (update) => progress.push(update),
				requestInput: (question) => this.#awaitInput(task, fence, question, abort.signal, () => reason),
			};
			const job: Job = { task, input: task.input, capability, fencingToken: fence, taskId, runtimeInstanceId: this.#client.runtimeInstanceId };
			let outcome: Outcome;
			try {
				outcome = await this.#options.handler(job, control);
			} catch (error) {
				outcome = { type: "failed", failure: { code: "handler_error", message: error instanceof Error ? error.message : String(error), retryable: false } };
			}
			await progress.flush();

			if (reason === "lease_lost" || lease.lost) return log("warn", "lease lost; discarding the handler's outcome", { taskId });
			if (reason === "timeout") {
				const failure = { code: "timeout", message: `the capability's timeout of ${capability.timeoutSeconds}s elapsed`, retryable: false };
				return await this.#commit(taskId, () => this.#client.failTask(taskId, fence, failure));
			}
			if (outcome.type === "completed") return await this.#commit(taskId, () => this.#client.completeTask(taskId, fence, outcome.result, outcome.artifacts ?? []));
			if (reason === "cancel_requested") return await this.#commit(taskId, () => this.#client.ackCancel(taskId, fence));
			if (outcome.type === "failed") return await this.#commit(taskId, () => this.#client.failTask(taskId, fence, outcome.failure));
			log("info", "handler detached; the lease will lapse and the task is re-queued", { taskId });
		} finally {
			lease.stop();
			if (timer) clearTimeout(timer);
			shutdown.removeEventListener("abort", onShutdown);
		}
	}

	/** Posts the question, then waits until the requester has answered (task back to `running`) and returns the new input. */
	async #awaitInput(task: any, fence: number, question: unknown, signal: AbortSignal, reason: () => StopReason | undefined): Promise<unknown> {
		const taskId: string = task.taskId;
		await this.#client.progressTask(taskId, { fencingToken: fence, status: "input_required", question, message: "waiting for input" });
		for (;;) {
			if (signal.aborted) throw new Error(`stopped while waiting for input: ${reason()}`);
			const current = await this.#client.getTask(taskId);
			if (TERMINAL_STATES.has(current.state)) throw new Error(`the task became ${current.state} while waiting for input`);
			if (current.state === "running") break;
			await sleep(200, signal);
		}
		let fresh: unknown;
		if (task.conversationId) {
			const page = await this.#client.conversationMessages(task.conversationId);
			for (const message of page.messages ?? []) {
				if (message.type === "task.input" && message.taskId === taskId && !this.#seenInputs.has(message.messageId)) {
					this.#seenInputs.add(message.messageId);
					fresh = message.content?.data?.data;
				}
			}
		}
		return fresh;
	}

	/** Commit one outcome; "no longer ours" answers are expected (the domain already decided) and are not errors. */
	async #commit(taskId: string, send: () => Promise<unknown>): Promise<void> {
		try {
			await send();
		} catch (error) {
			if (LEASE_LOSS.has(code(error))) return this.#options.logger("warn", "outcome not accepted: lease already lost", { taskId, code: code(error) });
			throw error;
		}
	}

	#keepLease(taskId: string, fence: number, stop: (why: StopReason) => void): { stop(): void; readonly lost: boolean } {
		const done = new AbortController();
		const state = { lost: false };
		const intervalMs = Math.max(100, this.#options.leaseSeconds * Math.min(0.9, Math.max(0.05, this.#options.heartbeatRatio)) * 1000);
		void (async () => {
			let lastOk = Date.now();
			while (!done.signal.aborted) {
				await sleep(intervalMs, done.signal);
				if (done.signal.aborted) break;
				try {
					const response = await this.#client.heartbeatTask(taskId, fence, this.#options.leaseSeconds);
					lastOk = Date.now();
					if (response?.cancelRequested === true) stop("cancel_requested");
				} catch (error) {
					if (LEASE_LOSS.has(code(error))) {
						this.#options.logger("warn", "lease lost", { taskId, code: code(error) });
						state.lost = true;
						stop("lease_lost");
						break;
					}
					this.#options.logger("warn", "heartbeat failed; will retry", { taskId, error: String(error) });
					if (Date.now() - lastOk >= this.#options.leaseSeconds * 1000) {
						state.lost = true;
						stop("lease_lost");
						break;
					}
				}
			}
		})();
		return {
			stop: () => done.abort(),
			get lost() {
				return state.lost;
			},
		};
	}
}

/** Coalesces progress updates into at most one durable checkpoint per throttle interval. */
class ProgressPump {
	#pending: ProgressUpdate | undefined;
	#lastSent = 0;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#inflight: Promise<void> = Promise.resolve();
	readonly #client: SomeWorkClient;
	readonly #taskId: string;
	readonly #fence: number;
	readonly #throttleMs: number;
	readonly #log: Logger;

	constructor(client: SomeWorkClient, taskId: string, fence: number, throttleMs: number, log: Logger) {
		this.#client = client;
		this.#taskId = taskId;
		this.#fence = fence;
		this.#throttleMs = throttleMs;
		this.#log = log;
	}

	push(update: ProgressUpdate): void {
		this.#pending = update;
		if (this.#timer) return;
		const wait = Math.max(0, this.#lastSent + this.#throttleMs - Date.now());
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			this.#inflight = this.#inflight.then(() => this.#send());
		}, wait);
	}

	async flush(): Promise<void> {
		if (this.#timer) {
			clearTimeout(this.#timer);
			this.#timer = undefined;
		}
		this.#inflight = this.#inflight.then(() => this.#send());
		await this.#inflight;
	}

	async #send(): Promise<void> {
		const update = this.#pending;
		if (!update) return;
		this.#pending = undefined;
		this.#lastSent = Date.now();
		try {
			await this.#client.progressTask(this.#taskId, { fencingToken: this.#fence, message: update.message, checkpoint: update.checkpoint, percent: update.percent });
		} catch (error) {
			this.#log("warn", "progress not recorded", { taskId: this.#taskId, error: String(error) });
		}
	}
}

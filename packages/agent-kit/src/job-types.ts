/** What a job is, as the role handler sees it: the pipeline in `handler.ts` takes a `Job` and a `JobControl` and returns exactly one `Outcome`. */

export interface Failure {
	code: string;
	message: string;
	retryable: boolean;
	details?: unknown;
}

/** Why a job is asked to stop. The handler decides what each means (e.g. abort vs. detach). */
export type StopReason = "cancel_requested" | "timeout" | "lease_lost" | "shutdown";

export type Outcome =
	| { type: "completed"; result: unknown; artifacts?: unknown[] }
	| { type: "failed"; failure: Failure }
	/** Report nothing and keep the work: the job stays open and is started again under the same id, so the run re-attaches. */
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
	/** Aborted when the job must stop; see `stopReason`. */
	readonly signal: AbortSignal;
	readonly stopReason: StopReason | undefined;
	progress(update: ProgressUpdate): void;
	/** Ask the approver a question and wait for the answer. Rejects with the stop reason if the job is stopped meanwhile. */
	requestInput(question: unknown): Promise<unknown>;
}

export type Handler = (job: Job, control: JobControl) => Promise<Outcome>;

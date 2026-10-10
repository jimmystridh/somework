import type { ProgressUpdate } from "./job-types.ts";
import type { ModelRef } from "./providers/allowlist.ts";

export interface Budget {
	/** Hard cap on model tokens for one job (input + output). A job without a budget is rejected before it starts. */
	maxTokens: number;
	maxMinutes: number;
}

export interface AgentRequest {
	/** Idempotency key of the job: a retry with the same id finds the same durable run. */
	requestId: string;
	/** Stable routing key: the same key continues the same conversation. */
	agentKey: string;
	instruction: string;
	/** Working directory inside the sandbox. */
	workspace: string;
	budget: Budget;
	/** Model for a new conversation; the runtime default when absent. A conversation keeps the model it started with. */
	model?: ModelRef;
	/**
	 * The tools this conversation is offered, by name, instead of the runtime's list: a call to any other tool is blocked. Fixed when the
	 * conversation is created. It can only narrow what the runtime has registered; an unknown name fails the request.
	 */
	tools?: readonly string[];
	/** Standing orders of this conversation instead of the runtime's. Fixed when the conversation is created. */
	instructions?: string;
	/** What the tools of this run may ask for while it goes (who is being answered, which conversation): see `AgentRuntime.contextOf`. Not stored. */
	context?: unknown;
}

export interface Usage {
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	costUsd: number;
}

export type StopReason = "cancel_requested" | "timeout" | "lease_lost" | "shutdown";

export type AgentOutcome =
	| { status: "done"; answer: string; usage: Usage }
	/** The run was stopped on purpose (requester cancel, timeout, budget). */
	| { status: "aborted"; reason: "cancel_requested" | "timeout" | "budget_exceeded"; usage: Usage }
	/** The model run ended without an answer (provider failure and the like). */
	| { status: "unanswered"; reason: string; usage: Usage }
	/** We stopped watching; the run keeps going (or resumes) and a retry re-attaches by `requestId`. */
	| { status: "detached" };

export interface ApprovalRequest {
	tool: string;
	summary: string;
}
export type ApprovalDecision = { approved: boolean; reason?: string };

export interface RunHooks {
	/** Aborts with the SDK's stop reason. */
	signal: AbortSignal;
	onProgress(update: ProgressUpdate): void;
	/** A tool call started (name only: for metrics). */
	onTool?(name: string): void;
	/** Asks the requester and resolves with the answer; rejects if the job stops meanwhile. */
	requestApproval(request: ApprovalRequest): Promise<ApprovalDecision>;
}

/** Everything outside `pi-runtime.ts` depends on this interface, not on Pi Durable (which is experimental). */
export interface AgentRuntime {
	start(): Promise<void>;
	execute(request: AgentRequest, hooks: RunHooks): Promise<AgentOutcome>;
	health(): { ready: boolean; reason?: string };
	close(): Promise<void>;
	/** The `context` of the run a tool call belongs to; `conversationId` is the one the tool's execution api carries. Undefined outside a run. */
	contextOf?(conversationId: number): unknown;
	/** Adds a message to a run that is going, read at its next turn boundary. False when no run with that request id is active. */
	steer?(requestId: string, text: string): Promise<boolean>;
}

export const emptyUsage = (): Usage => ({ inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 });

import type { ProgressUpdate } from "@somework/sdk";
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
}

export const emptyUsage = (): Usage => ({ inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 });

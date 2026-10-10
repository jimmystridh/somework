import { isJobRequest, silent, type AgentOutcome, type AgentRequest, type AgentRuntime, type Log, type RunHooks, type Usage } from "@somework/agent-kit";
import { repairInstruction } from "./prompt.ts";
import { parseReport, type QaReport } from "./result.ts";

/** What the verification's run came to, keyed by the request id, for the `result` hook to turn into the task result. */
export type ReportOutcome = { ok: true; report: QaReport; truncated: boolean; repaired: boolean } | { ok: false; reason: string; raw: string };

const add = (a: Usage, b: Usage): Usage => ({ inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens, totalTokens: a.totalTokens + b.totalTokens, costUsd: a.costUsd + b.costUsd });
/** A repair turn is only worth starting with some budget left for it. */
const MIN_REPAIR_TOKENS = 2_000;

/**
 * Wraps the agent runtime for QA: the model's final answer is parsed into the structured report; when it cannot be used there is exactly
 * one repair turn in the same conversation (with what is left of the budget, told not to run more checks or touch the ticket system), and
 * the usage of both turns is reported together. The parsed report is kept until the `result` hook takes it.
 */
export class QaRuntime implements AgentRuntime {
	readonly #inner: AgentRuntime;
	readonly #log: Log;
	readonly #outcomes = new Map<string, ReportOutcome>();

	constructor(inner: AgentRuntime, log: Log = silent) {
		this.#inner = inner;
		this.#log = log;
	}

	start(): Promise<void> {
		return this.#inner.start();
	}
	health(): { ready: boolean; reason?: string } {
		return this.#inner.health();
	}
	close(): Promise<void> {
		return this.#inner.close();
	}

	#keep(requestId: string, outcome: ReportOutcome): void {
		this.#outcomes.set(requestId, outcome);
		for (const oldest of this.#outcomes.keys()) {
			if (this.#outcomes.size <= 50) break;
			this.#outcomes.delete(oldest);
		}
	}

	/** The report that the run of `requestId` produced; each is handed out once. */
	take(requestId: string): ReportOutcome | undefined {
		const outcome = this.#outcomes.get(requestId);
		this.#outcomes.delete(requestId);
		return outcome;
	}

	async execute(request: AgentRequest, hooks: RunHooks): Promise<AgentOutcome> {
		if (!isJobRequest(request.requestId)) return this.#inner.execute(request, hooks);
		const first = await this.#inner.execute(request, hooks);
		if (first.status !== "done") return first;
		let parsed = parseReport(first.answer);
		if (parsed.ok) {
			this.#keep(request.requestId, { ok: true, report: parsed.report, truncated: parsed.truncated, repaired: false });
			return first;
		}
		this.#log("warn", "qa_report_invalid", { requestId: request.requestId, reason: parsed.reason });
		const left = request.budget.maxTokens - first.usage.totalTokens;
		if (left < MIN_REPAIR_TOKENS) {
			this.#keep(request.requestId, { ok: false, reason: `${parsed.reason} (no budget left for a repair turn)`, raw: first.answer });
			return first;
		}
		const second = await this.#inner.execute({ ...request, requestId: `${request.requestId}:repair`, instruction: repairInstruction(parsed.reason), budget: { maxTokens: left, maxMinutes: request.budget.maxMinutes } }, hooks);
		if (second.status !== "done") {
			this.#keep(request.requestId, { ok: false, reason: `${parsed.reason} (the repair turn did not finish)`, raw: first.answer });
			return second.status === "detached" ? second : { ...second, usage: add(first.usage, second.usage) };
		}
		const usage = add(first.usage, second.usage);
		parsed = parseReport(second.answer);
		this.#keep(request.requestId, parsed.ok ? { ok: true, report: parsed.report, truncated: parsed.truncated, repaired: true } : { ok: false, reason: `${parsed.reason} (after one repair turn)`, raw: second.answer });
		return { status: "done", answer: second.answer, usage };
	}
}

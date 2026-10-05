import { silent, type AgentOutcome, type AgentRequest, type AgentRuntime, type Log, type RunHooks, type Usage } from "@somework/agent-kit";
import { DENIED_REASON } from "./commands.ts";
import { repairInstruction } from "./prompt.ts";
import { parseReview, type Review } from "./result.ts";

/** What the reviewer's run came to, keyed by the request id, for the handler to turn into the task result. */
export type ReviewOutcome = { ok: true; review: Review; truncated: boolean; repaired: boolean } | { ok: false; reason: string; raw: string };

const add = (a: Usage, b: Usage): Usage => ({ inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens, totalTokens: a.totalTokens + b.totalTokens, costUsd: a.costUsd + b.costUsd });
/** A repair turn is only worth starting with some budget left for it. */
const MIN_REPAIR_TOKENS = 2_000;

/**
 * Wraps the agent runtime for the reviewer:
 * - an approval request that the read-only policy has already refused is answered "denied" here, so nobody is asked about a mutation;
 * - the model's final answer is parsed into the structured review; when it cannot be used there is exactly one repair turn in the same
 *   conversation (with what is left of the budget), and the usage of both turns is reported together.
 * The parsed review is kept in memory until the handler takes it; a retried job re-attaches to the finished run and parses again.
 */
export class ReviewRuntime implements AgentRuntime {
	readonly #inner: AgentRuntime;
	readonly #log: Log;
	readonly #outcomes = new Map<string, ReviewOutcome>();

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

	#keep(requestId: string, outcome: ReviewOutcome): void {
		this.#outcomes.set(requestId, outcome);
		// runs that never reach the handler (stopped, detached) leave an entry behind; keep the table small
		for (const oldest of this.#outcomes.keys()) {
			if (this.#outcomes.size <= 100) break;
			this.#outcomes.delete(oldest);
		}
	}

	/** The review that the run of `requestId` produced; each is handed out once. */
	take(requestId: string): ReviewOutcome | undefined {
		const outcome = this.#outcomes.get(requestId);
		this.#outcomes.delete(requestId);
		return outcome;
	}

	async execute(request: AgentRequest, hooks: RunHooks): Promise<AgentOutcome> {
		const guarded: RunHooks = {
			...hooks,
			requestApproval: async (approval) => (approval.summary.startsWith(DENIED_REASON) ? { approved: false, reason: "this agent is read-only: that command changes something" } : hooks.requestApproval(approval)),
		};
		const first = await this.#inner.execute(request, guarded);
		if (first.status !== "done") return first;

		let parsed = parseReview(first.answer);
		if (parsed.ok) {
			this.#keep(request.requestId, { ok: true, review: parsed.review, truncated: parsed.truncated, repaired: false });
			return first;
		}
		this.#log("warn", "review_output_invalid", { requestId: request.requestId, reason: parsed.reason });
		const left = request.budget.maxTokens - first.usage.totalTokens;
		if (left < MIN_REPAIR_TOKENS) {
			this.#keep(request.requestId, { ok: false, reason: `${parsed.reason} (no budget left for a repair turn)`, raw: first.answer });
			return first;
		}
		const second = await this.#inner.execute({ ...request, requestId: `${request.requestId}:repair`, instruction: repairInstruction(parsed.reason), budget: { maxTokens: left, maxMinutes: request.budget.maxMinutes } }, guarded);
		if (second.status !== "done") {
			// the repair did not finish: a stop or a detach decides the job, the first answer is kept as the evidence
			this.#keep(request.requestId, { ok: false, reason: `${parsed.reason} (the repair turn did not finish)`, raw: first.answer });
			return second.status === "detached" ? second : { ...second, usage: add(first.usage, second.usage) };
		}
		const usage = add(first.usage, second.usage);
		parsed = parseReview(second.answer);
		this.#keep(
			request.requestId,
			parsed.ok ? { ok: true, review: parsed.review, truncated: parsed.truncated, repaired: true } : { ok: false, reason: `${parsed.reason} (after one repair turn)`, raw: second.answer },
		);
		return { status: "done", answer: second.answer, usage };
	}
}

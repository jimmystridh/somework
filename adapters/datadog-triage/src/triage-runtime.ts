import { silent, type AgentOutcome, type AgentRequest, type AgentRuntime, type Log, type RunHooks, type Usage } from "@somework/agent-kit";
import { REFUSED } from "./commands.ts";
import type { IssuedRefs } from "./datadog/tools.ts";
import { repairInstruction } from "./prompt.ts";
import { evidenceProblems, extractJson, markUnverified, validateTriage, type Parsed, type TriageOutcome } from "./result.ts";

const add = (a: Usage, b: Usage): Usage => ({ inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens, totalTokens: a.totalTokens + b.totalTokens, costUsd: a.costUsd + b.costUsd });
/** A repair turn is only worth starting with some budget left for it. */
const MIN_REPAIR_TOKENS = 2_000;

export const NO_ONE_ANSWERS = "no person answers approval requests for this agent, so whatever needs one is refused. Use only the allowed commands on files in data/ and scratch/, or finish with what you have.";

/**
 * Wraps the agent runtime for the Datadog triage role:
 * - an approval request is refused (a triage is started by an event or an instruction and nobody answers for it; the command policy
 *   already tells the model why in the refusal);
 * - the model's final answer is parsed into the structured diagnosis and every finding is checked against the tool calls this service
 *   handed out; when something cannot be used there is exactly one repair turn in the same conversation (with what is left of the budget),
 *   and the usage of both turns is reported together. Findings that still cite nothing real are kept, labelled as inference.
 * The parsed result is kept in memory until the handler takes it.
 */
export class TriageRuntime implements AgentRuntime {
	readonly #inner: AgentRuntime;
	readonly #refs: Pick<IssuedRefs, "has">;
	readonly #log: Log;
	readonly #outcomes = new Map<string, TriageOutcome>();

	constructor(inner: AgentRuntime, refs: Pick<IssuedRefs, "has">, log: Log = silent) {
		this.#inner = inner;
		this.#refs = refs;
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

	#keep(requestId: string, outcome: TriageOutcome): void {
		this.#outcomes.set(requestId, outcome);
		for (const oldest of this.#outcomes.keys()) {
			if (this.#outcomes.size <= 100) break;
			this.#outcomes.delete(oldest);
		}
	}

	/** The diagnosis that the run of `requestId` produced; each is handed out once. */
	take(requestId: string): TriageOutcome | undefined {
		const outcome = this.#outcomes.get(requestId);
		this.#outcomes.delete(requestId);
		return outcome;
	}

	/** The shape problems, else the evidence problems, of an answer. */
	#judge(answer: string): { parsed: Parsed; problems: string[] } {
		const value = extractJson(answer);
		const parsed = value === undefined ? ({ ok: false, problems: ["the answer holds no json object: finish with one fenced json block"] } as const) : validateTriage(value);
		return { parsed, problems: parsed.ok ? evidenceProblems(parsed.triage, this.#refs) : parsed.problems };
	}

	async execute(request: AgentRequest, hooks: RunHooks): Promise<AgentOutcome> {
		const guarded: RunHooks = {
			...hooks,
			requestApproval: async (approval) => {
				this.#log("info", "triage_approval_refused", { requestId: request.requestId, tool: approval.tool, why: approval.summary.slice(0, 160) });
				return { approved: false, reason: approval.summary.startsWith(REFUSED) ? approval.summary.slice(0, 400) : `${approval.summary.slice(0, 200)}. ${NO_ONE_ANSWERS}` };
			},
		};
		const first = await this.#inner.execute(request, guarded);
		if (first.status !== "done") return first;

		const judged = this.#judge(first.answer);
		if (judged.problems.length === 0 && judged.parsed.ok) {
			this.#keep(request.requestId, { ok: true, triage: judged.parsed.triage, truncated: judged.parsed.truncated, repaired: false });
			return first;
		}
		this.#log("warn", "triage_output_invalid", { requestId: request.requestId, problems: judged.problems.length, structural: !judged.parsed.ok });
		const settle = (answer: string, problems: string[], parsed: Parsed, repaired: boolean, why: string) => {
			if (parsed.ok) this.#keep(request.requestId, { ok: true, triage: markUnverified(parsed.triage, this.#refs), truncated: parsed.truncated, repaired });
			else this.#keep(request.requestId, { ok: false, reason: `${problems.join("; ")}${why}`, raw: answer });
		};
		const left = request.budget.maxTokens - first.usage.totalTokens;
		if (left < MIN_REPAIR_TOKENS) {
			settle(first.answer, judged.problems, judged.parsed, false, " (no budget left for a repair turn)");
			return first;
		}
		const second = await this.#inner.execute({ ...request, requestId: `${request.requestId}:repair`, instruction: repairInstruction(judged.problems), budget: { maxTokens: left, maxMinutes: request.budget.maxMinutes } }, guarded);
		if (second.status !== "done") {
			// the repair did not finish: a stop or a detach decides the job, the first answer is what there is
			settle(first.answer, judged.problems, judged.parsed, false, " (the repair turn did not finish)");
			return second.status === "detached" ? second : { ...second, usage: add(first.usage, second.usage) };
		}
		const again = this.#judge(second.answer);
		settle(second.answer, again.problems, again.parsed, true, " (after one repair turn)");
		return { status: "done", answer: second.answer, usage: add(first.usage, second.usage) };
	}
}

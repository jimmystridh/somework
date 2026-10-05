export interface PolicyConfig {
	/** Capabilities that must carry a budget; absent budgets get the defaults, budgets above the ceiling are refused. */
	budgetedCapabilities: string[];
	defaultBudget: { maxTokens: number; maxMinutes: number };
	budgetCeiling: { maxTokens: number; maxMinutes: number };
	submissionsPerHour: number;
	messagesPerHour: number;
	approvalTtlMs: number;
}

export const defaultPolicy: PolicyConfig = {
	budgetedCapabilities: ["code.agent"],
	defaultBudget: { maxTokens: 200_000, maxMinutes: 20 },
	budgetCeiling: { maxTokens: 500_000, maxMinutes: 60 },
	submissionsPerHour: 20,
	messagesPerHour: 60,
	approvalTtlMs: 10 * 60_000,
};

/** A refusal that is the gateway's decision, not a failure: `status` is the HTTP answer the agent sees. */
export class PolicyError extends Error {
	override readonly name = "PolicyError";
	readonly status: number;
	readonly code: string;

	constructor(status: number, code: string, message: string) {
		super(message);
		this.status = status;
		this.code = code;
	}
}

/** Only effect levels known to be harmless run without the owner. Anything else, including a card that says nothing, waits for approval. */
export const runsWithoutApproval = (sideEffects: string | undefined): boolean => sideEffects === "none" || sideEffects === "read";

export function withBudget(capabilityId: string, input: Record<string, unknown>, policy: PolicyConfig): Record<string, unknown> {
	if (!policy.budgetedCapabilities.includes(capabilityId)) return input;
	const asked = (input.budget ?? {}) as { maxTokens?: unknown; maxMinutes?: unknown };
	const maxTokens = asked.maxTokens ?? policy.defaultBudget.maxTokens;
	const maxMinutes = asked.maxMinutes ?? policy.defaultBudget.maxMinutes;
	if (!Number.isFinite(maxTokens) || !Number.isFinite(maxMinutes) || (maxTokens as number) <= 0 || (maxMinutes as number) <= 0) {
		throw new PolicyError(400, "invalid_budget", "budget.maxTokens and budget.maxMinutes must be positive numbers");
	}
	if ((maxTokens as number) > policy.budgetCeiling.maxTokens || (maxMinutes as number) > policy.budgetCeiling.maxMinutes) {
		throw new PolicyError(422, "budget_above_ceiling", `budget above the ceiling of ${policy.budgetCeiling.maxTokens} tokens / ${policy.budgetCeiling.maxMinutes} minutes`);
	}
	return { ...input, budget: { maxTokens, maxMinutes } };
}

export class RateLimiter {
	readonly #limit: number;
	readonly #windowMs: number;
	readonly #now: () => number;
	#stamps: number[] = [];

	constructor(limit: number, windowMs = 3_600_000, now: () => number = Date.now) {
		this.#limit = limit;
		this.#windowMs = windowMs;
		this.#now = now;
	}

	/** Counts one use; false when the window is full. */
	take(): boolean {
		const now = this.#now();
		this.#stamps = this.#stamps.filter((at) => now - at < this.#windowMs);
		if (this.#stamps.length >= this.#limit) return false;
		this.#stamps.push(now);
		return true;
	}
}

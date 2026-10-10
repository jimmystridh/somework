export interface PolicyConfig {
	/** Messages the Manager may send to agents per hour. */
	messagesPerHour: number;
	/** How long a switch the model asked for waits for the owner's confirmation. */
	approvalTtlMs: number;
}

export const defaultPolicy: PolicyConfig = {
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

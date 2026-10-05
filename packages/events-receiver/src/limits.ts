export interface BucketConfig {
	ratePerSecond: number;
	burst: number;
}

/** A token bucket on an injectable clock. */
export class TokenBucket {
	readonly #config: BucketConfig;
	readonly #now: () => number;
	#tokens: number;
	#updated: number;

	constructor(config: BucketConfig, now: () => number) {
		this.#config = config;
		this.#now = now;
		this.#tokens = config.burst;
		this.#updated = now();
	}

	take(): boolean {
		const now = this.#now();
		this.#tokens = Math.min(this.#config.burst, this.#tokens + ((now - this.#updated) / 1000) * this.#config.ratePerSecond);
		this.#updated = now;
		if (this.#tokens < 1) return false;
		this.#tokens -= 1;
		return true;
	}
}

/** Counts bad credentials per client in a rolling minute so that guessing a token is slow, whoever sits behind the proxy. */
export class FailureLimiter {
	readonly #perMinute: number;
	readonly #now: () => number;
	readonly #failures = new Map<string, number[]>();

	constructor(perMinute: number, now: () => number) {
		this.#perMinute = perMinute;
		this.#now = now;
	}

	blocked(client: string): boolean {
		return this.#recent(client).length >= this.#perMinute;
	}

	record(client: string): void {
		const recent = this.#recent(client);
		recent.push(this.#now());
		this.#failures.set(client, recent);
		if (this.#failures.size > 10_000) this.#prune();
	}

	#recent(client: string): number[] {
		const cutoff = this.#now() - 60_000;
		return (this.#failures.get(client) ?? []).filter((at) => at > cutoff);
	}

	#prune(): void {
		for (const client of this.#failures.keys()) if (this.#recent(client).length === 0) this.#failures.delete(client);
	}
}

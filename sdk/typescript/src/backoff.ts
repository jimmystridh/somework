/** Bounded exponential backoff with jitter, so a recovering domain is not hit by every worker in lockstep. */
export class Backoff {
	private attempt = 0;
	private readonly baseMs: number;
	private readonly maxMs: number;

	constructor(baseMs: number, maxMs: number) {
		this.baseMs = baseMs;
		this.maxMs = maxMs;
	}

	/** Ceiling of the delay for the current attempt: `base * 2^attempt`, never above `max`. */
	ceilingMs(): number {
		return Math.min(this.maxMs, this.baseMs * 2 ** Math.min(this.attempt, 30));
	}

	/** A delay uniformly spread over the upper half of the ceiling; advances to the next attempt. */
	nextDelayMs(): number {
		const ceiling = this.ceilingMs();
		this.attempt += 1;
		return ceiling * (0.5 + Math.random() * 0.5);
	}

	reset(): void {
		this.attempt = 0;
	}
}

/** Spread a fixed interval by up to +-20% so periodic work of many workers does not align. */
export function jittered(intervalMs: number): number {
	return intervalMs * (0.8 + Math.random() * 0.4);
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) return resolve();
		const timer = setTimeout(done, ms);
		function done() {
			clearTimeout(timer);
			signal?.removeEventListener("abort", done);
			resolve();
		}
		signal?.addEventListener("abort", done, { once: true });
	});
}

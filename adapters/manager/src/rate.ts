/** A fixed window per key: the first `limit` items of a window pass, the rest are only counted so a summary can be sent when the window ends. */
export class WindowedLimiter {
	readonly #limit: number;
	readonly #windowMs: number;
	readonly #now: () => number;
	readonly #windows = new Map<string, { startedAt: number; passed: number; suppressed: number }>();

	constructor(limit: number, windowMs = 3_600_000, now: () => number = Date.now) {
		this.#limit = limit;
		this.#windowMs = windowMs;
		this.#now = now;
	}

	/** Counts one item for `key`. `carried` is how many items of the previous, finished window were suppressed and not yet reported. */
	take(key: string): { pass: boolean; carried: number } {
		const now = this.#now();
		let window = this.#windows.get(key);
		let carried = 0;
		if (window && now - window.startedAt >= this.#windowMs) {
			carried = window.suppressed;
			window = undefined;
		}
		window ??= { startedAt: now, passed: 0, suppressed: 0 };
		this.#windows.set(key, window);
		if (window.passed < this.#limit) {
			window.passed++;
			return { pass: true, carried };
		}
		window.suppressed++;
		return { pass: false, carried };
	}

	/** Suppressed counts of windows that have ended, each reported once. */
	finished(): { key: string; suppressed: number }[] {
		const now = this.#now();
		const out: { key: string; suppressed: number }[] = [];
		for (const [key, window] of this.#windows) {
			if (now - window.startedAt < this.#windowMs) continue;
			if (window.suppressed > 0) out.push({ key, suppressed: window.suppressed });
			this.#windows.delete(key);
		}
		return out;
	}
}

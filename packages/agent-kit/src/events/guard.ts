import { redactText } from "./redact.ts";
import type { HandlerStore } from "./store.ts";

export interface HandlerStats {
	runs: number;
	errors: number;
	consecutiveFailures: number;
	drops: number;
	wakes: number;
	lastError?: string;
	wakeTimes: number[];
}

export interface DroppedSample {
	at: string;
	handler: string;
	topic: string;
	key: string;
	reason: string;
}

export interface HandlerStatus {
	name: string;
	version: number;
	hash: string;
	enabled: boolean;
	runs: number;
	errors: number;
	drops: number;
	wakes: number;
	lastError?: string;
	disabledReason?: string;
}

const HOUR_MS = 3_600_000;
const MAX_SAMPLES = 20;

/**
 * Counters per handler and the rules that switch a handler off by itself: too many consecutive errors or timeouts, or too many wakes in
 * an hour. A switched-off handler stays off (in the control file, so it survives a restart) until an operator or the agent enables it.
 */
export class HandlerGuard {
	readonly #stats = new Map<string, HandlerStats>();
	readonly #samples: DroppedSample[] = [];
	readonly #store: HandlerStore;
	readonly #maxFailures: number;
	readonly #maxWakesPerHour: number;
	readonly #now: () => number;

	constructor(store: HandlerStore, options: { maxConsecutiveFailures: number; maxWakesPerHour: number; now?: () => number }) {
		this.#store = store;
		this.#maxFailures = options.maxConsecutiveFailures;
		this.#maxWakesPerHour = options.maxWakesPerHour;
		this.#now = options.now ?? Date.now;
	}

	#of(name: string): HandlerStats {
		let stats = this.#stats.get(name);
		if (!stats) this.#stats.set(name, (stats = { runs: 0, errors: 0, consecutiveFailures: 0, drops: 0, wakes: 0, wakeTimes: [] }));
		return stats;
	}

	success(name: string): void {
		const stats = this.#of(name);
		stats.runs += 1;
		stats.consecutiveFailures = 0;
	}

	/** Returns the reason when this failure switched the handler off. */
	failure(name: string, message: string): string | undefined {
		const stats = this.#of(name);
		stats.runs += 1;
		stats.errors += 1;
		stats.consecutiveFailures += 1;
		stats.lastError = redactText(message).slice(0, 300);
		if (stats.consecutiveFailures < this.#maxFailures) return undefined;
		const reason = `${stats.consecutiveFailures} errors or timeouts in a row; last: ${stats.lastError}`;
		this.#store.disable(name, reason, "auto");
		stats.consecutiveFailures = 0;
		return reason;
	}

	drop(name: string, sample: Omit<DroppedSample, "at" | "handler">): void {
		this.#of(name).drops += 1;
		this.#samples.push({ at: new Date(this.#now()).toISOString(), handler: name, ...sample });
		if (this.#samples.length > MAX_SAMPLES) this.#samples.shift();
	}

	/** Records a wake; returns the reason when it switched the handler off (more than the allowed wakes in the last hour). */
	wake(name: string): string | undefined {
		const stats = this.#of(name);
		const now = this.#now();
		stats.wakeTimes = stats.wakeTimes.filter((at) => now - at < HOUR_MS);
		stats.wakeTimes.push(now);
		stats.wakes += 1;
		if (stats.wakeTimes.length <= this.#maxWakesPerHour) return undefined;
		const reason = `more than ${this.#maxWakesPerHour} wakes in an hour`;
		this.#store.disable(name, reason, "auto");
		stats.wakeTimes = [];
		return reason;
	}

	samples(): DroppedSample[] {
		return [...this.#samples];
	}

	status(): HandlerStatus[] {
		return this.#store.list().map((info) => {
			const stats = this.#of(info.name);
			return {
				name: info.name,
				version: info.version,
				hash: info.hash.slice(0, 12),
				enabled: info.enabled,
				runs: stats.runs,
				errors: stats.errors,
				drops: stats.drops,
				wakes: stats.wakes,
				...(stats.lastError ? { lastError: stats.lastError } : {}),
				...(info.disabledReason ? { disabledReason: info.disabledReason } : {}),
			};
		});
	}
}

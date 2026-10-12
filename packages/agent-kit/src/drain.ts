import { statSync } from "node:fs";
import { join } from "node:path";
import { silent, type Log } from "./log.ts";
import type { Metrics } from "./metrics.ts";

export const DRAIN_FILE_NAME = "drain";

/** A drain file older than this is ignored: a deployment that died without removing it must not keep the agent from working for ever. */
export const DRAIN_MAX_AGE_MS = 3 * 3_600_000;

/** Where the drain flag of an agent is: a file of this name in its state directory. */
export const drainFileIn = (stateDir: string): string => join(stateDir, DRAIN_FILE_NAME);

/** What a start of new work is refused with while the agent drains. */
export class DrainingError extends Error {
	constructor() {
		super("this agent is draining for a deployment: it accepts no new jobs until the deployment is done");
		this.name = "DrainingError";
	}
}

export interface DrainOptions {
	file: string;
	metrics: Metrics;
	log?: Log;
	/** How long after its last change the file still counts (default `DRAIN_MAX_AGE_MS`). */
	maxAgeMs?: number;
}

/**
 * The drain flag of a deployment: while the file exists the agent starts no new jobs and handles no event that would start work, but keeps
 * answering chat, keeps reporting ready, and lets the jobs it runs finish. Whoever deploys creates the file, waits until no job runs, and removes it
 * when it is done, or the agent ignores it after `DRAIN_MAX_AGE_MS`. The file is looked at whenever the flag is asked, so a decision never works from
 * stale state; the watcher only keeps the `somework_draining` metric and the log current.
 */
export class Drain {
	readonly #file: string;
	readonly #log: Log;
	readonly #gauge: { set(value: number): void };
	readonly #maxAgeMs: number;
	#last: boolean | undefined;
	#expiredLogged = false;

	constructor(options: DrainOptions) {
		this.#file = options.file;
		this.#log = options.log ?? silent;
		this.#maxAgeMs = options.maxAgeMs ?? DRAIN_MAX_AGE_MS;
		const gauge = options.metrics.gauge("somework_draining", "1 while the agent drains (starts no new jobs) for a deployment, otherwise 0");
		this.#gauge = { set: (value) => gauge.set(value) };
		this.#observe(this.#read());
	}

	get active(): boolean {
		const on = this.#read();
		this.#observe(on);
		return on;
	}

	/** Keeps the metric and the log in step with the file until `signal` aborts. */
	watch(signal: AbortSignal, everyMs = 2000): void {
		const timer = setInterval(() => void this.active, everyMs);
		timer.unref();
		signal.addEventListener("abort", () => clearInterval(timer), { once: true });
	}

	#read(): boolean {
		let ageMs: number;
		try {
			ageMs = Date.now() - statSync(this.#file).mtimeMs;
		} catch {
			this.#expiredLogged = false;
			return false;
		}
		if (ageMs <= this.#maxAgeMs) {
			this.#expiredLogged = false;
			return true;
		}
		if (!this.#expiredLogged) this.#log("warn", "drain_expired", { file: this.#file, ageMinutes: Math.round(ageMs / 60_000) });
		this.#expiredLogged = true;
		return false;
	}

	#observe(on: boolean): void {
		if (on === this.#last) return;
		const first = this.#last === undefined;
		this.#last = on;
		this.#gauge.set(on ? 1 : 0);
		if (on) this.#log("info", "drain_started", { file: this.#file, atStart: first });
		else if (!first) this.#log("info", "drain_ended", {});
	}
}

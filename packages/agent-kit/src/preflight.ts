import type { Log } from "./log.ts";
import type { Metrics } from "./metrics.ts";
import { redactLog } from "./windows/redact.ts";

/** One thing the agent needs in order to do its work well, and whether it has it (a credential's permission, a system that answers). */
export interface PreflightCheck {
	/** Stable and short: it is the `check` label of `somework_preflight_ok` and the key of the state change that is logged. */
	name: string;
	ok: boolean;
	/** Why it failed, in words an operator can act on. Never a secret; the kit scrubs the secrets it knows of all the same. */
	detail?: string;
	severity: "error" | "warning";
	/** A failed `error` check makes `/ready` answer 503. Default false: the agent keeps running, and the failure is shown, counted and logged. */
	blocking?: boolean;
}

export interface PreflightContext {
	log: Log;
	/** Aborted when this run takes longer than the limit. */
	signal: AbortSignal;
}

export interface PreflightResult extends PreflightCheck {
	checkedAt: string;
}

export interface PreflightOptions {
	checks: (context: PreflightContext) => Promise<PreflightCheck[]>;
	log: Log;
	metrics: Metrics;
	/** Literal secrets the service holds; they are removed from every detail. */
	secrets?: readonly string[];
	/** Time between runs; unset or 0 runs once, at start. */
	everyMs?: number;
	/** The longest one run may take (default 30 s). */
	timeoutMs?: number;
	now?: () => Date;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_NAME = 80;
const MAX_DETAIL = 300;
const SYNTHETIC = "preflight";

/**
 * Runs a role's preflight checks at start and every `everyMs`. The latest results are kept for `/ready` and `/profile`, every check is a
 * gauge (`somework_preflight_ok{check}`, 1 or 0), and a check that turns bad is logged once as `preflight_failed` (warn): a run that finds
 * the same failure again says nothing, one that finds it gone logs `preflight_recovered`.
 */
export class Preflight {
	readonly #options: PreflightOptions;
	readonly #gauge: { set(value: number, labels?: Record<string, string>): void };
	#results = new Map<string, PreflightResult>();
	#running: Promise<void> | undefined;

	constructor(options: PreflightOptions) {
		this.#options = options;
		this.#gauge = options.metrics.gauge("somework_preflight_ok", "1 when the agent's preflight check passes, 0 when it fails, by check");
	}

	results(): PreflightResult[] {
		return [...this.#results.values()];
	}

	/** The failed checks that keep the agent from being ready. */
	blocking(): string[] {
		return this.results().filter((result) => !result.ok && result.severity === "error" && result.blocking === true).map((result) => result.name);
	}

	/** Runs the checks now; a run that is still going is joined instead of started again. Never rejects. */
	run(): Promise<void> {
		this.#running ??= this.#execute().finally(() => {
			this.#running = undefined;
		});
		return this.#running;
	}

	start(signal: AbortSignal): void {
		void this.run();
		const everyMs = this.#options.everyMs ?? 0;
		if (!(everyMs > 0)) return;
		const timer = setInterval(() => void this.run(), everyMs);
		signal.addEventListener("abort", () => clearInterval(timer), { once: true });
	}

	#scrub(text: string): string {
		return redactLog(text, this.#options.secrets ?? []).slice(0, MAX_DETAIL);
	}

	async #collect(): Promise<PreflightCheck[]> {
		const limit = new AbortController();
		let timer: NodeJS.Timeout | undefined;
		const expired = new Promise<never>((_, reject) => {
			timer = setTimeout(() => {
				limit.abort();
				reject(new Error("it took too long"));
			}, this.#options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
		});
		try {
			const checks = await Promise.race([this.#options.checks({ log: this.#options.log, signal: limit.signal }), expired]);
			return Array.isArray(checks) ? checks : [];
		} catch (error) {
			return [{ name: SYNTHETIC, ok: false, severity: "warning", detail: `the checks could not run: ${error instanceof Error ? error.message : String(error)}` }];
		} finally {
			clearTimeout(timer);
		}
	}

	async #execute(): Promise<void> {
		const checks = await this.#collect();
		const checkedAt = (this.#options.now?.() ?? new Date()).toISOString();
		const previous = this.#results;
		const current = new Map<string, PreflightResult>();
		for (const check of checks) {
			const name = String(check.name).slice(0, MAX_NAME);
			const severity = check.severity === "error" ? "error" : "warning";
			const detail = check.detail ? this.#scrub(check.detail) : undefined;
			const result: PreflightResult = { name, ok: check.ok === true, severity, ...(check.blocking === true && severity === "error" ? { blocking: true } : {}), ...(detail ? { detail } : {}), checkedAt };
			current.set(name, result);
			this.#gauge.set(result.ok ? 1 : 0, { check: name });
			const before = previous.get(name);
			if (!result.ok && (before === undefined || before.ok)) this.#options.log("warn", "preflight_failed", { check: name, severity, blocking: result.blocking === true, ...(detail ? { detail } : {}) });
			if (result.ok && before !== undefined && !before.ok) this.#options.log("info", "preflight_recovered", { check: name });
		}
		for (const [name, before] of previous) {
			if (current.has(name) || before.ok) continue;
			this.#gauge.set(1, { check: name });
			this.#options.log("info", "preflight_recovered", { check: name });
		}
		this.#results = current;
	}
}

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface TriageRecord {
	monitorId: string;
	/** `diagnosed`, `inconclusive`, `noise`, `skipped` or `failed:<code>`. */
	outcome: string;
	at: string;
	severity?: string;
	tokens?: number;
}

interface Stored {
	monitors: Record<string, { at: string; taskId: string }[]>;
	days: Record<string, string[]>;
	outcomes: Record<string, TriageRecord>;
}

export type Begin = { ok: true } | { ok: false; reason: string };

export interface TriageLimits {
	cooldownMinutes: number;
	dailyCap: number;
}

const MAX_OUTCOMES = 200;
const MAX_STARTS_PER_MONITOR = 20;
const KEEP_DAYS = 7;

/**
 * What this agent has already triaged, kept on the service host where the model's tools cannot reach it. The handler in the sandbox keeps a
 * similar store as an early filter; this one is the authority: per monitor a cool-down between triages, per day a bounded number of
 * triages. Counting a task twice is impossible: its id is recorded with the start.
 */
export class TriageLedger {
	readonly #file: string;
	readonly #limits: TriageLimits;
	readonly #now: () => Date;

	constructor(file: string, limits: TriageLimits, now: () => Date = () => new Date()) {
		this.#file = file;
		this.#limits = limits;
		this.#now = now;
		mkdirSync(dirname(file), { recursive: true });
	}

	#read(): Stored {
		if (!existsSync(this.#file)) return { monitors: {}, days: {}, outcomes: {} };
		try {
			const stored = JSON.parse(readFileSync(this.#file, "utf8")) as Partial<Stored>;
			return { monitors: stored.monitors ?? {}, days: stored.days ?? {}, outcomes: stored.outcomes ?? {} };
		} catch {
			return { monitors: {}, days: {}, outcomes: {} };
		}
	}

	#write(stored: Stored): void {
		writeFileSync(`${this.#file}.tmp`, JSON.stringify(stored));
		renameSync(`${this.#file}.tmp`, this.#file);
	}

	/** Records a triage of the monitor unless a limit says no. Safe to call again for the same task. */
	begin(monitorId: string, taskId: string): Begin {
		const stored = this.#read();
		const now = this.#now();
		const day = now.toISOString().slice(0, 10);
		const starts = (stored.monitors[monitorId] ??= []);
		if (starts.some((start) => start.taskId === taskId)) return { ok: true };
		const last = starts.at(-1);
		if (last && now.getTime() - Date.parse(last.at) < this.#limits.cooldownMinutes * 60_000) return { ok: false, reason: `monitor ${monitorId} was triaged less than ${this.#limits.cooldownMinutes} minutes ago` };
		const today = (stored.days[day] ??= []);
		if (today.length >= this.#limits.dailyCap) return { ok: false, reason: `the daily cap of ${this.#limits.dailyCap} triages is reached` };
		starts.push({ at: now.toISOString(), taskId });
		if (starts.length > MAX_STARTS_PER_MONITOR) starts.splice(0, starts.length - MAX_STARTS_PER_MONITOR);
		today.push(taskId);
		for (const old of Object.keys(stored.days)) if (Date.parse(`${old}T00:00:00Z`) < now.getTime() - KEEP_DAYS * 86_400_000) delete stored.days[old];
		this.#write(stored);
		return { ok: true };
	}

	/** Notes how a task ended, once (the first record of a task wins), for the chat's account of what the agent did. */
	recordOutcome(taskId: string, record: Omit<TriageRecord, "at">): void {
		const stored = this.#read();
		if (stored.outcomes[taskId]) return;
		stored.outcomes[taskId] = { ...record, at: this.#now().toISOString() };
		const oldest = Object.entries(stored.outcomes).sort(([, a], [, b]) => a.at.localeCompare(b.at));
		if (oldest.length > MAX_OUTCOMES) for (const [key] of oldest.slice(0, oldest.length - MAX_OUTCOMES)) delete stored.outcomes[key];
		this.#write(stored);
	}

	/** What the chat may state: the limits, today's count, and the recent triages with how they ended. */
	facts(limit = 10): { dailyCap: number; cooldownMinutes: number; today: number; recent: (TriageRecord & { taskId: string })[] } {
		const stored = this.#read();
		const today = this.#now().toISOString().slice(0, 10);
		const recent = Object.entries(stored.outcomes)
			.sort(([, a], [, b]) => b.at.localeCompare(a.at))
			.slice(0, limit)
			.map(([taskId, record]) => ({ taskId, ...record }));
		return { dailyCap: this.#limits.dailyCap, cooldownMinutes: this.#limits.cooldownMinutes, today: stored.days[today]?.length ?? 0, recent };
	}
}

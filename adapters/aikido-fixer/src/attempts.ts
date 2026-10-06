import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

interface Stored {
	issues: Record<string, { attempts: { taskId: string; at: string }[] }>;
	days: Record<string, string[]>;
	branches: Record<string, { name: string; at: string }>;
}

export type Begin = { ok: true } | { ok: false; reason: string };

export interface AttemptLimits {
	maxAttemptsPerIssue: number;
	cooldownMinutes: number;
	dailyCap: number;
}

const MAX_BRANCHES = 500;
const KEEP_DAYS = 7;

/**
 * What this agent has already tried, kept on the service host where the model's tools cannot reach it. The handler in the sandbox keeps a
 * similar store as an early filter; this one is the authority: per issue a bounded number of attempts with a cool-down between them, per
 * day a bounded number of fix tasks, and the branch name a task chose (so a retry after the base moved finds its own branch). Counting a
 * task twice is impossible: its id is recorded with the attempt.
 */
export class AttemptLedger {
	readonly #file: string;
	readonly #limits: AttemptLimits;
	readonly #now: () => Date;

	constructor(file: string, limits: AttemptLimits, now: () => Date = () => new Date()) {
		this.#file = file;
		this.#limits = limits;
		this.#now = now;
		mkdirSync(dirname(file), { recursive: true });
	}

	#read(): Stored {
		if (!existsSync(this.#file)) return { issues: {}, days: {}, branches: {} };
		try {
			const stored = JSON.parse(readFileSync(this.#file, "utf8")) as Partial<Stored>;
			return { issues: stored.issues ?? {}, days: stored.days ?? {}, branches: stored.branches ?? {} };
		} catch {
			return { issues: {}, days: {}, branches: {} };
		}
	}

	#write(stored: Stored): void {
		writeFileSync(`${this.#file}.tmp`, JSON.stringify(stored));
		renameSync(`${this.#file}.tmp`, this.#file);
	}

	/** Records a fix attempt for the issue unless a limit says no. Safe to call again for the same task. */
	begin(groupId: string, taskId: string): Begin {
		const stored = this.#read();
		const now = this.#now();
		const day = now.toISOString().slice(0, 10);
		const issue = (stored.issues[groupId] ??= { attempts: [] });
		if (issue.attempts.some((attempt) => attempt.taskId === taskId)) return { ok: true };
		if (issue.attempts.length >= this.#limits.maxAttemptsPerIssue) return { ok: false, reason: `this issue was already attempted ${issue.attempts.length} time(s) (the limit is ${this.#limits.maxAttemptsPerIssue}): a person has to look at it` };
		const last = issue.attempts.at(-1);
		if (last && now.getTime() - Date.parse(last.at) < this.#limits.cooldownMinutes * 60_000) return { ok: false, reason: `an attempt on this issue started less than ${this.#limits.cooldownMinutes} minutes ago` };
		const today = (stored.days[day] ??= []);
		if (today.length >= this.#limits.dailyCap) return { ok: false, reason: `the daily cap of ${this.#limits.dailyCap} fix attempts is reached` };
		issue.attempts.push({ taskId, at: now.toISOString() });
		today.push(taskId);
		for (const old of Object.keys(stored.days)) if (Date.parse(`${old}T00:00:00Z`) < now.getTime() - KEEP_DAYS * 86_400_000) delete stored.days[old];
		this.#write(stored);
		return { ok: true };
	}

	/** The branch a task uses: the first name it was given, forever, so a retry never opens a second branch. */
	branchFor(taskId: string, choose: () => string): string {
		const stored = this.#read();
		const known = stored.branches[taskId];
		if (known) return known.name;
		const name = choose();
		stored.branches[taskId] = { name, at: this.#now().toISOString() };
		const keys = Object.keys(stored.branches);
		if (keys.length > MAX_BRANCHES) for (const key of keys.slice(0, keys.length - MAX_BRANCHES)) delete stored.branches[key];
		this.#write(stored);
		return name;
	}
}

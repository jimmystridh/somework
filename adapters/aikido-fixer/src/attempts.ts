import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface AttemptOutcome {
	groupId: string;
	/** `pr_opened`, `no_fix`, `skipped`, `blocked` or `failed:<code>`. */
	outcome: string;
	at: string;
	branch?: string;
	prUrl?: string;
	tokens?: number;
	/** Seeded from a file of earlier attempts (`AIKIDO_LEDGER_IMPORT`), not recorded by this build. */
	imported?: true;
}

/** One row of the file `AIKIDO_LEDGER_IMPORT` points at. */
export interface PastAttempt {
	issueId: number | string;
	outcome: string;
	at: string;
	branch?: string;
	prUrl?: string;
	tokens?: number;
}

export interface ImportResult {
	imported: number;
	alreadyThere: number;
	invalid: number;
}

const OUTCOMES = /^(pr_opened|no_fix|skipped|blocked|failed:[a-z_]{1,40})$/;

function pastAttempt(row: unknown): (AttemptOutcome & { key: string }) | undefined {
	const r = row as Partial<PastAttempt> | null;
	if (!r || typeof r !== "object") return undefined;
	const id = typeof r.issueId === "number" ? String(r.issueId) : typeof r.issueId === "string" ? r.issueId.trim() : "";
	if (!/^[0-9]{1,12}$/.test(id) || typeof r.outcome !== "string" || !OUTCOMES.test(r.outcome)) return undefined;
	if (typeof r.at !== "string" || Number.isNaN(Date.parse(r.at))) return undefined;
	if (r.branch !== undefined && (typeof r.branch !== "string" || r.branch.length > 200 || /\s/.test(r.branch))) return undefined;
	if (r.prUrl !== undefined && (typeof r.prUrl !== "string" || r.prUrl.length > 300 || !/^https:\/\/[^\s]+$/.test(r.prUrl))) return undefined;
	if (r.tokens !== undefined && !(typeof r.tokens === "number" && Number.isFinite(r.tokens) && r.tokens >= 0)) return undefined;
	const at = new Date(r.at).toISOString();
	return { key: `import:${id}:${at}`, groupId: id, outcome: r.outcome, at, ...(r.branch ? { branch: r.branch } : {}), ...(r.prUrl ? { prUrl: r.prUrl } : {}), ...(r.tokens !== undefined ? { tokens: r.tokens } : {}), imported: true };
}

interface Stored {
	issues: Record<string, { attempts: { taskId: string; at: string }[] }>;
	days: Record<string, string[]>;
	branches: Record<string, { name: string; at: string }>;
	outcomes: Record<string, AttemptOutcome>;
	/** Fix attempts the owner added to a day's cap, by day. */
	raised?: Record<string, number>;
}

export type Begin = { ok: true } | { ok: false; reason: string };

export interface AttemptLimits {
	maxAttemptsPerIssue: number;
	cooldownMinutes: number;
	dailyCap: number;
}

const MAX_BRANCHES = 500;
const MAX_OUTCOMES = 200;
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
		if (!existsSync(this.#file)) return { issues: {}, days: {}, branches: {}, outcomes: {} };
		try {
			const stored = JSON.parse(readFileSync(this.#file, "utf8")) as Partial<Stored>;
			return { issues: stored.issues ?? {}, days: stored.days ?? {}, branches: stored.branches ?? {}, outcomes: stored.outcomes ?? {}, raised: stored.raised ?? {} };
		} catch {
			return { issues: {}, days: {}, branches: {}, outcomes: {} };
		}
	}

	#write(stored: Stored): void {
		writeFileSync(`${this.#file}.tmp`, JSON.stringify(stored));
		renameSync(`${this.#file}.tmp`, this.#file);
	}

	/** Records a fix attempt for the issue unless a limit says no. Safe to call again for the same task. */
	/** What `begin` would answer, without recording anything: lets a job that will be skipped anyway be skipped before it costs requests. */
	wouldBegin(groupId: string, taskId: string): Begin {
		return this.#check(this.#read(), groupId, taskId);
	}

	#check(stored: ReturnType<AttemptLedger["#read"]>, groupId: string, taskId: string): Begin {
		const now = this.#now();
		const day = now.toISOString().slice(0, 10);
		const issue = stored.issues[groupId] ?? { attempts: [] };
		if (issue.attempts.some((attempt) => attempt.taskId === taskId)) return { ok: true };
		if (issue.attempts.length >= this.#limits.maxAttemptsPerIssue) return { ok: false, reason: `this issue was already attempted ${issue.attempts.length} time(s) (the limit is ${this.#limits.maxAttemptsPerIssue}): a person has to look at it` };
		const last = issue.attempts.at(-1);
		if (last && now.getTime() - Date.parse(last.at) < this.#limits.cooldownMinutes * 60_000) return { ok: false, reason: `an attempt on this issue started less than ${this.#limits.cooldownMinutes} minutes ago` };
		const cap = this.#limits.dailyCap + (stored.raised?.[day] ?? 0);
		if ((stored.days[day] ?? []).length >= cap) return { ok: false, reason: `the daily cap of ${cap} fix attempts is reached` };
		return { ok: true };
	}

	begin(groupId: string, taskId: string): Begin {
		const stored = this.#read();
		const answer = this.#check(stored, groupId, taskId);
		if (!answer.ok) return answer;
		const issue = (stored.issues[groupId] ??= { attempts: [] });
		if (issue.attempts.some((attempt) => attempt.taskId === taskId)) return { ok: true };
		const now = this.#now();
		const day = now.toISOString().slice(0, 10);
		const today = (stored.days[day] ??= []);
		issue.attempts.push({ taskId, at: now.toISOString() });
		today.push(taskId);
		for (const old of Object.keys(stored.days)) if (Date.parse(`${old}T00:00:00Z`) < now.getTime() - KEEP_DAYS * 86_400_000) delete stored.days[old];
		for (const old of Object.keys(stored.raised ?? {})) if (Date.parse(`${old}T00:00:00Z`) < now.getTime() - KEEP_DAYS * 86_400_000) delete stored.raised![old];
		this.#write(stored);
		return { ok: true };
	}

	/** The Aikido issue and branch of a pull request this agent opened and recorded, or undefined for any other. */
	pullRequestOf(prUrl: string): { groupId: string; branch: string; prUrl: string } | undefined {
		const wanted = prUrl.toLowerCase();
		const entries = Object.values(this.#read().outcomes)
			.filter((outcome) => outcome.outcome === "pr_opened" && outcome.prUrl?.toLowerCase() === wanted && outcome.branch)
			.sort((a, b) => b.at.localeCompare(a.at));
		return entries[0] ? { groupId: entries[0].groupId, branch: entries[0].branch!, prUrl: entries[0].prUrl! } : undefined;
	}

	/** Notes how a task ended, once (the first record of a task wins), for the chat's account of what the agent did. */
	recordOutcome(taskId: string, outcome: Omit<AttemptOutcome, "at">): void {
		const stored = this.#read();
		if (stored.outcomes[taskId]) return;
		stored.outcomes[taskId] = { ...outcome, at: this.#now().toISOString() };
		this.#pruneOutcomes(stored);
		this.#write(stored);
	}

	#pruneOutcomes(stored: Stored): void {
		const oldest = Object.entries(stored.outcomes).sort(([, a], [, b]) => a.at.localeCompare(b.at));
		if (oldest.length > MAX_OUTCOMES) for (const [key] of oldest.slice(0, oldest.length - MAX_OUTCOMES)) delete stored.outcomes[key];
	}

	/**
	 * Seeds the account of past attempts from a JSON file: an array of `{issueId, outcome, at, branch?, prUrl?, tokens?}` (or `{attempts: [...]}`).
	 * Idempotent: a row is identified by its issue and time, so importing the same file, or an overlapping one, again adds nothing. Imported rows
	 * only fill in the chat's account; they do not count against the daily cap, the per-issue attempt limit or the cool-down. A row that is not
	 * valid is skipped and counted. A file that cannot be read or is not a list is an error (it is a startup setting: a typo should be loud).
	 */
	importHistory(file: string): ImportResult {
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(file, "utf8"));
		} catch (error) {
			throw new Error(`AIKIDO_LEDGER_IMPORT ${file} cannot be read as JSON: ${error instanceof Error ? error.message : String(error)}`);
		}
		const rows = Array.isArray(parsed) ? parsed : Array.isArray((parsed as { attempts?: unknown })?.attempts) ? (parsed as { attempts: unknown[] }).attempts : undefined;
		if (!rows) throw new Error(`AIKIDO_LEDGER_IMPORT ${file} must hold a list of attempts`);
		const stored = this.#read();
		const result: ImportResult = { imported: 0, alreadyThere: 0, invalid: 0 };
		for (const row of rows) {
			const attempt = pastAttempt(row);
			if (!attempt) {
				result.invalid += 1;
				continue;
			}
			const { key, ...outcome } = attempt;
			if (stored.outcomes[key]) {
				result.alreadyThere += 1;
				continue;
			}
			stored.outcomes[key] = outcome;
			result.imported += 1;
		}
		if (result.imported > 0) {
			this.#pruneOutcomes(stored);
			this.#write(stored);
		}
		return result;
	}

	/**
	 * Adds `extra` fix attempts to today's cap, at most `maxRaise` over all raises of the day (the handler's own flood guard sits above that), and goes
	 * back to the normal cap tomorrow. Throws a `RangeError` the chat can show when the request is not allowed.
	 */
	raiseDailyCap(extra: number, maxRaise: number): { raisedToday: number; cap: number } {
		if (!Number.isInteger(extra) || extra < 1) throw new RangeError("the number of extra fix attempts must be a whole number of at least 1");
		const stored = this.#read();
		const day = this.#now().toISOString().slice(0, 10);
		const raisedToday = (stored.raised?.[day] ?? 0) + extra;
		if (raisedToday > maxRaise) throw new RangeError(`today's cap can be raised by at most ${maxRaise} fix attempts in all (${stored.raised?.[day] ?? 0} already)`);
		(stored.raised ??= {})[day] = raisedToday;
		this.#write(stored);
		return { raisedToday, cap: this.#limits.dailyCap + raisedToday };
	}

	/** What the chat may state: the limits, today's count, and the recent attempts per issue with how they ended. */
	facts(limit = 10): { dailyCap: number; raisedToday: number; maxAttemptsPerIssue: number; cooldownMinutes: number; today: number; recent: (AttemptOutcome & { taskId: string; attempts: number })[] } {
		const stored = this.#read();
		const today = this.#now().toISOString().slice(0, 10);
		const recent = Object.entries(stored.outcomes)
			.sort(([, a], [, b]) => b.at.localeCompare(a.at))
			.slice(0, limit)
			.map(([taskId, outcome]) => ({ taskId, ...outcome, attempts: stored.issues[outcome.groupId]?.attempts.length ?? 0 }));
		const raisedToday = stored.raised?.[today] ?? 0;
		return { dailyCap: this.#limits.dailyCap + raisedToday, raisedToday, maxAttemptsPerIssue: this.#limits.maxAttemptsPerIssue, cooldownMinutes: this.#limits.cooldownMinutes, today: stored.days[today]?.length ?? 0, recent };
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

import { DatabaseSync } from "node:sqlite";
import type { RawItem } from "./types.ts";

export interface DeadLetter {
	id: string;
	source: string;
	receivedAt: string;
	headers: Record<string, string>;
	body: Buffer;
	kind: string;
	error: string;
	attempts: number;
	createdAt: number;
	replayedAt: number | null;
	path: string;
	query: string;
}

interface DeadRow {
	id: string;
	source: string;
	received_at: string;
	headers: string;
	body: Uint8Array;
	kind: string;
	error: string;
	attempts: number;
	created_at: number;
	replayed_at: number | null;
	path: string;
	query: string;
}

const toDead = (row: DeadRow): DeadLetter => ({ id: row.id, source: row.source, receivedAt: row.received_at, headers: JSON.parse(row.headers), body: Buffer.from(row.body), kind: row.kind, error: row.error, attempts: row.attempts, createdAt: row.created_at, replayedAt: row.replayed_at, path: row.path, query: row.query });

export interface TimerRow {
	id: string;
	agent: string;
	key: string;
	dueAt: number;
	note: string;
	payload: string | null;
	createdAt: number;
	firedAt: number | null;
}

interface TimerDbRow {
	id: string;
	agent: string;
	key: string;
	due_at: number;
	note: string;
	payload: string | null;
	created_at: number;
	fired_at: number | null;
}

export interface WatchRow {
	id: string;
	agent: string;
	/** The topic slug of the agent, kept to refuse two agent ids that would share one watch topic. */
	slug: string;
	/** Lower-cased `owner/name`. */
	repository: string;
	number: number;
	headSha: string | null;
	createdAt: number;
	/** The last time the agent renewed the watch or an event was delivered through it. */
	activeAt: number;
	/** Set while the pull request is closed without a merge. */
	closedAt: number | null;
	endedAt: number | null;
	endReason: string | null;
}

interface WatchDbRow {
	id: string;
	agent: string;
	slug: string;
	repository: string;
	number: number;
	head_sha: string | null;
	created_at: number;
	active_at: number;
	closed_at: number | null;
	ended_at: number | null;
	end_reason: string | null;
}

const toWatch = (row: WatchDbRow): WatchRow => ({ id: row.id, agent: row.agent, slug: row.slug, repository: row.repository, number: row.number, headSha: row.head_sha, createdAt: row.created_at, activeAt: row.active_at, closedAt: row.closed_at, endedAt: row.ended_at, endReason: row.end_reason });

const toTimer = (row: TimerDbRow): TimerRow => ({ id: row.id, agent: row.agent, key: row.key, dueAt: row.due_at, note: row.note, payload: row.payload, createdAt: row.created_at, firedAt: row.fired_at });

/** The hub's own durable state: pull cursor, dead letters, the inbox of the internal listener, clock progress and source switches. */
export class Store {
	readonly #db: DatabaseSync;
	readonly #now: () => number;

	constructor(path: string, now: () => number = Date.now) {
		this.#now = now;
		this.#db = new DatabaseSync(path);
		this.#db.exec(`
			PRAGMA journal_mode = WAL;
			PRAGMA synchronous = FULL;
			PRAGMA busy_timeout = 5000;
			CREATE TABLE IF NOT EXISTS kv (name TEXT PRIMARY KEY, value TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS dead_letters (
				id TEXT PRIMARY KEY, source TEXT NOT NULL, received_at TEXT NOT NULL, headers TEXT NOT NULL, body BLOB NOT NULL,
				kind TEXT NOT NULL, error TEXT NOT NULL, attempts INTEGER NOT NULL, created_at INTEGER NOT NULL, replayed_at INTEGER,
				path TEXT NOT NULL DEFAULT '', query TEXT NOT NULL DEFAULT ''
			);
			CREATE TABLE IF NOT EXISTS inbox (
				seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, source TEXT NOT NULL, received_at TEXT NOT NULL, headers TEXT NOT NULL, body BLOB NOT NULL,
				path TEXT NOT NULL DEFAULT '', query TEXT NOT NULL DEFAULT ''
			);
			CREATE TABLE IF NOT EXISTS clock_state (name TEXT PRIMARY KEY, last_scheduled INTEGER NOT NULL);
			CREATE TABLE IF NOT EXISTS paused_sources (name TEXT PRIMARY KEY);
			CREATE TABLE IF NOT EXISTS timers (
				id TEXT PRIMARY KEY, agent TEXT NOT NULL, key TEXT NOT NULL, due_at INTEGER NOT NULL, note TEXT NOT NULL, payload TEXT,
				created_at INTEGER NOT NULL, fired_at INTEGER, UNIQUE (agent, key)
			);
			CREATE TABLE IF NOT EXISTS watches (
				id TEXT PRIMARY KEY, agent TEXT NOT NULL, slug TEXT NOT NULL, repository TEXT NOT NULL, number INTEGER NOT NULL, head_sha TEXT,
				created_at INTEGER NOT NULL, active_at INTEGER NOT NULL, closed_at INTEGER, ended_at INTEGER, end_reason TEXT,
				UNIQUE (agent, repository, number)
			);
			CREATE INDEX IF NOT EXISTS watches_by_pull_request ON watches (repository, number);
		`);
		for (const table of ["dead_letters", "inbox"]) {
			const columns = (this.#db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
			for (const column of ["path", "query"]) if (!columns.includes(column)) this.#db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT NOT NULL DEFAULT ''`);
		}
	}

	// ---- timers -------------------------------------------------------------------------------------------------------------------
	/** Stores a timer; a timer of the same agent and key, pending or already fired, is replaced. Returns false when the agent has too many others pending. */
	putTimer(timer: Omit<TimerRow, "firedAt">, maxPending: number): boolean {
		this.#db.exec("BEGIN IMMEDIATE");
		try {
			this.#db.prepare("DELETE FROM timers WHERE agent = ? AND key = ?").run(timer.agent, timer.key);
			const pending = (this.#db.prepare("SELECT COUNT(*) AS n FROM timers WHERE agent = ? AND fired_at IS NULL").get(timer.agent) as { n: number }).n;
			if (pending >= maxPending) {
				this.#db.exec("ROLLBACK");
				return false;
			}
			this.#db.prepare("INSERT INTO timers(id, agent, key, due_at, note, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(timer.id, timer.agent, timer.key, timer.dueAt, timer.note, timer.payload, timer.createdAt);
			this.#db.exec("COMMIT");
			return true;
		} catch (error) {
			this.#db.exec("ROLLBACK");
			throw error;
		}
	}

	dueTimers(now: number, limit: number): TimerRow[] {
		return (this.#db.prepare("SELECT * FROM timers WHERE fired_at IS NULL AND due_at <= ? ORDER BY due_at LIMIT ?").all(now, limit) as unknown as TimerDbRow[]).map(toTimer);
	}

	markTimerFired(id: string, at: number): void {
		this.#db.prepare("UPDATE timers SET fired_at = ? WHERE id = ?").run(at, id);
	}

	pendingTimers(agent: string): TimerRow[] {
		return (this.#db.prepare("SELECT * FROM timers WHERE agent = ? AND fired_at IS NULL ORDER BY due_at").all(agent) as unknown as TimerDbRow[]).map(toTimer);
	}

	pendingTimerCount(): number {
		return (this.#db.prepare("SELECT COUNT(*) AS n FROM timers WHERE fired_at IS NULL").get() as { n: number }).n;
	}

	/** Cancels a pending timer by id or key of that agent; true when one was removed. */
	cancelTimer(agent: string, idOrKey: string): boolean {
		return Number(this.#db.prepare("DELETE FROM timers WHERE agent = ? AND fired_at IS NULL AND (id = ? OR key = ?)").run(agent, idOrKey, idOrKey).changes) > 0;
	}

	pruneTimers(firedBefore: number): void {
		this.#db.prepare("DELETE FROM timers WHERE fired_at IS NOT NULL AND fired_at < ?").run(firedBefore);
	}

	// ---- watches ------------------------------------------------------------------------------------------------------------------
	/** Adds a watch, or renews the agent's watch of the same pull request (an ended one comes back to life, keeping its id). Returns undefined when the agent holds too many others. */
	putWatch(watch: Pick<WatchRow, "id" | "agent" | "slug" | "repository" | "number">, now: number, maxActive: number): { row: WatchRow; created: boolean } | undefined {
		this.#db.exec("BEGIN IMMEDIATE");
		try {
			const existing = this.#db.prepare("SELECT * FROM watches WHERE agent = ? AND repository = ? AND number = ?").get(watch.agent, watch.repository, watch.number) as unknown as WatchDbRow | undefined;
			if (existing) {
				const active = existing.ended_at === null;
				if (!active && this.activeWatchCount(watch.agent) >= maxActive) {
					this.#db.exec("ROLLBACK");
					return undefined;
				}
				this.#db.prepare("UPDATE watches SET active_at = ?, ended_at = NULL, end_reason = NULL, closed_at = CASE WHEN ended_at IS NULL THEN closed_at ELSE NULL END WHERE id = ?").run(now, existing.id);
			} else {
				if (this.activeWatchCount(watch.agent) >= maxActive) {
					this.#db.exec("ROLLBACK");
					return undefined;
				}
				this.#db.prepare("INSERT INTO watches(id, agent, slug, repository, number, created_at, active_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(watch.id, watch.agent, watch.slug, watch.repository, watch.number, now, now);
			}
			const row = toWatch(this.#db.prepare("SELECT * FROM watches WHERE agent = ? AND repository = ? AND number = ?").get(watch.agent, watch.repository, watch.number) as unknown as WatchDbRow);
			this.#db.exec("COMMIT");
			return { row, created: !existing };
		} catch (error) {
			this.#db.exec("ROLLBACK");
			throw error;
		}
	}

	activeWatchCount(agent?: string): number {
		const sql = "SELECT COUNT(*) AS n FROM watches WHERE ended_at IS NULL" + (agent === undefined ? "" : " AND agent = ?");
		return (this.#db.prepare(sql).get(...(agent === undefined ? [] : [agent])) as { n: number }).n;
	}

	/** Another agent id that maps to the same watch topic as this one, if any holds a watch. */
	slugOwner(slug: string, notAgent: string): string | undefined {
		return (this.#db.prepare("SELECT agent FROM watches WHERE slug = ? AND agent <> ? LIMIT 1").get(slug, notAgent) as { agent: string } | undefined)?.agent;
	}

	watchesOf(agent: string): WatchRow[] {
		return (this.#db.prepare("SELECT * FROM watches WHERE agent = ? ORDER BY created_at, rowid").all(agent) as unknown as WatchDbRow[]).map(toWatch);
	}

	activeWatchesOfPullRequest(repository: string, number: number): WatchRow[] {
		return (this.#db.prepare("SELECT * FROM watches WHERE repository = ? AND number = ? AND ended_at IS NULL ORDER BY id").all(repository, number) as unknown as WatchDbRow[]).map(toWatch);
	}

	activeWatchesOfCommit(repository: string, headSha: string): WatchRow[] {
		return (this.#db.prepare("SELECT * FROM watches WHERE repository = ? AND head_sha = ? AND ended_at IS NULL ORDER BY id").all(repository, headSha) as unknown as WatchDbRow[]).map(toWatch);
	}

	touchWatch(id: string, now: number, change: { headSha?: string; closedAt?: number | null }): void {
		this.#db.prepare("UPDATE watches SET active_at = ?, head_sha = COALESCE(?, head_sha), closed_at = CASE WHEN ? THEN ? ELSE closed_at END WHERE id = ? AND ended_at IS NULL").run(now, change.headSha ?? null, change.closedAt === undefined ? 0 : 1, change.closedAt ?? null, id);
	}

	endWatch(id: string, now: number, reason: string): void {
		this.#db.prepare("UPDATE watches SET ended_at = ?, end_reason = ? WHERE id = ? AND ended_at IS NULL").run(now, reason, id);
	}

	/** Ends the agent's active watch by id or by `owner/name#number`; true when one was active. */
	cancelWatch(agent: string, idOrRef: string, now: number): boolean {
		return Number(this.#db.prepare("UPDATE watches SET ended_at = ?, end_reason = 'cancelled' WHERE agent = ? AND ended_at IS NULL AND (id = ? OR repository || '#' || number = lower(?))").run(now, agent, idOrRef, idOrRef).changes) > 0;
	}

	/** Ends the watches nobody renewed or heard from since `inactiveBefore`, and those of pull requests closed since `closedBefore`; returns how many. */
	expireWatches(now: number, inactiveBefore: number, closedBefore: number): number {
		const closed = Number(this.#db.prepare("UPDATE watches SET ended_at = ?, end_reason = 'closed' WHERE ended_at IS NULL AND closed_at IS NOT NULL AND closed_at < ?").run(now, closedBefore).changes);
		const idle = Number(this.#db.prepare("UPDATE watches SET ended_at = ?, end_reason = 'expired' WHERE ended_at IS NULL AND active_at < ?").run(now, inactiveBefore).changes);
		return closed + idle;
	}

	pruneWatches(endedBefore: number): void {
		this.#db.prepare("DELETE FROM watches WHERE ended_at IS NOT NULL AND ended_at < ?").run(endedBefore);
	}

	#get(name: string): string | undefined {
		return (this.#db.prepare("SELECT value FROM kv WHERE name = ?").get(name) as { value: string } | undefined)?.value;
	}

	#set(name: string, value: string): void {
		this.#db.prepare("INSERT INTO kv(name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value").run(name, value);
	}

	cursor(): number {
		return Number(this.#get("cursor") ?? 0);
	}

	setCursor(seq: number): void {
		this.#set("cursor", String(seq));
	}

	addDeadLetter(item: RawItem, kind: string, error: string, attempts: number): void {
		this.#db
			.prepare("INSERT OR IGNORE INTO dead_letters(id, source, received_at, headers, body, kind, error, attempts, created_at, path, query) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
			.run(item.id, item.source, item.receivedAt, JSON.stringify(item.headers), item.body, kind, error.slice(0, 500), attempts, this.#now(), item.path, item.query);
	}

	deadLetters(options: { pending?: boolean } = {}): DeadLetter[] {
		const sql = options.pending ? "SELECT * FROM dead_letters WHERE replayed_at IS NULL ORDER BY created_at" : "SELECT * FROM dead_letters ORDER BY created_at";
		return (this.#db.prepare(sql).all() as unknown as DeadRow[]).map(toDead);
	}

	deadLetter(id: string): DeadLetter | undefined {
		const row = this.#db.prepare("SELECT * FROM dead_letters WHERE id = ?").get(id) as DeadRow | undefined;
		return row ? toDead(row) : undefined;
	}

	markReplayed(id: string): void {
		this.#db.prepare("UPDATE dead_letters SET replayed_at = ? WHERE id = ?").run(this.#now(), id);
	}

	deleteDeadLetter(id: string): boolean {
		return Number(this.#db.prepare("DELETE FROM dead_letters WHERE id = ?").run(id).changes) > 0;
	}

	deadLetterCounts(): Record<string, number> {
		const rows = this.#db.prepare("SELECT source, COUNT(*) AS n FROM dead_letters WHERE replayed_at IS NULL GROUP BY source").all() as { source: string; n: number }[];
		return Object.fromEntries(rows.map((row) => [row.source, row.n]));
	}

	purgeDeadLetters(retentionMs: number): number {
		return Number(this.#db.prepare("DELETE FROM dead_letters WHERE created_at < ?").run(this.#now() - retentionMs).changes);
	}

	enqueueInbox(item: RawItem): number {
		const result = this.#db.prepare("INSERT INTO inbox(id, source, received_at, headers, body, path, query) VALUES (?, ?, ?, ?, ?, ?, ?)").run(item.id, item.source, item.receivedAt, JSON.stringify(item.headers), item.body, item.path, item.query);
		return Number(result.lastInsertRowid);
	}

	inbox(limit: number): { seq: number; item: RawItem }[] {
		const rows = this.#db.prepare("SELECT seq, id, source, received_at, headers, body, path, query FROM inbox ORDER BY seq LIMIT ?").all(limit) as unknown as (DeadRow & { seq: number })[];
		return rows.map((row) => ({ seq: row.seq, item: { id: row.id, source: row.source, receivedAt: row.received_at, headers: JSON.parse(row.headers), body: Buffer.from(row.body), path: row.path, query: row.query } }));
	}

	inboxDone(seq: number): void {
		this.#db.prepare("DELETE FROM inbox WHERE seq = ?").run(seq);
	}

	inboxSize(): number {
		return Number((this.#db.prepare("SELECT COUNT(*) AS n FROM inbox").get() as { n: number }).n);
	}

	clockLast(name: string): number | undefined {
		return (this.#db.prepare("SELECT last_scheduled FROM clock_state WHERE name = ?").get(name) as { last_scheduled: number } | undefined)?.last_scheduled;
	}

	setClockLast(name: string, scheduled: number): void {
		this.#db.prepare("INSERT INTO clock_state(name, last_scheduled) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET last_scheduled = excluded.last_scheduled").run(name, scheduled);
	}

	isPaused(source: string): boolean {
		return this.#db.prepare("SELECT 1 FROM paused_sources WHERE name = ?").get(source) !== undefined;
	}

	setPaused(source: string, paused: boolean): void {
		if (paused) this.#db.prepare("INSERT OR IGNORE INTO paused_sources(name) VALUES (?)").run(source);
		else this.#db.prepare("DELETE FROM paused_sources WHERE name = ?").run(source);
	}

	close(): void {
		this.#db.close();
	}
}

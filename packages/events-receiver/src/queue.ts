import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export interface QueuedItem {
	seq: number;
	id: string;
	source: string;
	receivedAt: number;
	headers: Record<string, string>;
	body: Buffer;
	path: string;
	query: string;
}

export interface QueueStats {
	queued: number;
	bytes: number;
	lastSeq: number;
	oldestReceivedAt: number | null;
}

interface Row {
	seq: number;
	id: string;
	source: string;
	received_at: number;
	headers: string;
	body: Uint8Array;
	path: string;
	query: string;
}

const toItem = (row: Row): QueuedItem => ({ seq: row.seq, id: row.id, source: row.source, receivedAt: row.received_at, headers: JSON.parse(row.headers), body: Buffer.from(row.body), path: row.path, query: row.query });

/**
 * The durable buffer. SQLite with a full fsync per accepted webhook: a 202 is only sent after the row is on disk, so a restart loses nothing that
 * was acknowledged to the sender. Sequence numbers are never reused (AUTOINCREMENT), which makes the hub's `after` cursor safe across purges.
 */
export class Queue {
	readonly #db: DatabaseSync;
	readonly #now: () => number;
	#waiters = new Set<() => void>();

	constructor(path: string, now: () => number = Date.now) {
		this.#now = now;
		this.#db = new DatabaseSync(path);
		this.#db.exec(`
			PRAGMA journal_mode = WAL;
			PRAGMA synchronous = FULL;
			PRAGMA busy_timeout = 5000;
			CREATE TABLE IF NOT EXISTS items (
				seq INTEGER PRIMARY KEY AUTOINCREMENT,
				id TEXT NOT NULL UNIQUE,
				source TEXT NOT NULL,
				received_at INTEGER NOT NULL,
				headers TEXT NOT NULL,
				body BLOB NOT NULL,
				path TEXT NOT NULL DEFAULT '',
				query TEXT NOT NULL DEFAULT ''
			);
			CREATE TABLE IF NOT EXISTS source_state (name TEXT PRIMARY KEY, paused INTEGER NOT NULL);
		`);
		const columns = (this.#db.prepare("PRAGMA table_info(items)").all() as { name: string }[]).map((column) => column.name);
		for (const column of ["path", "query"]) if (!columns.includes(column)) this.#db.exec(`ALTER TABLE items ADD COLUMN ${column} TEXT NOT NULL DEFAULT ''`);
	}

	enqueue(source: string, headers: Record<string, string>, body: Uint8Array, path = "", query = ""): { seq: number; id: string } {
		const id = randomUUID();
		const result = this.#db.prepare("INSERT INTO items(id, source, received_at, headers, body, path, query) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, source, this.#now(), JSON.stringify(headers), body, path, query);
		for (const wake of this.#waiters) wake();
		return { seq: Number(result.lastInsertRowid), id };
	}

	/** Items after `after`, oldest first, stopping at `limit` items or `maxBytes` of bodies (at least one item is always returned). */
	pull(after: number, limit: number, maxBytes: number): QueuedItem[] {
		const rows = this.#db.prepare("SELECT seq, id, source, received_at, headers, body, path, query FROM items WHERE seq > ? ORDER BY seq ASC LIMIT ?").all(after, limit) as unknown as Row[];
		const items: QueuedItem[] = [];
		let bytes = 0;
		for (const row of rows) {
			if (items.length > 0 && bytes + row.body.byteLength > maxBytes) break;
			bytes += row.body.byteLength;
			items.push(toItem(row));
		}
		return items;
	}

	/** Resolves when an item newer than `after` exists, the wait is over, or the signal aborts. */
	async waitFor(after: number, waitMs: number, signal?: AbortSignal): Promise<void> {
		if (waitMs <= 0 || this.hasAfter(after)) return;
		await new Promise<void>((resolve) => {
			const finish = () => {
				clearTimeout(timer);
				this.#waiters.delete(check);
				signal?.removeEventListener("abort", finish);
				resolve();
			};
			const check = () => {
				if (this.hasAfter(after)) finish();
			};
			const timer = setTimeout(finish, waitMs);
			this.#waiters.add(check);
			signal?.addEventListener("abort", finish, { once: true });
		});
	}

	hasAfter(after: number): boolean {
		return this.#db.prepare("SELECT 1 FROM items WHERE seq > ? LIMIT 1").get(after) !== undefined;
	}

	ack(upTo: number): number {
		return Number(this.#db.prepare("DELETE FROM items WHERE seq <= ?").run(upTo).changes);
	}

	purge(retentionMs: number): number {
		return Number(this.#db.prepare("DELETE FROM items WHERE received_at < ?").run(this.#now() - retentionMs).changes);
	}

	stats(): QueueStats {
		const row = this.#db.prepare("SELECT COUNT(*) AS queued, COALESCE(SUM(LENGTH(body)), 0) AS bytes, MIN(received_at) AS oldest FROM items").get() as { queued: number; bytes: number; oldest: number | null };
		const sequence = this.#db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'items'").get() as { seq: number } | undefined;
		return { queued: row.queued, bytes: row.bytes, lastSeq: sequence?.seq ?? 0, oldestReceivedAt: row.oldest };
	}

	isPaused(source: string): boolean {
		const row = this.#db.prepare("SELECT paused FROM source_state WHERE name = ?").get(source) as { paused: number } | undefined;
		return row?.paused === 1;
	}

	setPaused(source: string, paused: boolean): void {
		this.#db.prepare("INSERT INTO source_state(name, paused) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET paused = excluded.paused").run(source, paused ? 1 : 0);
	}

	close(): void {
		for (const wake of this.#waiters) wake();
		this.#db.close();
	}
}

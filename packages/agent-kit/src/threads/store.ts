import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** A small table kept in one JSON file, written whole through a temporary file so a crash never leaves half of it. Volumes here are tens of rows. */
export class DurableTable<T extends { id: string }> {
	readonly #file: string;
	readonly #rows = new Map<string, T>();
	/** False when there was no file: this table is new. */
	readonly existed: boolean;

	constructor(file: string) {
		this.#file = file;
		mkdirSync(dirname(file), { recursive: true });
		this.existed = existsSync(file);
		try {
			const stored = JSON.parse(readFileSync(file, "utf8"));
			for (const row of Array.isArray(stored) ? stored : []) if (row && typeof row.id === "string") this.#rows.set(row.id, row as T);
		} catch {
			// no file yet, or one that cannot be read: start empty
		}
		if (!this.existed) this.#flush();
	}

	get(id: string): T | undefined {
		return this.#rows.get(id);
	}

	all(): T[] {
		return [...this.#rows.values()];
	}

	put(row: T): void {
		this.#rows.set(row.id, row);
		this.#flush();
	}

	remove(id: string): void {
		if (this.#rows.delete(id)) this.#flush();
	}

	#flush(): void {
		writeFileSync(`${this.#file}.tmp`, JSON.stringify([...this.#rows.values()]));
		renameSync(`${this.#file}.tmp`, this.#file);
	}
}

export interface InboxItem {
	/** The message id. */
	id: string;
	conversationId?: string;
	sender: { kind: string; id: string };
	/** When the message was sent (the domain's time), ISO; shown to the agent as the message's age. */
	sentAt?: string;
	/** When this agent read it, ms since the epoch. */
	receivedAt: number;
	status: "received" | "running" | "done";
	/** How often a run for it was started: more than one means a restart took the earlier try. */
	attempts: number;
	/** Set when the message was found waiting after a start (a backlog), not read live. */
	recovered?: boolean;
	/** The suffix of the conversation key the first run of this message used (see `Setup.conversationSuffix`), so a run taken up again after a restart finds its conversation. */
	setup?: string;
}

const KEEP_DONE = 2000;

/**
 * The agent's durable inbox: every message it read, kept until handled. A message is written here before its wake is acknowledged, so after
 * a restart nothing that was delivered is lost, and the message id makes handling idempotent: a second wake for the same id adds nothing.
 */
export class DurableInbox {
	readonly #table: DurableTable<InboxItem>;
	readonly #now: () => number;

	constructor(file: string, now: () => number = Date.now) {
		this.#table = new DurableTable(file);
		this.#now = now;
	}

	/** True when this inbox was started empty, for the first time: whatever the domain holds for the agent then is history, not a backlog. */
	get fresh(): boolean {
		return !this.#table.existed;
	}

	has(id: string): boolean {
		return this.#table.get(id) !== undefined;
	}

	/** Adds a message; false when it is already known (delivered twice). */
	add(item: Omit<InboxItem, "status" | "attempts" | "receivedAt"> & { receivedAt?: number }): boolean {
		if (this.has(item.id)) return false;
		this.#table.put({ ...item, receivedAt: item.receivedAt ?? this.#now(), status: "received", attempts: 0 });
		return true;
	}

	get(id: string): InboxItem | undefined {
		return this.#table.get(id);
	}

	/** `setup` is remembered from the first start: a later start of the same message keeps it. */
	start(id: string, setup?: string): void {
		const item = this.#table.get(id);
		if (item) this.#table.put({ ...item, status: "running", attempts: item.attempts + 1, ...(item.setup === undefined && setup !== undefined ? { setup } : {}) });
	}

	/** Puts a message back as not handled: the run for it was interrupted (shutdown) and the next start takes it up again. */
	release(id: string): void {
		const item = this.#table.get(id);
		if (item && item.status === "running") this.#table.put({ ...item, status: "received" });
	}

	finish(id: string): void {
		const item = this.#table.get(id);
		if (!item) return;
		this.#table.put({ ...item, status: "done" });
		const done = this.#table.all().filter((row) => row.status === "done").sort((a, b) => a.receivedAt - b.receivedAt);
		for (const old of done.slice(0, Math.max(0, done.length - KEEP_DONE))) this.#table.remove(old.id);
	}

	/** Messages not handled yet (new, or taken by a run that a restart interrupted), oldest first. */
	unfinished(): InboxItem[] {
		return this.#table.all().filter((row) => row.status !== "done").sort((a, b) => (a.sentAt ?? "").localeCompare(b.sentAt ?? "") || a.receivedAt - b.receivedAt);
	}

	markRecovered(id: string): void {
		const item = this.#table.get(id);
		if (item) this.#table.put({ ...item, recovered: true });
	}
}

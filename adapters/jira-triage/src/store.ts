import { join } from "node:path";
import { DurableTable } from "@somework/agent-kit";
import type { Fingerprint } from "./snapshot.ts";

export type Phase = "queued" | "awaiting_developer" | "awaiting_reporter" | "done" | "gave_up";

export type Origin = "event" | "manual" | "slack";

export interface Reply {
	id: string;
	via: "slack" | "jira";
	at: string;
	text: string;
}

/** Jira writes decided but not yet made. Each is idempotent, so a flush that fails half way is simply made again. */
export interface Outbox {
	labels?: { add: string[]; remove: string[] };
	notes?: { title: string; text: string }[];
	/** Fills the environment field when it is still empty. */
	environment?: string;
	comments?: { token: string; body: string }[];
}

export interface TicketRecord {
	id: string;
	phase: Phase;
	origin: Origin;
	createdAt: number;
	updatedAt: number;
	/** Failed passes in a row and when the next one is due (Jira down, a write refused). */
	attempts: number;
	nextAttemptAt?: number;
	lastError?: string;
	/** How many rounds of questions the reporter was asked. */
	rounds: number;
	reporter?: { name: string; displayName?: string; slackUserId?: string; slackChannel?: string };
	developer?: { conversationId: string; messageId: string; sentAt: string; deadline: number; status: "waiting" | "answered" | "timed_out" | "unavailable"; findings?: Record<string, string> };
	asked?: { round: number; via: "slack" | "jira"; at: number; ts?: string; token?: string; items: string[]; deadline: number };
	replies: Reply[];
	baseline?: Fingerprint;
	/** Ids of the comments the bot wrote, so that a comment event of its own is never taken for an answer. */
	botComments: string[];
	/** Labels the bot added, the only ones it may take away again. */
	addedLabels: string[];
	pending?: Outbox;
	summary?: string;
	lastPollAt?: number;
	doneAt?: number;
	/** Who asked for the ticket in Slack, for a ticket the bot created. */
	createdFor?: string;
	/** The ticket is judged again on purpose (a person asked, or changed it), so the marker label does not exempt it. */
	retriage?: boolean;
	/** The ticket is in its quiet time: `nextAttemptAt` is when it is first looked at, and an edit pushes it back. */
	quiet?: boolean;
	/** A change by a person was reported and is still to be compared with what the bot last saw. */
	recheck?: boolean;
}

const KEEP_DONE = 500;

/** The triage queue: one row per ticket, written whole to a file in the state directory so that a restart loses nothing. */
export class TriageStore {
	readonly #table: DurableTable<TicketRecord>;
	readonly #seen: DurableTable<{ id: string; n: number }>;
	#next: number;

	constructor(dir: string) {
		this.#table = new DurableTable<TicketRecord>(join(dir, "tickets.json"));
		this.#seen = new DurableTable<{ id: string; n: number }>(join(dir, "events-seen.json"));
		this.#next = Math.max(0, ...this.#seen.all().map((row) => row.n)) + 1;
	}

	get(key: string): TicketRecord | undefined {
		return this.#table.get(key);
	}

	put(record: TicketRecord, now: number): TicketRecord {
		const saved = { ...record, updatedAt: now };
		this.#table.put(saved);
		return saved;
	}

	all(): TicketRecord[] {
		return this.#table.all();
	}

	/** Records that need attention at `now`: a retry that is due, and the ones waiting for somebody, which are looked at on every pass. */
	open(): TicketRecord[] {
		return this.#table.all().filter((record) => record.phase !== "done" && record.phase !== "gave_up");
	}

	/** True the first time an event key is offered, false for a repeat (the hub and the domain deliver at least once). */
	claimEvent(key: string): boolean {
		if (this.#seen.get(key)) return false;
		this.#seen.put({ id: key, n: this.#next++ });
		const rows = this.#seen.all().sort((a, b) => a.n - b.n);
		for (const old of rows.slice(0, Math.max(0, rows.length - 5000))) this.#seen.remove(old.id);
		return true;
	}

	releaseEvent(key: string): void {
		this.#seen.remove(key);
	}

	/** Keeps the table small: the oldest finished rows go. */
	prune(): void {
		const done = this.#table.all().filter((record) => record.phase === "done" || record.phase === "gave_up").sort((a, b) => (a.doneAt ?? a.updatedAt) - (b.doneAt ?? b.updatedAt));
		for (const old of done.slice(0, Math.max(0, done.length - KEEP_DONE))) this.#table.remove(old.id);
	}

	counts(): Record<Phase, number> {
		const counts: Record<Phase, number> = { queued: 0, awaiting_developer: 0, awaiting_reporter: 0, done: 0, gave_up: 0 };
		for (const record of this.#table.all()) counts[record.phase] += 1;
		return counts;
	}
}

export const newRecord = (key: string, origin: Origin, now: number): TicketRecord => ({ id: key, phase: "queued", origin, createdAt: now, updatedAt: now, attempts: 0, rounds: 0, replies: [], botComments: [], addedLabels: [] });

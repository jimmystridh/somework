import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { cleanText, type HistoryLine, type InboundMessage } from "../threads/message.ts";
import { DurableTable } from "../threads/store.ts";
import type { StoredLine } from "../telegram/store.ts";

/** The ids of Slack conversations (`slack:<channel>` for a DM, `slack:<channel>:<thread>` for a channel thread) and of the messages in them (`slack:<event id>`): the engine hands them to the channel, not to the domain. */
export const SLACK_PREFIX = "slack:";

interface Seen {
	id: string;
	n: number;
}

const KEEP = 500;
const KEEP_SEEN = 2000;

/**
 * What the channel keeps of its conversations: the messages (the model's history, and what a restart needs to take up a message that was not
 * answered yet) and the events already taken in, so that one that Slack delivers again never gets a second answer. The domain knows nothing of
 * these conversations.
 */
export class SlackStore {
	readonly #table: DurableTable<StoredLine>;
	readonly #seen: DurableTable<Seen>;
	readonly #agentId: string;
	#next: number;
	#nextSeen: number;

	constructor(dir: string, agentId: string) {
		mkdirSync(dir, { recursive: true });
		this.#table = new DurableTable<StoredLine>(join(dir, "messages.json"));
		this.#seen = new DurableTable<Seen>(join(dir, "seen.json"));
		this.#agentId = agentId;
		this.#next = Math.max(0, ...this.#table.all().map((line) => line.n)) + 1;
		this.#nextSeen = Math.max(0, ...this.#seen.all().map((row) => row.n)) + 1;
	}

	owns(id: string | undefined): boolean {
		return id !== undefined && id.startsWith(SLACK_PREFIX);
	}

	/** Takes note of an event (by its event id and by channel and timestamp); false when any of the keys was taken in before. */
	claim(keys: readonly string[]): boolean {
		if (keys.some((key) => this.#seen.get(key))) return false;
		for (const key of keys) this.#seen.put({ id: key, n: this.#nextSeen++ });
		const rows = this.#seen.all().sort((a, b) => a.n - b.n);
		for (const old of rows.slice(0, Math.max(0, rows.length - KEEP_SEEN))) this.#seen.remove(old.id);
		return true;
	}

	/** Forgets an event that could not be handed to the engine, so that Slack delivering it again is taken up. */
	release(keys: readonly string[]): void {
		for (const key of keys) this.#seen.remove(key);
	}

	/** Keeps a line; false when that id is already kept (an event delivered twice). */
	record(line: Omit<StoredLine, "n">): boolean {
		if (this.#table.get(line.id)) return false;
		this.#table.put({ ...line, n: this.#next++ });
		const rows = this.#table.all().sort((a, b) => a.n - b.n);
		for (const old of rows.slice(0, Math.max(0, rows.length - KEEP))) this.#table.remove(old.id);
		return true;
	}

	/** A message a person wrote, as the engine reads messages of the domain. */
	message(id: string): InboundMessage | undefined {
		const line = this.#table.get(id);
		if (!line || line.sender.kind !== "human") return undefined;
		return { messageId: line.id, type: "chat.message", sender: line.sender, recipients: [{ kind: "agent", id: this.#agentId }], conversationId: line.conversationId, createdAt: line.at, text: line.text };
	}

	/** The lines of a conversation before a message, the last `limit` of them, oldest first. */
	history(conversationId: string, beforeId: string, limit: number, chars: number): HistoryLine[] {
		const before = this.#table.get(beforeId)?.n ?? Number.POSITIVE_INFINITY;
		return this.#table
			.all()
			.filter((line) => line.conversationId === conversationId && line.n < before)
			.sort((a, b) => a.n - b.n)
			.slice(-limit)
			.map((line) => ({ sender: line.sender.id, kind: line.sender.kind, at: line.at.slice(0, 25), text: cleanText(line.text, chars) }));
	}
}

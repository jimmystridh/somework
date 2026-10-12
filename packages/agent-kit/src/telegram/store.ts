import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanText, type HistoryLine, type InboundMessage } from "../threads/message.ts";
import { DurableTable } from "../threads/store.ts";

/** The ids of Telegram conversations (`tg:<chatId>`) and of the messages in them (`tg:<updateId>`): the engine hands them to the channel, not to the domain. */
export const TELEGRAM_PREFIX = "tg:";

export interface StoredLine {
	id: string;
	conversationId: string;
	sender: { kind: string; id: string };
	text: string;
	at: string;
	/** Order within the store: Telegram's dates only have a resolution of seconds. */
	n: number;
}

const KEEP = 500;

/**
 * What the channel keeps of its chats: the messages (the model's history, and what a restart needs to take up a message that was not answered
 * yet) and how far `getUpdates` has been read. The domain knows nothing of these conversations.
 */
export class TelegramStore {
	readonly #table: DurableTable<StoredLine>;
	readonly #offsetFile: string;
	readonly #agentId: string;
	#next: number;

	constructor(dir: string, agentId: string) {
		mkdirSync(dir, { recursive: true });
		this.#table = new DurableTable<StoredLine>(join(dir, "messages.json"));
		this.#offsetFile = join(dir, "offset.json");
		this.#agentId = agentId;
		this.#next = Math.max(0, ...this.#table.all().map((line) => line.n)) + 1;
	}

	owns(id: string | undefined): boolean {
		return id !== undefined && id.startsWith(TELEGRAM_PREFIX);
	}

	/** The next update id to ask Telegram for, once one was saved. */
	offset(): number | undefined {
		if (!existsSync(this.#offsetFile)) return undefined;
		try {
			const value = JSON.parse(readFileSync(this.#offsetFile, "utf8"))?.offset;
			return Number.isSafeInteger(value) ? value : undefined;
		} catch {
			return undefined;
		}
	}

	saveOffset(offset: number): void {
		writeFileSync(`${this.#offsetFile}.tmp`, JSON.stringify({ offset }));
		renameSync(`${this.#offsetFile}.tmp`, this.#offsetFile);
	}

	/** Keeps a line; false when that id is already kept (an update read twice). */
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
			.map((line) => ({ sender: line.sender.id, kind: line.sender.kind, at: line.at.slice(0, 25), text: cleanText(line.text, chars), messageId: line.id }));
	}
}

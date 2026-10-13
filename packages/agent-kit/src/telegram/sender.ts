import { silent, type Log } from "../log.ts";
import { finishReply, type OutgoingMessage, type Sender, type SentMessage } from "../threads/message.ts";
import { approvalButtonData, textChunks, type TelegramApi } from "./api.ts";
import { TELEGRAM_PREFIX, type TelegramStore } from "./store.ts";

const chatOf = (conversationId: string | undefined): number | undefined => {
	const chat = Number(conversationId?.startsWith(TELEGRAM_PREFIX) ? conversationId.slice(TELEGRAM_PREFIX.length) : Number.NaN);
	return Number.isSafeInteger(chat) ? chat : undefined;
};

/** The words for attachments, which a chat cannot carry: they stay in the domain, where any principal can fetch them. */
export const attachmentsLine = (artifacts: unknown[] | undefined): string => {
	if (!artifacts || artifacts.length === 0) return "";
	const names = artifacts.map((ref: any) => `${ref?.filename ?? "file"} (${ref?.artifactId ?? "?"})`);
	return `\n\n${artifacts.length} attachment(s) are kept in the domain, not sent here: ${names.join("; ")}`;
};

/** Delivers what an agent says in a Telegram conversation to that chat. */
export class TelegramSender implements Sender {
	readonly #api: TelegramApi;
	readonly #store: TelegramStore;
	readonly #agentId: string;
	readonly #maxBytes: number;
	readonly #log: Log;
	#sent = 0;

	constructor(options: { api: TelegramApi; store: TelegramStore; agentId: string; maxBytes?: number; log?: Log }) {
		this.#api = options.api;
		this.#store = options.store;
		this.#agentId = options.agentId;
		this.#maxBytes = options.maxBytes ?? 8192;
		this.#log = options.log ?? silent;
	}

	async send(message: OutgoingMessage): Promise<SentMessage> {
		return this.#deliver(message);
	}

	async #deliver(message: OutgoingMessage, buttons?: unknown): Promise<SentMessage> {
		const chat = chatOf(message.conversationId);
		if (chat === undefined) throw new Error("not a Telegram conversation");
		const text = finishReply(`${message.text}${attachmentsLine(message.artifacts)}`, this.#maxBytes);
		const messageId = `${TELEGRAM_PREFIX}out:${Date.now()}:${this.#sent++}`;
		this.#store.record({ id: messageId, conversationId: message.conversationId!, sender: { kind: "agent", id: this.#agentId }, text, at: new Date().toISOString() });
		const chunks = textChunks(text);
		for (const [index, chunk] of chunks.entries()) await this.#api("sendMessage", { chat_id: chat, text: chunk, ...(buttons !== undefined && index === chunks.length - 1 ? { reply_markup: buttons } : {}) });
		this.#log("info", "telegram_sent", { chunks: chunks.length });
		return { messageId, conversationId: message.conversationId! };
	}

	/** A line into a conversation that is not an answer. */
	async say(conversationId: string, text: string): Promise<void> {
		await this.send({ recipients: [], conversationId, text, key: "" });
	}

	/** An approval question with an Approve and a Deny button; `id` is the question's id, which the tap carries back (`approvalButtonData`). */
	async ask(conversationId: string, text: string, id: string): Promise<void> {
		const buttons = { inline_keyboard: [[{ text: "Approve", callback_data: approvalButtonData(id, true) }, { text: "Deny", callback_data: approvalButtonData(id, false) }]] };
		await this.#deliver({ recipients: [], conversationId, text, key: "" }, buttons);
	}
}

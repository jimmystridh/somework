import { silent, type Log } from "../log.ts";
import { finishReply, type OutgoingMessage, type Sender } from "../threads/message.ts";
import { textChunks, type TelegramApi } from "./api.ts";
import { TELEGRAM_PREFIX, type TelegramStore } from "./store.ts";

const chatOf = (conversationId: string | undefined): number | undefined => {
	const chat = Number(conversationId?.startsWith(TELEGRAM_PREFIX) ? conversationId.slice(TELEGRAM_PREFIX.length) : Number.NaN);
	return Number.isSafeInteger(chat) ? chat : undefined;
};

/** The words for attachments, which a chat cannot carry: they stay in the domain, where any principal can fetch them. */
const attachmentsLine = (artifacts: unknown[] | undefined): string => {
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

	async send(message: OutgoingMessage): Promise<void> {
		const chat = chatOf(message.conversationId);
		if (chat === undefined) throw new Error("not a Telegram conversation");
		const text = finishReply(`${message.text}${attachmentsLine(message.artifacts)}`, this.#maxBytes);
		this.#store.record({ id: `${TELEGRAM_PREFIX}out:${Date.now()}:${this.#sent++}`, conversationId: message.conversationId!, sender: { kind: "agent", id: this.#agentId }, text, at: new Date().toISOString() });
		for (const chunk of textChunks(text)) await this.#api("sendMessage", { chat_id: chat, text: chunk });
		this.#log("info", "telegram_sent", { chunks: textChunks(text).length });
	}

	/** A line into a conversation that is not an answer: an approval question. */
	say(conversationId: string, text: string): Promise<void> {
		return this.send({ recipients: [], conversationId, text, key: "" });
	}
}

/** Sends into Telegram conversations through the bot and everything else through the domain. */
export class RoutedSender implements Sender {
	readonly #domain: Sender;
	readonly #telegram: Sender;
	readonly #store: Pick<TelegramStore, "owns">;

	constructor(domain: Sender, telegram: Sender, store: Pick<TelegramStore, "owns">) {
		this.#domain = domain;
		this.#telegram = telegram;
		this.#store = store;
	}

	send(message: OutgoingMessage): Promise<void> {
		return (this.#store.owns(message.conversationId) ? this.#telegram : this.#domain).send(message);
	}
}

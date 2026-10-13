import { silent, type Log } from "../log.ts";
import type { Metrics } from "../metrics.ts";
import type { ApprovalChannel, Approvals } from "../threads/approvals.ts";
import type { JobManager, Party } from "../threads/jobs.ts";
import { finishReply, type InboundMessage } from "../threads/message.ts";
import { describeJob } from "../threads/tools.ts";
import { parseApprovalButton, parseUpdate, textChunks, type ParsedUpdate, type TelegramApi, type TelegramFiles } from "./api.ts";
import type { TelegramSender } from "./sender.ts";
import { TELEGRAM_PREFIX, type TelegramStore } from "./store.ts";

/** The principal a person on Telegram is, as far as the agent's conversations go. */
export const TELEGRAM_SENDER_PREFIX = "telegram/";

/** Approval questions to a person on Telegram are asked and answered on the chat. */
export function telegramApprovals(store: Pick<TelegramStore, "owns">, sender: Pick<TelegramSender, "say" | "ask">): ApprovalChannel {
	return {
		owns: (conversationId) => store.owns(conversationId),
		reaches: (approver) => approver.id.startsWith(TELEGRAM_SENDER_PREFIX),
		say: (conversationId, text) => sender.say(conversationId, text),
		ask: (conversationId, text, id) => sender.ask(conversationId, text, id),
	};
}

export interface TelegramChannelDeps {
	api: TelegramApi;
	/** Downloads the pictures people send. Without it the channel reads text only. */
	files?: TelegramFiles;
	store: TelegramStore;
	allowed: ReadonlySet<number>;
	agentId: string;
	/** Hands a message to the engine (`ThreadEngine.acceptLocal`); resolves when it is safely taken in. */
	accept(message: InboundMessage): Promise<void>;
	/** What this agent is, for /start and /help. */
	about(): string;
	/** The agent's facts, for /status. */
	status(): Promise<string>;
	jobs: Pick<JobManager, "active" | "recent" | "stop">;
	approvals: Pick<Approvals, "decide">;
	messagesPerHour?: number;
	pollSeconds?: number;
	log?: Log;
	metrics?: Metrics;
	now?: () => number;
	sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

const HOUR = 3_600_000;
const COMMANDS = ["start", "help", "status", "jobs", "stop", "approve", "deny"];

const sleepUnlessAborted = (ms: number, signal: AbortSignal): Promise<void> =>
	new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
	});

/**
 * The agent's own Telegram bot: long polling, no webhook. A private message from an allowed person becomes a message of a conversation
 * (`tg:<chat>`) that the thread engine handles like any other from a human; the answer, and the end of a job started there, come back to the
 * chat. The domain never sees these conversations. A few slash commands are answered here without a model run.
 */
export class TelegramChannel {
	readonly #deps: TelegramChannelDeps;
	readonly #log: Log;
	readonly #now: () => number;
	readonly #recent = new Map<number, number[]>();
	readonly #warned = new Set<number>();

	constructor(deps: TelegramChannelDeps) {
		this.#deps = deps;
		this.#log = deps.log ?? silent;
		this.#now = deps.now ?? Date.now;
	}

	async run(signal: AbortSignal): Promise<void> {
		const { api, store } = this.#deps;
		const sleep = this.#deps.sleep ?? sleepUnlessAborted;
		let offset = store.offset();
		let backoff = 1000;
		this.#log("info", "telegram_started", { allowedUsers: this.#deps.allowed.size });
		while (!signal.aborted) {
			try {
				const updates: any[] = await api("getUpdates", { ...(offset === undefined ? {} : { offset }), timeout: this.#deps.pollSeconds ?? 30, allowed_updates: ["message", "callback_query"] }, signal);
				backoff = 1000;
				for (const update of Array.isArray(updates) ? updates : []) {
					await this.handleUpdate(update);
					if (Number.isSafeInteger(update?.update_id)) {
						offset = update.update_id + 1;
						store.saveOffset(offset);
					}
				}
			} catch (error) {
				if (signal.aborted) break;
				this.#log("warn", "telegram_poll_failed", { error: error instanceof Error ? error.message.slice(0, 160) : "unknown" });
				await sleep(backoff, signal);
				backoff = Math.min(backoff * 2, 30_000);
			}
		}
		this.#log("info", "telegram_stopped");
	}

	/** One update. A failure to hand a message to the engine is thrown, so that the update is read again; everything else is settled here. */
	async handleUpdate(update: unknown): Promise<void> {
		const parsed = parseUpdate(update, this.#deps.allowed);
		if (!parsed) return;
		const count = this.#deps.metrics?.counter("somework_telegram_updates_total", "Telegram updates, by what became of them");
		if (parsed.kind === "ignored") return void count?.({ result: parsed.reason });
		if (parsed.kind === "callback") {
			count?.({ result: "button" });
			return this.#button(parsed);
		}
		if (parsed.kind === "unsupported") {
			count?.({ result: "unsupported" });
			return this.#reply(parsed.chatId, "I read text messages only.");
		}
		const command = /^\/([a-z]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(parsed.text);
		if (command) {
			count?.({ result: "command" });
			return this.#command(parsed.chatId, parsed.userId, command[1]!.toLowerCase(), (command[2] ?? "").trim());
		}
		if (!this.#withinLimit(parsed.userId)) {
			count?.({ result: "rate_limited" });
			if (!this.#warned.has(parsed.userId)) {
				this.#warned.add(parsed.userId);
				await this.#reply(parsed.chatId, `That is more than ${this.#deps.messagesPerHour ?? 30} messages an hour: I leave the rest of them for now.`);
			}
			return;
		}
		this.#warned.delete(parsed.userId);
		const messageId = `${TELEGRAM_PREFIX}${parsed.updateId}`;
		const conversationId = `${TELEGRAM_PREFIX}${parsed.chatId}`;
		const sender = { kind: "human", id: `${TELEGRAM_SENDER_PREFIX}${parsed.userId}` };
		const images: { file: string; mimeType: string }[] = [];
		if (parsed.images.length > 0) {
			if (!this.#deps.files) return this.#reply(parsed.chatId, "I read text messages only.");
			for (const [index, image] of parsed.images.entries()) {
				try {
					images.push(this.#deps.store.saveImage(messageId, index, await this.#deps.files(image.fileId), image.mimeType));
				} catch (error) {
					this.#log("warn", "telegram_image_failed", { error: error instanceof Error ? error.message.slice(0, 160) : "unknown" });
				}
			}
			if (images.length === 0) {
				count?.({ result: "image_failed" });
				return this.#reply(parsed.chatId, "I could not fetch that picture. Send it again, or describe it in text.");
			}
		}
		const text = parsed.text === "" ? "(a picture without text)" : parsed.text;
		this.#deps.store.record({ id: messageId, conversationId, sender, text: images.length > 0 ? `${text}\n[${images.length} picture(s) attached]` : text, at: parsed.sentAt, ...(images.length > 0 ? { images } : {}) });
		const message = this.#deps.store.message(messageId);
		if (!message) return;
		count?.({ result: "accepted" });
		await this.#deps.accept(message);
	}

	/** A tap on Approve or Deny: decides like the command does, tells Telegram it was seen, and takes the buttons off the question. */
	async #button(press: Extract<ParsedUpdate, { kind: "callback" }>): Promise<void> {
		const { api } = this.#deps;
		const decision = parseApprovalButton(press.data);
		const toast = (text: string): Promise<unknown> => api("answerCallbackQuery", { callback_query_id: press.queryId, text }).catch(() => undefined);
		if (!decision) return void (await toast("I do not know that button."));
		const who: Party = { kind: "human", id: `${TELEGRAM_SENDER_PREFIX}${press.userId}` };
		const result = this.#deps.approvals.decide(decision.id, who, `${TELEGRAM_PREFIX}${press.chatId}`, decision.approved);
		const outcome = result === "decided" ? (decision.approved ? "Approved." : "Denied.") : result === "rejected" ? "That question was not put to you here." : "That question is closed (it may have timed out).";
		await toast(outcome);
		if (result === "rejected" || press.messageId === undefined) return;
		await api("editMessageText", { chat_id: press.chatId, message_id: press.messageId, text: `${press.text}\n\n${outcome}`.slice(0, 4096), reply_markup: { inline_keyboard: [] } }).catch((error) =>
			this.#log("warn", "telegram_reply_failed", { error: error instanceof Error ? error.message.slice(0, 160) : "unknown" }),
		);
	}

	#withinLimit(userId: number): boolean {
		const now = this.#now();
		const kept = (this.#recent.get(userId) ?? []).filter((at) => now - at < HOUR);
		if (kept.length >= (this.#deps.messagesPerHour ?? 30)) {
			this.#recent.set(userId, kept);
			return false;
		}
		this.#recent.set(userId, [...kept, now]);
		return true;
	}

	async #command(chatId: number, userId: number, name: string, argument: string): Promise<void> {
		const who: Party = { kind: "human", id: `${TELEGRAM_SENDER_PREFIX}${userId}` };
		const conversationId = `${TELEGRAM_PREFIX}${chatId}`;
		switch (name) {
			case "start":
			case "help":
				return this.#reply(chatId, [this.#deps.about(), "", "Write to me like to a colleague: I answer, or start work in the background and tell you here when it is done.", "Commands: /status, /jobs, /stop <job>, /approve <id>, /deny <id>, /help. A question that needs your approval comes with Approve and Deny buttons."].join("\n"));
			case "status":
				return this.#reply(chatId, (await this.#deps.status().catch(() => "The status could not be built.")).slice(0, 3500));
			case "jobs": {
				const now = this.#now();
				const active = this.#deps.jobs.active().map((job) => describeJob(job, now));
				const recent = this.#deps.jobs.recent(3).map((job) => describeJob(job, now));
				return this.#reply(chatId, [`Active (${active.length}):`, ...(active.length > 0 ? active : ["(none)"]), "", "Finished lately:", ...(recent.length > 0 ? recent : ["(none)"])].join("\n"));
			}
			case "stop": {
				if (argument === "") return this.#reply(chatId, "Say which job: /stop <job id> (see /jobs).");
				const result = await this.#deps.jobs.stop(argument.split(/\s+/)[0]!, who, "asked to stop from Telegram");
				return this.#reply(chatId, result === "unknown" ? "I have no such job." : result === "cancelled" ? "That job had not started: it will not run." : result === "told" ? "The job was told. It decides what to do; its result message says how it ended." : "That job had already finished.");
			}
			case "approve":
			case "deny": {
				if (argument === "") return this.#reply(chatId, `Say which question: /${name} <id>.`);
				const result = this.#deps.approvals.decide(argument.split(/\s+/)[0]!, who, conversationId, name === "approve");
				return this.#reply(chatId, result === "decided" ? (name === "approve" ? "Approved." : "Denied.") : result === "rejected" ? "That question was not put to you here." : "I have no open question with that id (it may have timed out).");
			}
			default:
				return this.#reply(chatId, `I do not know /${name}. ${COMMANDS.map((command) => `/${command}`).join(", ")}.`);
		}
	}

	async #reply(chatId: number, text: string): Promise<void> {
		try {
			for (const chunk of textChunks(finishReply(text, 8192))) await this.#deps.api("sendMessage", { chat_id: chatId, text: chunk });
		} catch (error) {
			this.#log("warn", "telegram_reply_failed", { error: error instanceof Error ? error.message.slice(0, 160) : "unknown" });
		}
	}
}

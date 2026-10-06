import { runWakes, type SomeWorkClient, type Wake, type WakeOptions } from "@somework/sdk";
import type { Log } from "./log.ts";
import type { Metrics } from "./metrics.ts";
import type { ChatModelSettings, ModelChatOutcome } from "./chat-model.ts";
import type { Budget } from "./runtime.ts";

/**
 * Agents take tasks, not chat. A message sent to one used to sit unread forever, so the sender never learned that. This answers every
 * direct chat message once, deterministically (no model, no tokens), with a notice that says so and lists what the agent can do.
 *
 * Why it cannot loop: the answer is a `chat.notice`, whose only permitted trigger mode is `never` (the domain refuses anything else), so
 * it wakes nobody; it also carries the `autoReply` label and this module ignores anything that is not a plain `chat.message` or that
 * carries the label. Per sender and conversation there is at most one answer per window, and an hourly cap bounds the total.
 */

/** Marker label on the notices this module sends. */
export const AUTO_REPLY_LABEL = "autoReply";
/** Marker label on a model-written chat reply (`chat.mode: "model"`). No responder answers a message that carries it. */
export const CHAT_REPLY_LABEL = "chatReply";
/** An approval question the agent sent to its instructor, and the instructor's labelled answer to it (the value is the question's random id). */
export const CHAT_APPROVAL_REQUEST_LABEL = "chatApprovalRequest";
export const CHAT_APPROVAL_DECISION_LABEL = "chatApprovalDecision";

export interface ChatConfig {
	/**
	 * `model` (the default for every role): a direct chat message from an allowed sender is answered by the model, as a question (one bounded
	 * read-only turn) or, from an instructor with the `instruct:` prefix, as an instruction (a job of the role's normal handler); see
	 * `chat-model.ts`. What the model cannot or may not answer, and every sender that is not allowed, gets the deterministic notice.
	 * `notice`: every sender gets the notice and no model reads the message. `CHAT_MODE` in the environment overrides this for a deployment.
	 */
	mode?: "notice" | "model";
	/** Principal ids or `kind:<kind>` that may ask (default `agent/manager` and `kind:human`; `CHAT_ALLOWED_SENDERS` overrides). */
	askers?: string[];
	/** Principal ids or `kind:<kind>` that may instruct (default `agent/manager`; `CHAT_INSTRUCTORS` overrides). They may ask too. */
	instructors?: string[];
	/** Tool names per tier. `ask` is the full list (default `read`, `agent_status` and the role's read-only tools; never bash, edit or write). `instruct` defaults to the role's own tools. */
	tools?: { ask?: string[]; instruct?: string[] };
	/** The message starts with this to be an instruction rather than a question (default `instruct:`). */
	instructPrefix?: string;
	/** Tokens of one ASK answer (default 40 000) and the cap no setting can pass (default 200 000). */
	tokenCap?: number;
	hardTokenCap?: number;
	/** What one instruction may use (default 150 000 tokens, 15 minutes); the message cannot change it, the role's own limits still apply. */
	instructBudget?: Budget;
	/** Wall clock of one ASK turn in minutes (default 2) and how long an approval question waits for the instructor (default 10). */
	maxMinutes?: number;
	approvalMinutes?: number;
	/** Seconds of waiting after which a turn says it is queued (default 20). */
	busyAfterSeconds?: number;
	/** Share of the daily token limit for the `chat` pool (default 0.1) and the fraction of it at which ask answers get half the cap (default 0.8). */
	share?: number;
	throttleAt?: number;
	/** Messages of history shown to the model (default 10, at most 30), characters kept per message (600), largest reply in bytes (4096). */
	historyMessages?: number;
	messageChars?: number;
	replyMaxBytes?: number;
	/** Answers per hour for the whole agent (default 20) and per sender and conversation within a window in milliseconds (default 15 000). */
	hourlyLimit?: number;
	senderWindowMs?: number;
	/** A message older than this many milliseconds is not answered (default 5 minutes). */
	maxAgeMs?: number;
	/** Default true. False turns the responder off for the role. */
	autoReply?: boolean;
	/** Replaces the default notice text. Must be deterministic and must not include anything the sender sent. */
	replyTemplate?: (context: ReplyContext) => string;
}

export interface ReplyContext {
	/** The SomeWork id of this agent. */
	agentId: string;
	/** The role name of the profile. */
	role: string;
	capabilities: { id: string; version: string }[];
	sender: { kind: string; id: string };
}

/** The parts of a message record this module reads. */
export interface InboundMessage {
	messageId: string;
	type: string;
	sender: { kind: string; id: string };
	conversationId?: string;
	createdAt?: string;
	labels?: Record<string, string>;
	/** The text of a `text/plain` message (cut), when the record carries it. */
	text?: string;
}

export type Decision = { reply: true } | { reply: false; reason: string };

export const DEFAULT_MAX_AGE_MS = 5 * 60_000;
export const DEFAULT_SENDER_WINDOW_MS = 10 * 60_000;
export const DEFAULT_HOURLY_LIMIT = 30;
const HOUR_MS = 3_600_000;

/** Remembers whom was answered when. In memory: a restart forgets, and the age guard bounds what a restart can answer again. */
export class ReplyLimiter {
	readonly #perSender = new Map<string, number>();
	readonly #sent: number[] = [];
	readonly #windowMs: number;
	readonly #hourly: number;

	constructor(windowMs = DEFAULT_SENDER_WINDOW_MS, hourly = DEFAULT_HOURLY_LIMIT) {
		this.#windowMs = windowMs;
		this.#hourly = hourly;
	}

	/** `trusted` skips the per-sender wait (the owner's proxy may follow up at once); the hourly cap still applies. */
	check(sender: string, conversationId: string | undefined, now: number, trusted = false): { ok: true } | { ok: false; reason: string } {
		this.#forget(now);
		const last = this.#perSender.get(key(sender, conversationId));
		if (!trusted && last !== undefined && now - last < this.#windowMs) return { ok: false, reason: "rate_limited_sender" };
		if (this.#sent.length >= this.#hourly) return { ok: false, reason: "rate_limited_total" };
		return { ok: true };
	}

	get windowMs(): number {
		return this.#windowMs;
	}

	/** When this sender last had an answer in this conversation, if the window has not passed yet. */
	lastAnswer(sender: string, conversationId: string | undefined, now: number): number | undefined {
		const last = this.#perSender.get(key(sender, conversationId));
		return last !== undefined && now - last < this.#windowMs ? last : undefined;
	}

	record(sender: string, conversationId: string | undefined, now: number): void {
		this.#perSender.set(key(sender, conversationId), now);
		this.#sent.push(now);
	}

	#forget(now: number): void {
		while (this.#sent.length > 0 && now - this.#sent[0]! >= HOUR_MS) this.#sent.shift();
		for (const [k, at] of this.#perSender) if (now - at >= Math.max(this.#windowMs, HOUR_MS)) this.#perSender.delete(k);
	}
}

const key = (sender: string, conversationId: string | undefined): string => `${sender}\u0000${conversationId ?? ""}`;

/** Whether to answer a message. Pure: every guard in one place, in the order a reader would ask the questions. */
export function decideReply(message: InboundMessage, state: { self: string; now: number; maxAgeMs: number; limiter: ReplyLimiter }): Decision {
	if (message.sender.id === state.self) return { reply: false, reason: "own_message" };
	if (message.type !== "chat.message") return { reply: false, reason: "not_a_chat_message" };
	if (message.labels?.[AUTO_REPLY_LABEL] !== undefined) return { reply: false, reason: "auto_reply" };
	if (message.labels?.[CHAT_REPLY_LABEL] !== undefined) return { reply: false, reason: "chat_reply" };
	const created = message.createdAt === undefined ? Number.NaN : Date.parse(message.createdAt);
	if (!Number.isFinite(created)) return { reply: false, reason: "no_timestamp" };
	if (state.now - created > state.maxAgeMs) return { reply: false, reason: "stale" };
	const allowed = state.limiter.check(message.sender.id, message.conversationId, state.now);
	return allowed.ok ? { reply: true } : { reply: false, reason: allowed.reason };
}

export function defaultReplyText(context: ReplyContext): string {
	const capabilities = context.capabilities.map((c) => `${c.id}@${c.version}`).join(", ");
	return [
		`This is ${context.agentId} (${context.role}). I take tasks, not chat: messages sent to me are not read by a model, so nobody will answer this thread.`,
		`To use me, submit a task for one of my capabilities: ${capabilities}. The catalog lists the input each one needs.`,
		"This notice is automatic and is sent at most once per sender and conversation in a while.",
	].join(" ");
}

export interface ChatResponderOptions {
	client: SomeWorkClient;
	/** The SomeWork id of this agent (messages from it are never answered). */
	agentId: string;
	role: string;
	capabilities: { id: string; version: string }[];
	signal: AbortSignal;
	log: Log;
	metrics?: Metrics;
	config?: ChatConfig;
	/** Epoch milliseconds; replaceable in tests. */
	now?: () => number;
	maxAgeMs?: number;
	senderWindowMs?: number;
	hourlyLimit?: number;
	/**
	 * Looks at each message before the chat rules do; returning true means it was dealt with (a control message for the event handlers)
	 * and gets no notice. Only one consumer may read the agent's message wakes, so other message handling hooks in here.
	 */
	intercept?: (message: InboundMessage) => Promise<boolean>;
	/** Answers plain direct chat with a model turn (`chat.mode: "model"`); what it cannot answer falls back to the notice below. */
	model?: { handle(message: InboundMessage): Promise<ModelChatOutcome>; offerDecision?(message: InboundMessage): boolean };
	/** How wakes arrive (`poll` never uses NATS); tests use short poll intervals. */
	wake?: Pick<WakeOptions, "mode" | "pollEveryMs" | "sweepEveryMs">;
}

const asMessage = (body: any): InboundMessage | undefined => {
	const record = body?.message ?? body;
	if (!record || typeof record.messageId !== "string" || typeof record.type !== "string" || typeof record.sender?.id !== "string") return undefined;
	return {
		messageId: record.messageId,
		type: record.type,
		sender: { kind: String(record.sender.kind ?? "agent"), id: record.sender.id },
		conversationId: typeof record.conversationId === "string" ? record.conversationId : undefined,
		createdAt: typeof record.createdAt === "string" ? record.createdAt : undefined,
		labels: record.labels && typeof record.labels === "object" ? record.labels : undefined,
		...(typeof record.content?.data === "string" && /^text\//.test(String(record.content?.mediaType ?? "text/plain")) ? { text: record.content.data.slice(0, 8000) } : {}),
	};
};

/**
 * Answers direct chat messages until `signal` aborts: with the notice described at the top of this file, or, when a model responder is
 * given, with a model turn first (see `chat-model.ts`) and the notice for whatever the model cannot or may not answer. Notice messages are
 * handled one at a time and a wake is acknowledged only after its message was dealt with. A model message is acknowledged as soon as it
 * is read (the responder holds it and takes its turns one at a time), because a turn can take minutes and an unacknowledged wake is
 * delivered again; approval decisions and control messages are handled at once, ahead of any turn, because a turn may be waiting for them.
 * Nothing here can fail the agent: errors are logged and the message is dropped (a notice is a courtesy, not a guarantee).
 */
export async function runChatResponder(options: ChatResponderOptions): Promise<void> {
	const replying = options.config?.autoReply !== false;
	if (!replying && !options.intercept && !options.model) return;
	const now = options.now ?? Date.now;
	const limiter = new ReplyLimiter(options.senderWindowMs, options.hourlyLimit);
	const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
	const outcome = options.metrics?.counter("somework_chat_messages_total", "Direct chat messages received, by what was done with them");
	const text = options.config?.replyTemplate ?? defaultReplyText;
	let queue: Promise<void> = Promise.resolve();

	const load = async (messageId: string): Promise<InboundMessage | undefined> => {
		let message: InboundMessage | undefined;
		try {
			message = asMessage(await options.client.get(`/v1/messages/${encodeURIComponent(messageId)}`));
		} catch (error) {
			options.log("warn", "chat_message_unreadable", { messageId, error: String(error).slice(0, 160) });
			outcome?.({ result: "ignored", reason: "unreadable" });
			return undefined;
		}
		if (!message) {
			options.log("warn", "chat_message_unreadable", { messageId, error: "unexpected message shape" });
			outcome?.({ result: "ignored", reason: "unreadable" });
		}
		return message;
	};

	/** The deterministic notice, subject to its own once-per-window and hourly limits. */
	const notify = async (message: InboundMessage, noticeText?: string): Promise<void> => {
		const decision = decideReply(message, { self: options.agentId, now: now(), maxAgeMs, limiter });
		if (!decision.reply) {
			options.log("info", "chat_message_received", { from: message.sender.id, conversationId: message.conversationId, replied: false, reason: decision.reason });
			outcome?.({ result: "ignored", reason: decision.reason });
			return;
		}
		// reserve the slot first: a slow or failing send must not allow a second notice for the same burst of messages
		limiter.record(message.sender.id, message.conversationId, now());
		try {
			await options.client.post(
				"/v1/messages",
				{
					type: "chat.notice",
					recipients: [{ kind: message.sender.kind, id: message.sender.id }],
					...(message.conversationId ? { conversationId: message.conversationId } : {}),
					replyTo: message.messageId,
					causationId: message.messageId,
					triggerMode: "never",
					content: { mediaType: "text/plain", data: noticeText ?? text({ agentId: options.agentId, role: options.role, capabilities: options.capabilities, sender: message.sender }) },
					labels: { [AUTO_REPLY_LABEL]: "true" },
				},
				{ idempotencyKey: `autoreply:${message.messageId}` },
			);
			options.log("info", "chat_message_received", { from: message.sender.id, conversationId: message.conversationId, replied: true });
			options.log("info", "chat_reply_sent", { to: message.sender.id, conversationId: message.conversationId });
			outcome?.({ result: "replied", reason: "" });
		} catch (error) {
			options.log("warn", "chat_reply_failed", { to: message.sender.id, conversationId: message.conversationId, error: String(error).slice(0, 160) });
			outcome?.({ result: "ignored", reason: "reply_failed" });
		}
	};

	const handle = async (messageId: string): Promise<void> => {
		const message = await load(messageId);
		if (!message) return;
		if (options.intercept && (await options.intercept(message).catch(() => false))) {
			outcome?.({ result: "ignored", reason: "intercepted" });
			return;
		}
		if (!replying) return;
		await notify(message);
	};

	/** Model mode: decisions and control messages first, then the model's turn, then the notice for what it did not answer. */
	const handleModel = async (wake: Wake): Promise<void> => {
		const model = options.model!;
		try {
			const message = await load(wake.messageId);
			if (!message) return void (await wake.ack().catch(() => {}));
			if (model.offerDecision?.(message)) {
				outcome?.({ result: "ignored", reason: "approval_decision" });
				return void (await wake.ack().catch(() => {}));
			}
			if (options.intercept && (await options.intercept(message).catch(() => false))) {
				outcome?.({ result: "ignored", reason: "intercepted" });
				return void (await wake.ack().catch(() => {}));
			}
			await wake.ack().catch(() => {});
			const answered = await model.handle(message).catch((error): ModelChatOutcome => {
				options.log("warn", "chat_model_failed", { messageId: wake.messageId, error: String(error).slice(0, 160) });
				return { answered: false, reason: "model_failed", fallback: { text: "I could not answer that right now." } };
			});
			if (answered.answered) return void outcome?.({ result: "answered", reason: "" });
			if (!answered.fallback || !replying) return void outcome?.({ result: "ignored", reason: answered.reason });
			const rest = defaultReplyText({ agentId: options.agentId, role: options.role, capabilities: options.capabilities, sender: message.sender }).split(". ").slice(1).join(". ");
			queue = queue.then(() => notify(message, `This is ${options.agentId} (${options.role}). ${answered.fallback!.text} ${rest}`)).catch((error) => options.log("warn", "chat_handler_failed", { error: String(error).slice(0, 160) }));
		} catch (error) {
			options.log("warn", "chat_handler_failed", { error: String(error).slice(0, 160) });
			await wake.ack().catch(() => {});
		}
	};

	const onWake = (wake: Wake): void => {
		if (wake.kind !== "message") return void wake.ack().catch(() => {});
		if (options.model) return void handleModel(wake);
		queue = queue
			.then(() => handle(wake.messageId))
			.catch((error) => options.log("warn", "chat_handler_failed", { error: String(error).slice(0, 160) }))
			.then(() => wake.ack().catch(() => {}));
	};

	try {
		await runWakes(options.client, options.signal, onWake, {
			kinds: ["message"],
			...options.wake,
			logger: (level, message, fields) => options.log(level, `chat_wake: ${message}`, fields),
		});
	} catch (error) {
		if (!options.signal.aborted) options.log("warn", "chat_responder_stopped", { error: String(error).slice(0, 160) });
	}
}

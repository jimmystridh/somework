import { runWakes, type SomeWorkClient, type Wake, type WakeOptions } from "@somework/sdk";
import type { Log } from "./log.ts";
import type { Metrics } from "./metrics.ts";

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

export interface ChatConfig {
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

	check(sender: string, conversationId: string | undefined, now: number): { ok: true } | { ok: false; reason: string } {
		this.#forget(now);
		const last = this.#perSender.get(key(sender, conversationId));
		if (last !== undefined && now - last < this.#windowMs) return { ok: false, reason: "rate_limited_sender" };
		if (this.#sent.length >= this.#hourly) return { ok: false, reason: "rate_limited_total" };
		return { ok: true };
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
	};
};

/**
 * Answers direct chat messages with the notice described at the top of this file until `signal` aborts. Messages are handled one at a
 * time, and a wake is acknowledged only after its message was dealt with. Nothing here can fail the agent: errors are logged and the
 * message is dropped (a notice is a courtesy, not a guarantee).
 */
export async function runChatResponder(options: ChatResponderOptions): Promise<void> {
	if (options.config?.autoReply === false) return;
	const now = options.now ?? Date.now;
	const limiter = new ReplyLimiter(options.senderWindowMs, options.hourlyLimit);
	const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
	const outcome = options.metrics?.counter("somework_chat_messages_total", "Direct chat messages received, by what was done with them");
	const text = options.config?.replyTemplate ?? defaultReplyText;
	let queue: Promise<void> = Promise.resolve();

	const handle = async (messageId: string): Promise<void> => {
		let message: InboundMessage | undefined;
		try {
			message = asMessage(await options.client.get(`/v1/messages/${encodeURIComponent(messageId)}`));
		} catch (error) {
			options.log("warn", "chat_message_unreadable", { messageId, error: String(error).slice(0, 160) });
			outcome?.({ result: "ignored", reason: "unreadable" });
			return;
		}
		if (!message) {
			options.log("warn", "chat_message_unreadable", { messageId, error: "unexpected message shape" });
			outcome?.({ result: "ignored", reason: "unreadable" });
			return;
		}
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
					content: { mediaType: "text/plain", data: text({ agentId: options.agentId, role: options.role, capabilities: options.capabilities, sender: message.sender }) },
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

	const onWake = (wake: Wake): void => {
		if (wake.kind !== "message") return void wake.ack().catch(() => {});
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

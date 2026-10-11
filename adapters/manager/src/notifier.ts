import { Backoff, sleep, wakes, type SomeWorkClient, type Wake, type WakeOptions } from "@somework/sdk";
import type { DomainApi, InboundMessage } from "./domain.ts";

export type MessageListener = (message: InboundMessage) => Promise<void>;

/** What the Manager reacts to. How messages are noticed (polling or SDK wake-ups) is the feed's business. */
export interface Notifier {
	onMessage(listener: MessageListener): void;
}

export class Notifications implements Notifier {
	#message: MessageListener[] = [];

	onMessage(listener: MessageListener): void {
		this.#message.push(listener);
	}

	async emitMessage(message: InboundMessage): Promise<void> {
		for (const listener of this.#message) await listener(message);
	}
}

/** Takes the messages that carry a setup document before they can become chat (ADR 0004). */
export interface SetupMessages {
	claims(message: InboundMessage): boolean;
	handle(message: InboundMessage): Promise<void>;
}

/** Messages other agents send to the Manager are forwarded; the domain's own status messages (type `task.*`) are not shown, and neither are setup documents. */
export class InboxReader {
	readonly #domain: DomainApi;
	readonly #notifications: Notifications;
	readonly #setup: SetupMessages | undefined;

	constructor(domain: DomainApi, notifications: Notifications, setup?: SetupMessages) {
		this.#domain = domain;
		this.#notifications = notifications;
		this.#setup = setup;
	}

	/** Forwards what is new and marks everything read. */
	async drain(): Promise<void> {
		const messages = await this.#domain.unreadMessages(50);
		const handled: string[] = [];
		try {
			for (const message of messages) {
				if (this.#setup?.claims(message) && message.from !== this.#domain.selfId) await this.#setup.handle(message);
				else if (!message.type.startsWith("task.") && message.from !== this.#domain.selfId) await this.#notifications.emitMessage(message);
				handled.push(message.messageId);
			}
		} finally {
			await this.#domain.markRead(handled).catch(() => {});
		}
	}
}

export interface FeedOptions {
	inboxIntervalMs: number;
	maxBackoffMs: number;
}

export const defaultFeed: FeedOptions = { inboxIntervalMs: 8000, maxBackoffMs: 60_000 };

/** The interim way of noticing messages: short HTTP lookups on a timer (never held open). */
export class PollingFeed {
	readonly #inbox: InboxReader;
	readonly #options: FeedOptions;
	readonly #log: (event: string, fields?: Record<string, unknown>) => void;

	constructor(inbox: InboxReader, options: Partial<FeedOptions> = {}, log: (event: string, fields?: Record<string, unknown>) => void = () => {}) {
		this.#inbox = inbox;
		this.#options = { ...defaultFeed, ...options };
		this.#log = log;
	}

	async run(signal: AbortSignal): Promise<void> {
		const backoff = new Backoff(this.#options.inboxIntervalMs, this.#options.maxBackoffMs);
		while (!signal.aborted) {
			try {
				await this.#inbox.drain();
				backoff.reset();
				await sleep(this.#options.inboxIntervalMs, signal);
			} catch (error) {
				if (signal.aborted) break;
				const delay = backoff.nextDelayMs();
				this.#log("feed_failed", { feed: "inbox", error: error instanceof Error ? error.message : String(error), retryInMs: Math.round(delay) });
				await sleep(delay, signal);
			}
		}
	}
}

export interface WakeFeedOptions {
	/** Safety net next to the push transport: how often the inbox is looked at anyway, so a lost wake only costs latency. */
	sweepEveryMs: number;
	wake: WakeOptions;
	/** Where wakes come from; the SDK's NATS-with-HTTP-fallback source unless a test supplies its own. */
	source: (client: SomeWorkClient, signal: AbortSignal, options: WakeOptions) => AsyncIterable<Wake>;
}

/** The SDK's wake source (NATS, HTTP fallback, no long polls) deciding *when* to look; the inbox decides *what* is new. */
export class WakeFeed {
	readonly #client: SomeWorkClient;
	readonly #inbox: InboxReader;
	readonly #options: WakeFeedOptions;
	readonly #log: (event: string, fields?: Record<string, unknown>) => void;

	constructor(client: SomeWorkClient, inbox: InboxReader, options: Partial<WakeFeedOptions> = {}, log: (event: string, fields?: Record<string, unknown>) => void = () => {}) {
		this.#client = client;
		this.#inbox = inbox;
		this.#options = { sweepEveryMs: 60_000, wake: {}, source: wakes, ...options };
		this.#log = log;
	}

	async run(signal: AbortSignal): Promise<void> {
		await Promise.all([this.#sweeps(signal), this.#wakes(signal)]);
	}

	async #wakes(signal: AbortSignal): Promise<void> {
		const wake = { ...this.#options.wake };
		for await (const item of this.#options.source(this.#client, signal, wake)) {
			try {
				if (item.kind === "message") await this.#inbox.drain();
				await item.ack();
			} catch (error) {
				// not acknowledged: the transport redelivers it, and the sweep covers it meanwhile
				this.#log("wake_failed", { kind: item.kind, error: error instanceof Error ? error.message : String(error) });
			}
		}
	}

	async #sweeps(signal: AbortSignal): Promise<void> {
		while (!signal.aborted) {
			await sleep(this.#options.sweepEveryMs, signal);
			if (signal.aborted) break;
			await this.#inbox.drain().catch((error) => this.#log("sweep_failed", { feed: "inbox", error: String(error) }));
		}
	}
}

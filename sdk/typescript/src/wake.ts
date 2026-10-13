import { checkServerIdentity, type PeerCertificate } from "node:tls";
import { jetstream } from "@nats-io/jetstream";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { Backoff, jittered, sleep } from "./backoff.ts";
import type { SomeWorkClient } from "./client.ts";

/** A message that may need this principal's attention. Delivery is at-least-once; `ack` tells the transport it was handled. */
export type Wake = { dedupeKey: string; ack(): Promise<void>; kind: "message"; messageId: string };


export interface WakeOptions {
	/** `auto`: NATS when the domain offers it, HTTP polling otherwise. `poll`: never NATS. */
	mode?: "auto" | "poll";
	/** Interval of the short HTTP lookups used while NATS is unavailable or disabled. */
	pollEveryMs?: number;
	/** How often the newest handled NATS notification is acknowledged to the domain's event cursor (default 5 seconds). */
	cursorAckEveryMs?: number;
	logger?: (level: "debug" | "info" | "warn", message: string, fields?: Record<string, unknown>) => void;
}

const DEDUPE_WINDOW_MS = 120_000;
const CONSUMER_ATTACH_MS = 15_000;

/** Suppresses duplicates for a short window (redeliveries, the same item arriving over both paths). */
export class Dedupe {
	readonly #seen = new Map<string, number>();

	firstTime(key: string, windowMs: number, now = Date.now()): boolean {
		for (const [seenKey, at] of this.#seen) if (now - at >= windowMs) this.#seen.delete(seenKey);
		if (this.#seen.has(key)) return false;
		this.#seen.set(key, now);
		return true;
	}
}

/** Connection details of the NATS plane as returned by `GET /v1/connection`. */
export interface NatsInfo {
	url: string;
	user?: string;
	password?: string;
	token?: string;
	inboxStream: string;
	inboxConsumer?: string;
}

const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

export function natsInfoFrom(connection: any): NatsInfo | undefined {
	const nats = connection?.nats;
	if (!nats || typeof nats !== "object") return undefined;
	const url = text(nats.url) ?? text(nats.urls?.[0]);
	if (!url) return undefined;
	return {
		url,
		user: text(nats.user),
		password: text(nats.password),
		token: text(nats.token),
		inboxStream: text(nats.inboxStream) ?? "SOMEWORK_INBOX",
		inboxConsumer: text(nats.inboxConsumer),
	};
}

type Interpreted = { messageId: string; dedupeKey: string };

/** The position of a notification in `GET /v1/events`, when the domain names it (`eventSeq`). */
export const eventSeqOf = (payload: any): number | undefined => (Number.isInteger(payload?.eventSeq) && payload.eventSeq > 0 ? payload.eventSeq : undefined);

/** Maps a JetStream notification to a wake; `undefined` means "acknowledge and ignore" (the agent's own output, items that must not wake it). */
export function interpret(payload: any, ownAgentId: string): Interpreted | undefined {
	if (payload?.wake !== true || payload.sender === ownAgentId) return undefined;
	if (payload.kind === "message" && typeof payload.messageId === "string") return { messageId: payload.messageId, dedupeKey: `msg:${payload.messageId}` };
	return undefined;
}

const asWake = (found: Interpreted, ack: () => Promise<void>): Wake => ({ kind: "message", messageId: found.messageId, dedupeKey: found.dedupeKey, ack });

/** Push wakes from the durable JetStream pull consumers of this principal. A source that lost a consumer or the connection is `dead` and must be rebuilt, not trusted. */
export class NatsWakeSource {
	readonly #connection: NatsConnection;
	readonly #dead = new AbortController();

	private constructor(connection: NatsConnection) {
		this.#connection = connection;
		void connection.closed().then(() => this.#dead.abort());
	}

	get dead(): AbortSignal {
		return this.#dead.signal;
	}

	/**
	 * TLS policy comes from the caller's own configuration (`tls`), never from the domain's answer, so a compromised or
	 * misconfigured domain cannot talk a worker into plaintext or an untrusted CA.
	 */
	static async connect(info: NatsInfo, ownAgentId: string, tls: SomeWorkClient["tls"], onWake: (wake: Wake) => void, onHandled: (eventSeq: number) => void = () => {}): Promise<NatsWakeSource> {
		const secure = tls.requireTls || tls.caPem !== undefined || info.url.startsWith("tls://");
		const servers = info.url.replace(/^(nats|tls):\/\//, "");
		const expectedHost = new URL(`tls://${servers}`).hostname.replace(/^\[|\]$/g, "");
		const connection = await connect({
			servers,
			...(info.user !== undefined && info.password !== undefined ? { user: info.user, pass: info.password } : info.token !== undefined ? { token: info.token } : {}),
			...(secure ? { tls: { ...(tls.caPem ? { ca: tls.caPem } : {}), checkServerIdentity: (_name: string, certificate: PeerCertificate) => checkServerIdentity(expectedHost, certificate) } } : {}),
			reconnect: false,
			timeout: 10_000,
		});
		const source = new NatsWakeSource(connection);
		try {
			const js = jetstream(connection);
			const dedupe = new Dedupe();
			const wanted: { stream: string; name: string }[] = info.inboxConsumer ? [{ stream: info.inboxStream, name: info.inboxConsumer }] : [];
			for (const { stream, name } of wanted) {
				const consumer = await attachConsumer(() => js.consumers.get(stream, name), `${name} on ${stream}`);
				const messages = await consumer.consume();
				void (async () => {
					try {
						for await (const message of messages) {
							let payload: unknown = null;
							try {
								payload = message.json();
							} catch {
								// not ours to interpret: acknowledge below
							}
							const eventSeq = eventSeqOf(payload);
							const handled = () => {
								message.ack();
								if (eventSeq !== undefined) onHandled(eventSeq);
							};
							const found = interpret(payload, ownAgentId);
							if (!found) {
								handled();
								continue;
							}
							if (!dedupe.firstTime(found.dedupeKey, DEDUPE_WINDOW_MS)) {
								handled(); // duplicate delivery: already handled
								continue;
							}
							let acked = false;
							onWake(asWake(found, async () => {
								if (!acked) {
									acked = true;
									handled();
								}
							}));
						}
					} catch {
						// the stream broke; ending below marks the source dead
					}
					source.#dead.abort();
				})();
			}
		} catch (error) {
			await connection.close().catch(() => {});
			throw error;
		}
		return source;
	}

	async close(): Promise<void> {
		this.#dead.abort();
		await this.#connection.close().catch(() => {});
	}
}

/** The domain provisions an agent's consumers asynchronously (first contact, broker restart): wait for them instead of failing the transport. */
async function attachConsumer<T>(get: () => Promise<T>, what: string): Promise<T> {
	const deadline = Date.now() + CONSUMER_ATTACH_MS;
	for (;;) {
		try {
			return await get();
		} catch (error) {
			if (Date.now() >= deadline) throw new Error(`cannot attach to consumer ${what}: ${error instanceof Error ? error.message : String(error)}`);
			await sleep(250);
		}
	}
}

const PAGE = 500;

/** Tells the domain how far this principal has handled its events, at most once per interval: its stored cursor is what an HTTP lookup starts from. */
export class CursorAcks {
	readonly #client: SomeWorkClient;
	readonly #everyMs: number;
	#newest = 0;
	#sent = 0;
	#timer: NodeJS.Timeout | undefined;

	constructor(client: SomeWorkClient, everyMs = 5_000) {
		this.#client = client;
		this.#everyMs = everyMs;
	}

	note(eventSeq: number): void {
		if (eventSeq <= this.#newest) return;
		this.#newest = eventSeq;
		this.#schedule();
	}

	#schedule(): void {
		if (this.#timer !== undefined) return;
		this.#timer = setTimeout(() => void this.flush(), this.#everyMs);
		this.#timer.unref();
	}

	/** Sends the newest position now (shutdown, tests); a failed send is tried again at the next interval. */
	async flush(): Promise<void> {
		if (this.#timer !== undefined) clearTimeout(this.#timer);
		this.#timer = undefined;
		const upTo = this.#newest;
		if (upTo <= this.#sent) return;
		try {
			await this.#client.ackEvents(upTo);
			this.#sent = upTo;
		} catch {
			this.#schedule();
		}
	}
}

/** Looks at the domain's event feed over plain, short HTTP requests (never held open). */
class HttpWakes {
	readonly #client: SomeWorkClient;
	#cursor: number | undefined;
	readonly #fromHead: boolean;

	constructor(client: SomeWorkClient, fromHead: boolean) {
		this.#client = client;
		this.#fromHead = fromHead;
	}

	/**
	 * Moves to the newest event. The domain answers a request without `after` from this principal's stored cursor, which only moves when somebody
	 * acknowledges it: a principal that has been woken over NATS for days has an old one, and one page of it is not "the head". Pages are read
	 * until one is not full, and the stored cursor is brought up to the head so it does not stay behind.
	 */
	async toHead(): Promise<void> {
		let cursor = this.#cursor;
		for (let page = 0; page < 1000; page++) {
			const { events, cursor: next } = await this.#client.events(cursor, 0, PAGE);
			cursor = next;
			if (events.length < PAGE) break;
		}
		this.#cursor = cursor;
		if (cursor !== undefined && cursor > 0) await this.#client.ackEvents(cursor).catch(() => {});
	}

	async look(): Promise<Wake[]> {
		const first = this.#cursor === undefined;
		if (first && this.#fromHead) {
			await this.toHead();
			return [];
		}
		const { events, cursor } = await this.#client.events(this.#cursor, 0);
		this.#cursor = cursor;
		const out: Wake[] = [];
		for (const event of events) {
			if (event.wake !== true) continue;
			const seq = typeof event.seq === "number" ? event.seq : cursor;
			const ack = async () => {
				await this.#client.ackEvents(seq).catch(() => {});
			};
			if (String(event.type ?? "") === "message.created" && typeof event.payload?.messageId === "string") {
				out.push({ kind: "message", messageId: event.payload.messageId, dedupeKey: `msg:${event.payload.messageId}`, ack });
			}
		}
		return out;
	}
}

/**
 * Delivers message wakes to `onWake` until `signal` aborts. NATS gives low latency and keeps what came while the agent was down (a durable
 * consumer, acknowledged by the caller). When NATS is unavailable or a consumer stream ends, short HTTP lookups of the event feed every
 * `pollEveryMs` keep the principal working while the NATS source is rebuilt with jittered exponential backoff. A wake arriving over both paths is
 * delivered once; callers that must not lose a message also read the domain's inbox themselves.
 */
export async function runWakes(client: SomeWorkClient, signal: AbortSignal, onWake: (wake: Wake) => void, options: WakeOptions = {}): Promise<void> {
	const log = options.logger ?? (() => {});
	const pollEveryMs = options.pollEveryMs ?? 2_000;
	const seenOverBoth = new Dedupe();
	const deliver = (wake: Wake) => {
		if (seenOverBoth.firstTime(wake.dedupeKey, DEDUPE_WINDOW_MS)) onWake(wake);
		else void wake.ack();
	};
	const look = async (http: HttpWakes) => {
		try {
			for (const wake of await http.look()) deliver(wake);
			return true;
		} catch (error) {
			if (!signal.aborted) log("warn", "looking for messages failed", { error: String(error) });
			return false;
		}
	};

	if (options.mode === "poll") {
		const http = new HttpWakes(client, false);
		const backoff = new Backoff(pollEveryMs, 30_000);
		while (!signal.aborted) {
			const healthy = await look(http);
			if (healthy) backoff.reset();
			await sleep(healthy ? jittered(pollEveryMs) : backoff.nextDelayMs(), signal);
		}
		return;
	}

	const backoff = new Backoff(1_000, 30_000);
	const http = new HttpWakes(client, true);
	const acks = new CursorAcks(client, options.cursorAckEveryMs);
	// a principal that has been woken over NATS only has a stored cursor from the last time it polled: bring it up to date now, so a broker outage later starts from here
	void new HttpWakes(client, true).toHead().catch(() => {});
	signal.addEventListener("abort", () => void acks.flush(), { once: true });
	while (!signal.aborted) {
		let source: NatsWakeSource | undefined;
		let unavailable = "the domain offers no NATS";
		let offered = false;
		try {
			const info = natsInfoFrom(await client.connection());
			offered = info !== undefined;
			if (info) {
				source = await NatsWakeSource.connect(info, client.identity.agentId, client.tls, deliver, (eventSeq) => acks.note(eventSeq));
				backoff.reset();
			}
		} catch (error) {
			unavailable = error instanceof Error ? error.message : String(error);
		}
		if (!source) {
			const delay = backoff.nextDelayMs();
			log(offered ? "warn" : "info", "NATS wake unavailable; polling over HTTP meanwhile", { reason: unavailable, retryInMs: Math.round(delay) });
			const until = Date.now() + delay;
			while (!signal.aborted && Date.now() < until) {
				await look(http);
				await sleep(Math.min(jittered(pollEveryMs), Math.max(0, until - Date.now())), signal);
			}
			continue;
		}
		log("info", "NATS wake connected");
		try {
			await new Promise<void>((resolve) => AbortSignal.any([signal, source!.dead]).addEventListener("abort", () => resolve(), { once: true }));
		} finally {
			await source.close();
		}
		if (!signal.aborted) log("warn", "NATS wake lost; falling back to HTTP and reconnecting");
	}
}

/** The same wakes as an async iterable, for requester-style services (e.g. a chat bridge that reacts to its inbox). Ends when `signal` aborts. */
export async function* wakes(client: SomeWorkClient, signal: AbortSignal, options: WakeOptions = {}): AsyncGenerator<Wake> {
	const queue: Wake[] = [];
	let notify: (() => void) | undefined;
	const stopped = new AbortController();
	const both = AbortSignal.any([signal, stopped.signal]);
	const running = runWakes(client, both, (wake) => {
		queue.push(wake);
		notify?.();
	}, options);
	try {
		while (!signal.aborted) {
			const next = queue.shift();
			if (next) {
				yield next;
				continue;
			}
			await new Promise<void>((resolve) => {
				notify = resolve;
				signal.addEventListener("abort", () => resolve(), { once: true });
			});
			notify = undefined;
		}
	} finally {
		stopped.abort();
		await running;
	}
}

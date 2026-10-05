import { jetstream } from "@nats-io/jetstream";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { Backoff, jittered, sleep } from "./backoff.ts";
import type { SomeWorkClient } from "./client.ts";

/** Something that may need this principal's attention. Delivery is at-least-once; `ack` tells the transport it was handled. */
export type Wake = { dedupeKey: string; ack(): Promise<void> } & (
	| { kind: "task"; taskId: string }
	| { kind: "message"; messageId: string }
	| { kind: "taskEvent"; taskId: string; event: string }
);

export type WakeKind = Wake["kind"];

export interface WakeOptions {
	/** `auto`: NATS when the domain offers it, HTTP polling otherwise. `poll`: never NATS. */
	mode?: "auto" | "poll";
	/** Which wakes the caller wants. Workers only need `task`; asking for less keeps broker and event traffic down. */
	kinds?: readonly WakeKind[];
	/** How often queued tasks are looked up over HTTP while NATS is healthy, so a lost notification only costs latency. */
	sweepEveryMs?: number;
	/** Interval of the short HTTP lookups used while NATS is unavailable or disabled. */
	pollEveryMs?: number;
	logger?: (level: "debug" | "info" | "warn", message: string, fields?: Record<string, unknown>) => void;
}

const DEDUPE_WINDOW_MS = 120_000;
const POLLED_TASK_WINDOW_MS = 2_000;
const CONSUMER_ATTACH_MS = 15_000;

const noAck = async (): Promise<void> => {};

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

export interface PoolConsumer {
	stream: string;
	consumer: string;
}

/** Connection details of the NATS plane as returned by `GET /v1/connection`. */
export interface NatsInfo {
	url: string;
	user?: string;
	password?: string;
	token?: string;
	workStream: string;
	inboxStream: string;
	poolConsumers: PoolConsumer[];
	inboxConsumer?: string;
}

const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

export function natsInfoFrom(connection: any): NatsInfo | undefined {
	const nats = connection?.nats;
	if (!nats || typeof nats !== "object") return undefined;
	const url = text(nats.url) ?? text(nats.urls?.[0]);
	if (!url) return undefined;
	const workStream = text(nats.workStream) ?? "SOMEWORK_WORK";
	const poolConsumers: PoolConsumer[] = [];
	for (const entry of nats.poolConsumers ?? []) {
		if (typeof entry === "string") poolConsumers.push({ stream: workStream, consumer: entry });
		else if (text(entry?.consumer)) poolConsumers.push({ stream: text(entry.stream) ?? workStream, consumer: entry.consumer });
	}
	return {
		url,
		user: text(nats.user),
		password: text(nats.password),
		token: text(nats.token),
		workStream,
		inboxStream: text(nats.inboxStream) ?? "SOMEWORK_INBOX",
		poolConsumers,
		inboxConsumer: text(nats.inboxConsumer),
	};
}

type Interpreted = { kind: WakeKind; taskId?: string; messageId?: string; event?: string; dedupeKey: string };

/** Maps a JetStream notification to a wake; `undefined` means "acknowledge and ignore" (the agent's own output, items that must not wake it). */
export function interpret(payload: any, inbox: boolean, ownAgentId: string): Interpreted | undefined {
	if (inbox) {
		if (payload?.wake !== true || payload.sender === ownAgentId) return undefined;
		if (payload.kind === "message" && typeof payload.messageId === "string") return { kind: "message", messageId: payload.messageId, dedupeKey: `msg:${payload.messageId}` };
		if (payload.kind === "task" && typeof payload.taskId === "string") {
			return { kind: "taskEvent", taskId: payload.taskId, event: String(payload.event ?? ""), dedupeKey: `evt:${payload.eventId ?? payload.taskId}` };
		}
		return undefined;
	}
	if (typeof payload?.taskId !== "string") return undefined;
	return { kind: "task", taskId: payload.taskId, dedupeKey: `task:${payload.taskId}:${payload.revision}` };
}

const asWake = (found: Interpreted, ack: () => Promise<void>): Wake => {
	const { kind, dedupeKey } = found;
	if (kind === "task") return { kind, taskId: found.taskId!, dedupeKey, ack };
	if (kind === "message") return { kind, messageId: found.messageId!, dedupeKey, ack };
	return { kind, taskId: found.taskId!, event: found.event!, dedupeKey, ack };
};

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
	static async connect(info: NatsInfo, ownAgentId: string, tls: SomeWorkClient["tls"], onWake: (wake: Wake) => void, kinds: readonly WakeKind[] = ["task", "message", "taskEvent"]): Promise<NatsWakeSource> {
		const secure = tls.requireTls || tls.caPem !== undefined || info.url.startsWith("tls://");
		const connection = await connect({
			servers: info.url.replace(/^(nats|tls):\/\//, ""),
			...(info.user !== undefined && info.password !== undefined ? { user: info.user, pass: info.password } : info.token !== undefined ? { token: info.token } : {}),
			...(secure ? { tls: tls.caPem ? { ca: tls.caPem } : {} } : {}),
			reconnect: false,
			timeout: 10_000,
		});
		const source = new NatsWakeSource(connection);
		try {
			const js = jetstream(connection);
			const dedupe = new Dedupe();
			const wanted: { stream: string; name: string; inbox: boolean }[] = [];
			if (kinds.includes("task")) for (const c of info.poolConsumers) wanted.push({ stream: c.stream, name: c.consumer, inbox: false });
			if (info.inboxConsumer && (kinds.includes("message") || kinds.includes("taskEvent"))) wanted.push({ stream: info.inboxStream, name: info.inboxConsumer, inbox: true });
			for (const { stream, name, inbox } of wanted) {
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
							const found = interpret(payload, inbox, ownAgentId);
							if (!found || !kinds.includes(found.kind)) {
								message.ack();
								continue;
							}
							if (!dedupe.firstTime(found.dedupeKey, DEDUPE_WINDOW_MS)) {
								message.ack(); // duplicate delivery: already handled
								continue;
							}
							let acked = false;
							onWake(asWake(found, async () => {
								if (!acked) {
									acked = true;
									message.ack();
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

/** Looks at the domain over plain, short HTTP requests (never held open). */
class HttpWakes {
	readonly #client: SomeWorkClient;
	readonly #kinds: readonly WakeKind[];
	readonly #dedupe = new Dedupe();
	#cursor: number | undefined;
	readonly #fromHead: boolean;

	constructor(client: SomeWorkClient, kinds: readonly WakeKind[], fromHead: boolean) {
		this.#client = client;
		this.#kinds = kinds;
		this.#fromHead = fromHead;
	}

	async look(signal: AbortSignal): Promise<Wake[]> {
		const out: Wake[] = [];
		if (this.#kinds.includes("message") || this.#kinds.includes("taskEvent")) out.push(...(await this.#events()));
		if (this.#kinds.includes("task")) out.push(...(await this.sweep(signal)));
		return out;
	}

	/** Queued tasks only. Used next to NATS as a safety net. */
	async sweep(signal: AbortSignal): Promise<Wake[]> {
		const out: Wake[] = [];
		for (const entry of await this.#client.nextTasks(0, signal)) {
			const key = `task:${entry.taskId}:${entry.revision}`;
			if (this.#dedupe.firstTime(key, POLLED_TASK_WINDOW_MS)) out.push({ kind: "task", taskId: entry.taskId, dedupeKey: key, ack: noAck });
		}
		return out;
	}

	async #events(): Promise<Wake[]> {
		const first = this.#cursor === undefined;
		const { events, cursor } = await this.#client.events(this.#cursor, 0);
		this.#cursor = cursor;
		if (first && this.#fromHead) return [];
		const out: Wake[] = [];
		for (const event of events) {
			if (event.wake !== true) continue;
			const seq = typeof event.seq === "number" ? event.seq : cursor;
			const ack = async () => {
				await this.#client.ackEvents(seq).catch(() => {});
			};
			const type = String(event.type ?? "");
			if (type === "message.created" && typeof event.payload?.messageId === "string" && this.#kinds.includes("message")) {
				out.push({ kind: "message", messageId: event.payload.messageId, dedupeKey: `msg:${event.payload.messageId}`, ack });
			} else if (type.startsWith("task.") && typeof event.taskId === "string" && this.#kinds.includes("taskEvent")) {
				out.push({ kind: "taskEvent", taskId: event.taskId, event: type, dedupeKey: `evt:${event.eventId ?? ""}`, ack });
			}
		}
		return out;
	}
}

/**
 * Delivers wakes to `onWake` until `signal` aborts. NATS gives low latency; HTTP is the safety net:
 * - while NATS is healthy, queued tasks are looked up every `sweepEveryMs` (jittered), so a lost, delayed or purged notification only adds latency;
 * - when NATS is unavailable or a consumer stream ends, short HTTP lookups every `pollEveryMs` keep the principal working while the NATS source is rebuilt with jittered exponential backoff;
 * - message and task-event wakes arriving over both paths are delivered once. Task wakes are not deduplicated here: claims are fenced and idempotent.
 */
export async function runWakes(client: SomeWorkClient, signal: AbortSignal, onWake: (wake: Wake) => void, options: WakeOptions = {}): Promise<void> {
	const log = options.logger ?? (() => {});
	const kinds = options.kinds ?? ["task", "message", "taskEvent"];
	const sweepEveryMs = options.sweepEveryMs ?? 25_000;
	const pollEveryMs = options.pollEveryMs ?? 2_000;
	const seenOverBoth = new Dedupe();
	const deliver = (wake: Wake) => {
		if (wake.kind === "task" || seenOverBoth.firstTime(wake.dedupeKey, DEDUPE_WINDOW_MS)) onWake(wake);
		else void wake.ack();
	};
	const lookup = async (http: HttpWakes, what: "look" | "sweep") => {
		try {
			for (const wake of await (what === "look" ? http.look(signal) : http.sweep(signal))) deliver(wake);
			return true;
		} catch (error) {
			if (!signal.aborted) log("warn", "looking for work failed", { error: String(error) });
			return false;
		}
	};

	if (options.mode === "poll") {
		const http = new HttpWakes(client, kinds, false);
		const backoff = new Backoff(pollEveryMs, 30_000);
		while (!signal.aborted) {
			const healthy = await lookup(http, "look");
			if (healthy) backoff.reset();
			await sleep(healthy ? jittered(pollEveryMs) : backoff.nextDelayMs(), signal);
		}
		return;
	}

	const backoff = new Backoff(1_000, 30_000);
	const http = new HttpWakes(client, kinds, true);
	while (!signal.aborted) {
		let source: NatsWakeSource | undefined;
		let unavailable = "the domain offers no NATS";
		let offered = false;
		try {
			const info = natsInfoFrom(await client.connection());
			offered = info !== undefined;
			if (info) {
				source = await NatsWakeSource.connect(info, client.identity.agentId, client.tls, deliver, kinds);
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
				await lookup(http, "look");
				await sleep(Math.min(jittered(pollEveryMs), Math.max(0, until - Date.now())), signal);
			}
			continue;
		}
		log("info", "NATS wake connected");
		const lost = AbortSignal.any([signal, source.dead]);
		try {
			while (!lost.aborted) {
				await lookup(http, "sweep");
				await sleep(jittered(sweepEveryMs), lost);
			}
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

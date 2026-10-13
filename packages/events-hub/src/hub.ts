import { randomUUID } from "node:crypto";
import type { ForwardConfig, HubConfig, SourceConfig } from "./config.ts";
import { Clock } from "./clock.ts";
import { Timers } from "./timers.ts";
import { Watches } from "./watches.ts";
import { hookToken, safeEqual } from "./derive.ts";
import type { Forwarder } from "./forwarder.ts";
import { silent, type Log } from "./log.ts";
import { MappingEngine, parseBody } from "./mapping.ts";
import { Metrics } from "./metrics.ts";
import type { Publisher } from "./publisher.ts";
import type { PulledItem, ReceiverApi } from "./receiver-client.ts";
import type { Store } from "./store.ts";
import { PermanentError, TransientError, type Outcome, type RawItem } from "./types.ts";

const DEAD_LETTER_RETENTION_MS = 24 * 3_600_000;
const MAX_BACKOFF_MS = 60_000;

export interface HubDeps {
	config: HubConfig;
	secret: string;
	store: Store;
	receiver: ReceiverApi;
	publisher: Publisher;
	forwarder: Forwarder;
	mappings: MappingEngine;
	log?: Log;
	now?: () => number;
	sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

class Stopped extends Error {}

const defaultSleep = (ms: number, signal: AbortSignal): Promise<void> =>
	new Promise((resolve) => {
		const timer = setTimeout(done, ms);
		function done() {
			clearTimeout(timer);
			signal.removeEventListener("abort", done);
			resolve();
		}
		signal.addEventListener("abort", done, { once: true });
	});

export const backoffMs = (attempt: number): number => Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(attempt - 1, 6));

/** The private-side pipeline: item in, event(s) published, item acknowledged. Every item ends published, dropped with a counted reason, forwarded, or in the dead-letter store. */
const SHAPE_VALUES = ["transition", "status", "alert_transition", "alert_status", "event_type", "type", "action", "event"];

/** What a delivery that produced no event looked like, for the log: its top-level key names and, for the few keys that say what kind of notification it is, a short value. Nothing else of the body. */
export function shapeOf(body: unknown): { keys: string[]; values: Record<string, string> } | string {
	if (typeof body !== "object" || body === null || Array.isArray(body)) return Array.isArray(body) ? "array" : typeof body;
	const record = body as Record<string, unknown>;
	const values: Record<string, string> = {};
	for (const key of Object.keys(record)) {
		if (SHAPE_VALUES.includes(key.toLowerCase()) && (typeof record[key] === "string" || typeof record[key] === "number")) values[key] = String(record[key]).replace(/[^\w .:/-]/g, "?").slice(0, 40);
	}
	return { keys: Object.keys(record).slice(0, 40).map((key) => key.slice(0, 40)), values };
}

/** `shapeOf` as flat log fields: the logger turns an object into "[object]", which is how the key names of an unmapped delivery once never reached the log. */
export function shapeFields(body: unknown): { shape: string } | { keys: string; values: string } {
	const shape = shapeOf(body);
	if (typeof shape === "string") return { shape };
	return { keys: shape.keys.join(","), values: Object.entries(shape.values).map(([key, value]) => `${key}=${value}`).join(",") };
}

export class Hub {
	readonly metrics = new Metrics();
	readonly clock: Clock | undefined;
	readonly timers: Timers | undefined;
	readonly watches: Watches | undefined;
	readonly #deps: HubDeps;
	readonly #log: Log;
	readonly #sleep: (ms: number, signal: AbortSignal) => Promise<void>;
	readonly #sources = new Map<string, SourceConfig>();
	readonly #abort = new AbortController();
	readonly #loops: Promise<void>[] = [];
	readonly #received;
	readonly #published;
	readonly #duplicates;
	readonly #dropped;
	readonly #unmapped;
	readonly #deadLettered;
	readonly #failures;
	readonly #forwarded;
	readonly #ticks;
	readonly #timerEvents;
	readonly #timersPending;
	readonly #watchEvents;
	readonly #watchesActive;
	readonly #pending;
	readonly #oldest;
	readonly #queued;
	readonly #receiverUp;
	readonly #inboxSize;
	#inboxWake: (() => void) | undefined;
	#receiverSeen: { queued: number; oldestAgeSeconds: number } | null = null;

	constructor(deps: HubDeps) {
		this.#deps = deps;
		this.#log = deps.log ?? silent;
		this.#sleep = deps.sleep ?? defaultSleep;
		for (const source of deps.config.sources) this.#sources.set(source.name, source);
		const m = this.metrics;
		this.#received = m.counter("hub_events_received_total", "Webhooks taken from the receiver or the internal listener, by source.");
		this.#published = m.counter("hub_events_published_total", "Events accepted by the domain, by source.");
		this.#duplicates = m.counter("hub_events_duplicate_total", "Events the domain already had (same key), by source.");
		this.#dropped = m.counter("hub_events_dropped_total", "Webhooks that produced no event, by source and reason.");
		this.#unmapped = m.counter("hub_events_unmapped_total", "Webhooks the mapping turned into no event without naming a reason (also counted in hub_events_dropped_total{reason=\"no_event\"}), by source.");
		this.#deadLettered = m.counter("hub_events_dead_lettered_total", "Webhooks moved to the dead-letter store, by source and kind.");
		this.#failures = m.counter("hub_publish_failures_total", "Failed attempts to publish or forward, by source and kind (transient or permanent).");
		this.#forwarded = m.counter("hub_forwarded_total", "Webhooks replayed to a private target, by source.");
		this.#ticks = m.counter("hub_clock_ticks_total", "Clock ticks, by schedule and outcome.");
		this.#timerEvents = m.counter("hub_timers_total", "Timers that came due, by agent and outcome.");
		this.#timersPending = m.gauge("hub_timers_pending", "Timers waiting to come due.");
		this.#watchEvents = m.counter("hub_watch_events_total", "Events re-published to an agent that watches a pull request, by agent.");
		this.#watchesActive = m.gauge("hub_watches_active", "Watches on pull requests that have not ended.");
		this.#pending = m.gauge("hub_dead_letters", "Dead letters waiting for a replay, by source.");
		this.#oldest = m.gauge("hub_receiver_oldest_pending_age_seconds", "Age of the oldest webhook still queued at the receiver.");
		this.#queued = m.gauge("hub_receiver_queued", "Webhooks queued at the receiver.");
		this.#receiverUp = m.gauge("hub_receiver_up", "1 when the last call to the receiver worked.");
		this.#inboxSize = m.gauge("hub_inbox_size", "Webhooks of the internal listener waiting to be processed.");
		this.clock = deps.config.clock.schedules.length
			? new Clock({
					schedules: deps.config.clock.schedules,
					store: deps.store,
					now: deps.now,
					log: this.#log,
					publish: (event, occurredAt) => this.#publishClock(event, occurredAt),
					onTick: (schedule, missed, published) => this.#ticks({ schedule, outcome: published ? (missed ? "published_late" : "published") : "skipped" }),
				})
			: undefined;
		this.timers = deps.config.timers
			? new Timers({
					config: deps.config.timers,
					store: deps.store,
					now: deps.now,
					log: this.#log,
					publish: (event, occurredAt) => this.#publishClock(event, occurredAt),
					onFire: (agent, outcome, late) => this.#timerEvents({ agent, outcome: outcome === "published" && late ? "published_late" : outcome }),
				})
			: undefined;
		this.watches = deps.config.watches
			? new Watches({ config: deps.config.watches, store: deps.store, now: deps.now, log: this.#log, onDelivery: (agent) => this.#watchEvents({ agent }) })
			: undefined;
	}

	async #publishWatch(source: string, event: Parameters<Publisher["publish"]>[1], occurredAt: string): Promise<void> {
		const result = await this.#deps.publisher.publish(source, event, occurredAt);
		this.#log("info", result.duplicate ? "watch_event_duplicate" : "watch_event_published", { topic: event.topic, seq: result.seq });
	}

	async #publishClock(event: Parameters<Publisher["publish"]>[1], occurredAt: string): Promise<{ duplicate: boolean }> {
		const result = await this.#deps.publisher.publish("clock", event, occurredAt);
		this.#published({ source: "clock" });
		if (result.duplicate) this.#duplicates({ source: "clock" });
		return result;
	}

	// ---- one item -------------------------------------------------------------------------------------------------------------------
	/** Throws TransientError when the item should be tried again later and PermanentError when it can never succeed. */
	async process(item: RawItem): Promise<Outcome> {
		const source = this.#sources.get(item.source);
		if (!source) return { kind: "dropped", reason: "unknown_source" };
		if (this.#deps.store.isPaused(source.name)) return { kind: "dropped", reason: "paused" };
		if (source.forward) {
			await this.#deps.forwarder.forward(source.forward, item);
			return { kind: "forwarded" };
		}
		const input = { headers: item.headers, body: parseBody(item), receivedAt: item.receivedAt, source: source.name, defaults: source.defaults ?? {} };
		const { events, rejected } = await this.#deps.mappings.run(source.mapping!, source.name, input, source.classification ?? this.#deps.config.defaultClassification);
		for (const reason of rejected) {
			this.#dropped({ source: source.name, reason });
			this.#log("warn", "event_dropped", { source: source.name, id: item.id, reason });
		}
		if (events.length === 0) {
			if (rejected.length === 0) {
				this.#unmapped({ source: source.name });
				this.#log("info", "event_unmapped", { source: source.name, id: item.id, ...shapeFields(input.body) });
			}
			return { kind: "dropped", reason: rejected[0] ?? "no_event" };
		}
		let duplicates = 0;
		for (const event of events) {
			const result = await this.#deps.publisher.publish(source.name, event, item.receivedAt);
			if (result.duplicate) duplicates++;
			this.#log("info", result.duplicate ? "event_duplicate" : "event_published", { source: source.name, topic: event.topic, seq: result.seq });
		}
		if (this.watches && source.name === this.watches.source) await this.watches.relay(events, item.receivedAt, (event, occurredAt) => this.#publishWatch(source.name, event, occurredAt));
		return { kind: "published", events: events.length, duplicates };
	}

	#record(item: RawItem, outcome: Outcome): void {
		const source = item.source;
		if (outcome.kind === "published") {
			this.#published({ source }, outcome.events - outcome.duplicates);
			if (outcome.duplicates > 0) this.#duplicates({ source }, outcome.duplicates);
		} else if (outcome.kind === "dropped") {
			this.#dropped({ source, reason: outcome.reason });
			this.#log("info", "event_dropped", { source, id: item.id, reason: outcome.reason });
		} else if (outcome.kind === "forwarded") {
			this.#forwarded({ source });
			this.#log("info", "webhook_forwarded", { source, id: item.id });
		}
	}

	#deadLetter(item: RawItem, kind: "mapping" | "publish" | "forward", message: string, attempts: number): Outcome {
		this.#deps.store.addDeadLetter(item, kind, message, attempts);
		this.#deadLettered({ source: item.source, kind });
		this.#log("error", "event_dead_lettered", { source: item.source, id: item.id, kind, attempts, error: message });
		return { kind: "dead_lettered", reason: kind };
	}

	/** Tries an item until it is done: transient failures back off and retry (up to maxAttempts), permanent ones are dead-lettered. */
	async handle(item: RawItem): Promise<Outcome> {
		let attempt = 0;
		for (;;) {
			if (this.#abort.signal.aborted) throw new Stopped();
			try {
				const outcome = await this.process(item);
				this.#record(item, outcome);
				return outcome;
			} catch (error) {
				if (error instanceof PermanentError) {
					this.#failures({ source: item.source, kind: "permanent" });
					return this.#deadLetter(item, error.kind, error.message, attempt + 1);
				}
				attempt++;
				const message = error instanceof Error ? error.message : String(error);
				this.#failures({ source: item.source, kind: "transient" });
				if (attempt >= this.#deps.config.maxAttempts) return this.#deadLetter(item, error instanceof TransientError ? "publish" : "mapping", `gave up after ${attempt} attempts: ${message}`, attempt);
				this.#log("warn", "event_retry", { source: item.source, id: item.id, attempt, error: message });
				await this.#sleep(backoffMs(attempt), this.#abort.signal);
			}
		}
	}

	/** Re-runs a dead letter once. On success it is marked replayed; otherwise the error is thrown and the letter stays. */
	async replayDeadLetter(id: string): Promise<Outcome> {
		const letter = this.#deps.store.deadLetter(id);
		if (!letter) throw new Error(`no dead letter ${id}`);
		const item: RawItem = { id: letter.id, source: letter.source, receivedAt: letter.receivedAt, headers: letter.headers, body: letter.body, path: letter.path, query: letter.query };
		const outcome = await this.process(item);
		this.#record(item, outcome);
		this.#deps.store.markReplayed(id);
		this.#log("info", "dead_letter_replayed", { id, source: item.source, outcome: outcome.kind });
		return outcome;
	}

	// ---- the internal listener --------------------------------------------------------------------------------------------------------
	acceptInternal(name: string, token: string, headers: Record<string, string>, body: Buffer): { status: 202; id: string } | { status: 401 | 404 | 400 } {
		const source = this.#sources.get(name);
		if (!source?.internal || this.#deps.store.isPaused(name)) return { status: 404 };
		if (!safeEqual(token, hookToken(this.#deps.secret, source.name, source.version))) return { status: 401 };
		if (body.length === 0) return { status: 400 };
		const id = randomUUID();
		this.#deps.store.enqueueInbox({ id, source: name, receivedAt: new Date((this.#deps.now ?? Date.now)()).toISOString(), headers, body, path: "", query: "" });
		this.#inboxWake?.();
		this.#log("info", "hook_accepted", { source: name, id, bytes: body.length });
		return { status: 202, id };
	}

	async setSourcePaused(name: string, paused: boolean): Promise<void> {
		const source = this.#sources.get(name);
		if (!source) throw new Error(`unknown source ${name}`);
		this.#deps.store.setPaused(name, paused);
		this.#log("info", "source_control", { source: name, paused });
		if (!source.internal) {
			try {
				await this.#deps.receiver.setPaused(name, paused);
			} catch (error) {
				this.#log("warn", "receiver_control_failed", { source: name, error });
			}
		}
	}

	/** The operator's overview: source switches, the clock's next runs, and what the last stats call to the receiver reported (nulls when it failed). */
	adminStats(): { sources: { name: string; paused: boolean }[]; schedules: { name: string; nextRunAt: string | null }[]; receiver: { queued: number | null; oldestAgeSeconds: number | null; reachable: boolean } } {
		const seen = this.#receiverSeen;
		return {
			sources: [...this.#sources.keys()].map((name) => ({ name, paused: this.#deps.store.isPaused(name) })),
			schedules: this.clock?.nextRuns() ?? [],
			receiver: { queued: seen?.queued ?? null, oldestAgeSeconds: seen?.oldestAgeSeconds ?? null, reachable: seen !== null },
		};
	}

	hasSource(name: string): boolean {
		return this.#sources.has(name);
	}

	// ---- loops --------------------------------------------------------------------------------------------------------------------------
	start(): void {
		this.#loops.push(this.#pullLoop(), this.#inboxLoop(), this.#maintenanceLoop());
		this.clock?.run();
		this.timers?.run();
		this.#log("info", "hub_started", { sources: this.#sources.size, schedules: this.#deps.config.clock.schedules.length });
	}

	async stop(): Promise<void> {
		this.#abort.abort();
		this.clock?.stop();
		this.timers?.stop();
		this.#inboxWake?.();
		await Promise.allSettled(this.#loops);
		this.#log("info", "hub_stopped", {});
	}

	async #pullLoop(): Promise<void> {
		const { receiver, store } = this.#deps;
		let cursor = store.cursor();
		let failures = 0;
		const signal = this.#abort.signal;
		try {
			cursor = await this.#sanityCheck(cursor);
		} catch {
			// the receiver may be down at startup; the loop below retries
		}
		while (!signal.aborted) {
			let items: PulledItem[];
			try {
				items = await receiver.pull(cursor, 50, this.#deps.config.receiver.waitSeconds, signal);
				failures = 0;
				this.#receiverUp.set(1);
			} catch (error) {
				if (signal.aborted) break;
				failures++;
				this.#receiverUp.set(0);
				this.#log("warn", "receiver_unavailable", { error, attempt: failures });
				await this.#sleep(backoffMs(failures), signal);
				continue;
			}
			let done = cursor;
			try {
				for (const item of items) {
					this.#received({ source: item.source });
					await this.handle(item);
					done = item.seq;
				}
			} catch (error) {
				if (!(error instanceof Stopped)) throw error;
			}
			if (done > cursor && (await this.#ack(done))) {
				cursor = done;
				store.setCursor(cursor);
			}
		}
	}

	async #sanityCheck(cursor: number): Promise<number> {
		if (cursor === 0) return 0;
		const { lastSeq } = await this.#deps.receiver.stats();
		if (lastSeq < cursor) {
			this.#log("warn", "cursor_reset", { cursor, receiverLastSeq: lastSeq });
			this.#deps.store.setCursor(0);
			return 0;
		}
		return cursor;
	}

	/** The receiver forgets an item once it is acknowledged, so the cursor only moves after that: a crash in between replays items, which their keys deduplicate. */
	async #ack(upTo: number): Promise<boolean> {
		for (let attempt = 1; !this.#abort.signal.aborted; attempt++) {
			try {
				await this.#deps.receiver.ack(upTo);
				return true;
			} catch (error) {
				this.#log("warn", "ack_failed", { error, attempt });
				await this.#sleep(backoffMs(attempt), this.#abort.signal);
			}
		}
		return false;
	}

	async #inboxLoop(): Promise<void> {
		const { store } = this.#deps;
		const signal = this.#abort.signal;
		while (!signal.aborted) {
			const rows = store.inbox(20);
			this.#inboxSize.set(store.inboxSize());
			this.#timersPending.set(store.pendingTimerCount());
			this.#watchesActive.set(store.activeWatchCount());
			if (rows.length === 0) {
				await new Promise<void>((resolve) => {
					const timer = setTimeout(resolve, 1000);
					this.#inboxWake = () => {
						clearTimeout(timer);
						resolve();
					};
				});
				continue;
			}
			try {
				for (const { seq, item } of rows) {
					this.#received({ source: item.source });
					await this.handle(item);
					store.inboxDone(seq);
				}
			} catch (error) {
				if (!(error instanceof Stopped)) throw error;
			}
		}
	}

	async #maintenanceLoop(): Promise<void> {
		const signal = this.#abort.signal;
		let lastPurge = 0;
		while (!signal.aborted) {
			try {
				const stats = await this.#deps.receiver.stats();
				this.#queued.set(stats.queued);
				this.#oldest.set(stats.oldestAgeSeconds);
				this.#receiverUp.set(1);
				this.#receiverSeen = { queued: stats.queued, oldestAgeSeconds: stats.oldestAgeSeconds };
			} catch {
				this.#receiverUp.set(0);
				this.#receiverSeen = null;
			}
			this.watches?.maintain();
			const counts = this.#deps.store.deadLetterCounts();
			for (const source of this.#sources.keys()) this.#pending.set(counts[source] ?? 0, { source });
			const now = (this.#deps.now ?? Date.now)();
			if (now - lastPurge > 600_000) {
				lastPurge = now;
				const expired = this.#deps.store.purgeDeadLetters(DEAD_LETTER_RETENTION_MS);
				if (expired > 0) this.#log("warn", "dead_letters_expired", { expired });
			}
			await this.#sleep(15_000, signal);
		}
	}
}

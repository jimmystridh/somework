import { randomBytes } from "node:crypto";
import type { TimersConfig } from "./config.ts";
import { silent, type Log } from "./log.ts";
import type { Store, TimerRow } from "./store.ts";
import type { Json, MappedEvent } from "./types.ts";

const KEY = /^[A-Za-z0-9:_./#-]{1,100}$/;
const MAX_NOTE_CHARS = 500;
const MAX_PAYLOAD_BYTES = 2048;
const FIRE_BATCH = 50;
const RETRY_AFTER_FAILURE_MS = 10_000;
const KEEP_FIRED_MS = 7 * 86_400_000;

export interface TimerRequest {
	/** Seconds from now; give this or `at`. */
	delaySeconds?: unknown;
	/** An ISO time; give this or `delaySeconds`. */
	at?: unknown;
	/** Names the timer: asking again with the same key moves it instead of adding another, and it can be cancelled by it. Default: the generated id. */
	key?: unknown;
	/** Why the agent asked, in its own words (at most 500 characters). */
	note?: unknown;
	/** Small structured data the agent wants back (at most 2 KiB as JSON). */
	payload?: unknown;
}

export interface TimerView {
	id: string;
	key: string;
	dueAt: string;
	note: string;
	payload?: Json;
}

/** The topic an agent's timers arrive on: `clock.timer.<agent without the prefix, other characters as _>.due`, matched by a rule owned by that agent (topics may not contain hyphens). */
export const timerTopic = (agent: string): string => `clock.timer.${agent.slice("agent/".length).replace(/[^a-z0-9]/g, "_")}.due`;

export class TimerError extends Error {
	override readonly name = "TimerError";
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

export interface TimersDeps {
	config: TimersConfig;
	store: Store;
	/** Publishes as the clock's source; resolves with whether the domain already had the event. */
	publish(event: MappedEvent, occurredAt: string): Promise<{ duplicate: boolean }>;
	now?: () => number;
	log?: Log;
	onFire?(agent: string, outcome: "published" | "failed", late: boolean): void;
}

const view = (row: TimerRow): TimerView => ({ id: row.id, key: row.key, dueAt: new Date(row.dueAt).toISOString(), note: row.note, ...(row.payload === null ? {} : { payload: JSON.parse(row.payload) as Json }) });

/**
 * One-shot timers agents ask for ("trigger me with this in 15 minutes"). A due timer becomes the event `clock.timer.<agent>.due` with the key `timer:<id>`,
 * so a repeat after a crash is a duplicate; a timer that came due while the hub was down fires on the next tick, marked late. Progress is stored only
 * after the domain accepted the event. What the event does is up to the agent's rule and handler; the hub only keeps time.
 */
export class Timers {
	readonly #deps: TimersDeps;
	readonly #now: () => number;
	readonly #log: Log;
	#timer: NodeJS.Timeout | undefined;
	#ticking = false;
	#retryAt = 0;
	#lastPrune = 0;

	constructor(deps: TimersDeps) {
		this.#deps = deps;
		this.#now = deps.now ?? Date.now;
		this.#log = deps.log ?? silent;
	}

	mayAsk(agent: string): boolean {
		return this.#deps.config.agents.includes(agent);
	}

	request(agent: string, raw: TimerRequest): TimerView {
		if (!this.mayAsk(agent)) throw new TimerError(403, "this agent may not ask for timers");
		const { minDelaySeconds, maxDelaySeconds, maxPendingPerAgent } = this.#deps.config;
		const now = this.#now();
		if ((raw.delaySeconds === undefined) === (raw.at === undefined)) throw new TimerError(400, "give either delaySeconds or at");
		const dueAt = raw.delaySeconds !== undefined ? now + Number(raw.delaySeconds) * 1000 : Date.parse(String(raw.at));
		if (!Number.isFinite(dueAt) || (raw.delaySeconds !== undefined && !(Number(raw.delaySeconds) > 0))) throw new TimerError(400, "delaySeconds must be a number of seconds, at an ISO time");
		if (dueAt < now + minDelaySeconds * 1000) throw new TimerError(400, `a timer must be at least ${minDelaySeconds} seconds away`);
		if (dueAt > now + maxDelaySeconds * 1000) throw new TimerError(400, `a timer can be at most ${maxDelaySeconds} seconds away`);
		if (typeof raw.note !== "string" || raw.note.trim() === "") throw new TimerError(400, "note is required: say why you want to be woken");
		if (raw.note.length > MAX_NOTE_CHARS) throw new TimerError(400, `note is at most ${MAX_NOTE_CHARS} characters`);
		if (raw.key !== undefined && (typeof raw.key !== "string" || !KEY.test(raw.key))) throw new TimerError(400, "key is 1 to 100 letters, digits and : _ . / # -");
		let payload: string | null = null;
		if (raw.payload !== undefined) {
			payload = JSON.stringify(raw.payload) ?? null;
			if (payload !== null && Buffer.byteLength(payload) > MAX_PAYLOAD_BYTES) throw new TimerError(400, `payload is at most ${MAX_PAYLOAD_BYTES} bytes as JSON`);
		}
		const id = `tmr_${randomBytes(8).toString("hex")}`;
		const row = { id, agent, key: typeof raw.key === "string" ? raw.key : id, dueAt: Math.round(dueAt), note: raw.note.trim(), payload, createdAt: now };
		if (!this.#deps.store.putTimer(row, maxPendingPerAgent)) throw new TimerError(429, `${maxPendingPerAgent} timers are pending already: cancel one or wait for it`);
		this.#log("info", "timer_set", { agent, id, key: row.key, dueAt: new Date(row.dueAt).toISOString() });
		return view({ ...row, firedAt: null });
	}

	list(agent: string): TimerView[] {
		return this.#deps.store.pendingTimers(agent).map(view);
	}

	cancel(agent: string, idOrKey: string): boolean {
		const removed = this.#deps.store.cancelTimer(agent, idOrKey);
		if (removed) this.#log("info", "timer_cancelled", { agent, id: idOrKey });
		return removed;
	}

	pending(): number {
		return this.#deps.store.pendingTimerCount();
	}

	/** Fires what is due. Deterministic for a given clock; `run()` calls it every second. */
	async tick(now: number = this.#now()): Promise<number> {
		if (now < this.#retryAt) return 0;
		let fired = 0;
		for (const row of this.#deps.store.dueTimers(now, FIRE_BATCH)) {
			const late = now - row.dueAt > 5 * 60_000;
			const event: MappedEvent = {
				topic: timerTopic(row.agent),
				key: `timer:${row.id}`,
				classification: "internal",
				data: { timerId: row.id, key: row.key, agent: row.agent, note: row.note, ...(row.payload === null ? {} : { payload: JSON.parse(row.payload) as Json }), requestedAt: new Date(row.createdAt).toISOString(), dueAt: new Date(row.dueAt).toISOString(), late },
			};
			try {
				await this.#deps.publish(event, new Date(row.dueAt).toISOString());
			} catch (error) {
				this.#retryAt = now + RETRY_AFTER_FAILURE_MS;
				this.#deps.onFire?.(row.agent, "failed", late);
				this.#log("warn", "timer_publish_failed", { agent: row.agent, id: row.id, error });
				return fired;
			}
			this.#deps.store.markTimerFired(row.id, now);
			this.#deps.onFire?.(row.agent, "published", late);
			this.#log("info", "timer_fired", { agent: row.agent, id: row.id, key: row.key, late });
			fired++;
		}
		if (now - this.#lastPrune > 3_600_000) {
			this.#lastPrune = now;
			this.#deps.store.pruneTimers(now - KEEP_FIRED_MS);
		}
		return fired;
	}

	run(): void {
		const loop = async () => {
			if (this.#ticking) return;
			this.#ticking = true;
			try {
				await this.tick();
			} catch (error) {
				this.#log("error", "timer_tick_failed", { error });
			} finally {
				this.#ticking = false;
			}
		};
		this.#timer = setInterval(loop, 1000);
		void loop();
	}

	stop(): void {
		if (this.#timer) clearInterval(this.#timer);
	}
}

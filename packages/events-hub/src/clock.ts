import { createHash } from "node:crypto";
import type { ScheduleConfig } from "./config.ts";
import { assertTimeZone, isoWithOffset, localMinute, nextAfter, parseCron, typicalIntervalMs, type CronSpec } from "./cron.ts";
import { silent, type Log } from "./log.ts";
import type { Store } from "./store.ts";
import type { MappedEvent } from "./types.ts";

/** A tick later than this after its scheduled minute counts as missed, whatever the jitter. */
const ON_TIME_MS = 5 * 60_000;

interface Entry {
	config: ScheduleConfig;
	spec: CronSpec;
	missed: "run-once" | "skip";
}

export interface ClockDeps {
	schedules: ScheduleConfig[];
	store: Store;
	publish(event: MappedEvent, occurredAt: string): Promise<{ duplicate: boolean }>;
	now?: () => number;
	log?: Log;
	/** `published` is false when a missed tick was skipped by policy. */
	onTick?(schedule: string, missed: boolean, published: boolean): void;
}


/** Jitter is derived from the schedule and the minute, not drawn at random: a restart does not re-roll it. */
export function jitterMs(name: string, scheduled: number, jitterSeconds: number): number {
	if (jitterSeconds <= 0) return 0;
	const digest = createHash("sha256").update(`${name}:${scheduled}`).digest();
	return (digest.readUInt32BE(0) % (jitterSeconds * 1000 + 1));
}

/**
 * The clock producer. `tick(now)` is deterministic (an injectable clock drives it in tests); `run()` just calls it every second.
 * A tick is `clock.<name>.tick` with key `clock.<name>:<scheduled minute>`; progress is stored only after the domain accepted the event, and
 * a repeat after a crash is a duplicate by key.
 */
export class Clock {
	readonly #deps: ClockDeps;
	readonly #entries: Entry[];
	readonly #now: () => number;
	readonly #log: Log;
	#timer: NodeJS.Timeout | undefined;
	#ticking = false;

	constructor(deps: ClockDeps) {
		this.#deps = deps;
		this.#now = deps.now ?? Date.now;
		this.#log = deps.log ?? silent;
		this.#entries = deps.schedules.map((config) => {
			assertTimeZone(config.timeZone);
			const spec = parseCron(config.cron);
			const missed = config.missed === "auto" ? (typicalIntervalMs(spec, config.timeZone, this.#now()) < 3_600_000 ? "skip" : "run-once") : config.missed;
			return { config, spec, missed };
		});
	}

	async tick(now: number = this.#now()): Promise<number> {
		let published = 0;
		for (const entry of this.#entries) published += await this.#tickOne(entry, now);
		return published;
	}

	async #tickOne(entry: Entry, now: number): Promise<number> {
		const { config, spec, missed } = entry;
		const last = this.#deps.store.clockLast(config.name);
		if (last === undefined) {
			this.#deps.store.setClockLast(config.name, Math.floor(now / 60_000) * 60_000);
			return 0;
		}
		const due: number[] = [];
		for (let next = nextAfter(spec, config.timeZone, last); next !== null && next + jitterMs(config.name, next, config.jitterSeconds) <= now; next = nextAfter(spec, config.timeZone, next)) {
			due.push(next);
			if (due.length > 1000) break;
		}
		if (due.length === 0) return 0;
		const latest = due[due.length - 1]!;
		const late = now - (latest + jitterMs(config.name, latest, config.jitterSeconds)) > ON_TIME_MS;
		const olderSkipped = due.length - 1;
		if (olderSkipped > 0) this.#log("warn", "clock_missed_skipped", { schedule: config.name, skipped: olderSkipped });

		if (late && missed === "skip") {
			this.#log("warn", "clock_missed_skipped", { schedule: config.name, skipped: 1 });
			this.#deps.store.setClockLast(config.name, latest);
			this.#deps.onTick?.(config.name, true, false);
			return 0;
		}
		const event: MappedEvent = {
			topic: `clock.${config.name}.tick`,
			key: `clock.${config.name}:${localMinute(latest, config.timeZone)}`,
			classification: "public",
			data: { name: config.name, scheduledFor: isoWithOffset(latest, config.timeZone), missed: late },
		};
		const result = await this.#deps.publish(event, new Date(latest).toISOString());
		this.#deps.store.setClockLast(config.name, latest);
		this.#deps.onTick?.(config.name, late, true);
		this.#log("info", result.duplicate ? "clock_tick_duplicate" : "clock_tick", { schedule: config.name, scheduledFor: localMinute(latest, config.timeZone), missed: late });
		return 1;
	}

	/** The next scheduled minute of every schedule, with the zone's offset (jitter not included). */
	nextRuns(now: number = this.#now()): { name: string; nextRunAt: string | null }[] {
		return this.#entries.map(({ config, spec }) => {
			const next = nextAfter(spec, config.timeZone, now);
			return { name: config.name, nextRunAt: next === null ? null : isoWithOffset(next, config.timeZone) };
		});
	}

	run(): void {
		const loop = async () => {
			if (this.#ticking) return;
			this.#ticking = true;
			try {
				await this.tick();
			} catch (error) {
				this.#log("error", "clock_tick_failed", { error });
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

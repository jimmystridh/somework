import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Backoff, sleep, type SomeWorkClient } from "@somework/sdk";
import type { Log } from "../log.ts";
import type { EventProcessor } from "./processor.ts";
import type { FeedEvent } from "./types.ts";

const SEEN_KEEP = 5000;

export interface IntakeOptions {
	client: Pick<SomeWorkClient, "events">;
	processor: Pick<EventProcessor, "process">;
	/** Where the cursor and the ids already handled are kept. */
	dir: string;
	log: Log;
	/** Seconds a feed request is held open waiting for events (the domain answers as soon as one arrives). */
	waitSeconds?: number;
	/** For tests: the pause after a failure. */
	retry?: { initialMs: number; maxMs: number };
	/** An empty answer that came back sooner than this (a domain that ignores `wait`) is followed by a pause, so the loop never spins. Default 250. */
	idleMs?: number;
}

/**
 * Takes the events addressed to this agent from the domain's event feed and has each handled once. The agent keeps its own cursor on
 * disk and advances it only after an event was handled, so a crash handles the event again (the ids already handled are remembered, so
 * a repeat is skipped). It does not acknowledge the domain-side cursor: that one is shared with the agent's message wakes.
 */
export class EventIntake {
	readonly #o: IntakeOptions;
	readonly #cursorFile: string;
	readonly #seenFile: string;
	readonly #seen = new Set<string>();
	#order: string[] = [];
	#cursor = 0;

	constructor(options: IntakeOptions) {
		this.#o = options;
		mkdirSync(options.dir, { recursive: true });
		this.#cursorFile = join(options.dir, "cursor.json");
		this.#seenFile = join(options.dir, "seen.log");
	}

	get cursor(): number {
		return this.#cursor;
	}

	#load(): boolean {
		try {
			for (const id of readFileSync(this.#seenFile, "utf8").split("\n").filter(Boolean).slice(-SEEN_KEEP)) {
				this.#seen.add(id);
				this.#order.push(id);
			}
		} catch {
			// nothing handled yet
		}
		try {
			this.#cursor = (JSON.parse(readFileSync(this.#cursorFile, "utf8")) as { cursor: number }).cursor;
			return true;
		} catch {
			return false;
		}
	}

	#saveCursor(cursor: number): void {
		this.#cursor = cursor;
		writeFileSync(`${this.#cursorFile}.tmp`, JSON.stringify({ cursor }));
		renameSync(`${this.#cursorFile}.tmp`, this.#cursorFile);
	}

	#remember(id: string): void {
		this.#seen.add(id);
		this.#order.push(id);
		appendFileSync(this.#seenFile, `${id}\n`);
		if (this.#order.length > SEEN_KEEP * 2) {
			this.#order = this.#order.slice(-SEEN_KEEP);
			this.#seen.clear();
			for (const kept of this.#order) this.#seen.add(kept);
			writeFileSync(this.#seenFile, `${this.#order.join("\n")}\n`);
		}
	}

	/** First start: skip everything that already exists, so events from before this feature was turned on are not replayed. */
	async #fastForward(signal: AbortSignal): Promise<void> {
		let after: number | undefined;
		for (;;) {
			const page = await this.#o.client.events(after, 0);
			after = page.cursor;
			if (page.events.length === 0 || signal.aborted) break;
		}
		this.#saveCursor(after ?? 0);
		this.#o.log("info", "events_cursor_initialised", { cursor: this.#cursor });
	}

	async run(signal: AbortSignal): Promise<void> {
		const backoff = new Backoff(this.#o.retry?.initialMs ?? 1000, this.#o.retry?.maxMs ?? 30_000);
		if (!this.#load()) {
			while (!signal.aborted) {
				try {
					await this.#fastForward(signal);
					break;
				} catch (error) {
					this.#o.log("warn", "events_feed_failed", { error: String(error).slice(0, 160) });
					await sleep(backoff.nextDelayMs(), signal);
				}
			}
		}
		while (!signal.aborted) {
			try {
				const asked = Date.now();
				const page = await this.#o.client.events(this.#cursor, this.#o.waitSeconds ?? 25);
				backoff.reset();
				for (const event of page.events as FeedEvent[]) {
					if (signal.aborted) return;
					await this.#handle(event, signal);
				}
				if (page.events.length === 0 && page.cursor > this.#cursor) this.#saveCursor(page.cursor);
				if (page.events.length === 0) await sleep(Math.max(0, (this.#o.idleMs ?? 250) - (Date.now() - asked)), signal);
			} catch (error) {
				if (signal.aborted) return;
				this.#o.log("warn", "events_feed_failed", { error: String(error).slice(0, 160) });
				await sleep(backoff.nextDelayMs(), signal);
			}
		}
	}

	async #handle(event: FeedEvent, signal: AbortSignal): Promise<void> {
		if (!this.#seen.has(event.eventId)) {
			const retry = new Backoff(this.#o.retry?.initialMs ?? 1000, this.#o.retry?.maxMs ?? 30_000);
			for (;;) {
				try {
					await this.#o.processor.process(event);
					break;
				} catch (error) {
					if (signal.aborted) return;
					this.#o.log("error", "event_processing_failed", { eventId: event.eventId, error: String(error).slice(0, 200) });
					await sleep(retry.nextDelayMs(), signal);
				}
			}
			this.#remember(event.eventId);
		}
		this.#saveCursor(Math.max(this.#cursor, event.seq));
	}
}

export const eventsDir = (stateDir: string): string => join(stateDir, "events");
export const handlersDir = (stateDir: string): string => join(stateDir, "handlers");
export const stateExists = (dir: string): boolean => existsSync(join(dir, "cursor.json"));

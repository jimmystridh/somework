import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { redactText } from "./redact.ts";
import type { HandlerEvent } from "./types.ts";

export interface InboxEntry {
	at: string;
	eventId: string;
	topic: string;
	source: string;
	key: string;
	why: string;
	handler?: string;
	data: string;
}

const MAX_BYTES = 1024 * 1024;
const MAX_DATA = 2000;

/** Events that were recorded for the agent but did not wake it, newest last. Bounded: the file is rotated once at 1 MiB. */
export class EventInbox {
	readonly #file: string;
	readonly #now: () => Date;

	constructor(dir: string, now: () => Date = () => new Date()) {
		mkdirSync(dir, { recursive: true });
		this.#file = join(dir, "inbox.jsonl");
		this.#now = now;
	}

	add(event: HandlerEvent, why: string, handler?: string): void {
		const data = redactText(JSON.stringify(event.data) ?? "null").slice(0, MAX_DATA);
		const entry: InboxEntry = { at: this.#now().toISOString(), eventId: event.id, topic: event.topic, source: event.source, key: event.key, why: why.slice(0, 300), ...(handler ? { handler } : {}), data };
		if (existsSync(this.#file) && statSync(this.#file).size > MAX_BYTES) renameSync(this.#file, `${this.#file}.1`);
		appendFileSync(this.#file, `${JSON.stringify(entry)}\n`);
	}

	recent(limit = 20): InboxEntry[] {
		try {
			return readFileSync(this.#file, "utf8")
				.split("\n")
				.filter(Boolean)
				.slice(-Math.max(1, limit))
				.map((line) => JSON.parse(line) as InboxEntry);
		} catch {
			return [];
		}
	}
}

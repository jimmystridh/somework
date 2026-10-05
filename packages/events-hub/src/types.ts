export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** One webhook as the receiver (or the internal listener) hands it over. */
export interface RawItem {
	id: string;
	source: string;
	receivedAt: string;
	headers: Record<string, string>;
	body: Buffer;
	/** The path after /hook/<source>/<token> (empty, or for example /api/hook) and the query string without its `?`. The query is secret material. */
	path: string;
	query: string;
}

/** What a mapping may return: nothing else is ever carried to the domain. */
export interface MappedEvent {
	topic: string;
	key: string;
	data: Json;
	classification: string;
	causedByTask?: string;
}

export interface PublishResult {
	seq: number;
	eventId: string;
	duplicate: boolean;
}

export type Outcome =
	| { kind: "published"; events: number; duplicates: number }
	| { kind: "dropped"; reason: string }
	| { kind: "forwarded" }
	| { kind: "dead_lettered"; reason: string };

/** A failure worth retrying later without giving up on the item: the domain or a target is down or the credentials are being fixed. */
export class TransientError extends Error {
	override readonly name = "TransientError";
}

/** A failure that retrying cannot fix: the item goes to the dead-letter store. */
export class PermanentError extends Error {
	override readonly name = "PermanentError";
	readonly kind: "mapping" | "publish" | "forward";

	constructor(kind: "mapping" | "publish" | "forward", message: string) {
		super(message);
		this.kind = kind;
	}
}

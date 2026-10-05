import { globMatch } from "./glob.ts";
import type { FeedEvent, HandlerEvent } from "./types.ts";

/**
 * Turns a feed event into what handlers see, or undefined when the event is not one the events feature handles. Published events carry
 * `topic`, `source`, `key` and `data`; other domain events are handled only when their type matches one of `accept`.
 */
export function toHandlerEvent(event: FeedEvent, accept: readonly string[]): HandlerEvent | undefined {
	const payload = event.payload ?? {};
	if (typeof payload.topic === "string" && typeof event.eventId === "string") {
		return {
			id: event.eventId,
			seq: event.seq,
			topic: payload.topic,
			source: typeof payload.source === "string" ? payload.source : payload.topic.split(".")[0]!,
			key: typeof payload.key === "string" ? payload.key : event.eventId,
			data: payload.data ?? null,
			classification: typeof payload.classification === "string" ? payload.classification : "internal",
			verified: payload.verified === true,
			depth: Number.isInteger(payload.depth) ? payload.depth : 0,
			...(typeof payload.causedByTask === "string" ? { causedByTask: payload.causedByTask } : {}),
			...(typeof payload.publishedBy === "string" ? { publishedBy: payload.publishedBy } : {}),
			...(event.createdAt ? { receivedAt: event.createdAt } : {}),
			untrusted: true,
		};
	}
	if (accept.some((pattern) => globMatch(pattern, event.type))) {
		return { id: event.eventId, seq: event.seq, topic: event.type, source: event.type.split(".")[0]!, key: event.eventId, data: payload, classification: "internal", verified: true, depth: 0, ...(event.createdAt ? { receivedAt: event.createdAt } : {}), untrusted: true };
	}
	return undefined;
}

import type { Json } from "./client.ts";

/** A JSON pointer that is malformed. */
export class PointerError extends Error {
	override readonly name = "PointerError";
}

/** RFC 6901 pointer into the event payload: `""` is the whole payload, otherwise `/a/b/0`, with `~0` for `~` and `~1` for `/`. */
export function parsePointer(pointer: string): string[] {
	if (pointer === "") return [];
	if (!pointer.startsWith("/")) throw new PointerError(`JSON pointer must start with "/": ${JSON.stringify(pointer)}`);
	return pointer
		.slice(1)
		.split("/")
		.map((token) => {
			if (/~(?![01])/.test(token)) throw new PointerError(`invalid escape in JSON pointer ${JSON.stringify(pointer)}`);
			return token.replaceAll("~1", "/").replaceAll("~0", "~");
		});
}

export function resolvePointer(document: Json, pointer: string): { found: true; value: Json } | { found: false } {
	let current: Json = document;
	for (const token of parsePointer(pointer)) {
		if (Array.isArray(current)) {
			if (!/^(0|[1-9][0-9]*)$/.test(token) || Number(token) >= current.length) return { found: false };
			current = current[Number(token)]!;
		} else if (current !== null && typeof current === "object") {
			if (!Object.hasOwn(current, token)) return { found: false };
			current = current[token]!;
		} else {
			return { found: false };
		}
	}
	return { found: true, value: current };
}

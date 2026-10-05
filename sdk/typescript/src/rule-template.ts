import type { Json } from "./client.ts";

/** A reaction's input is a JSON document whose strings may carry `${/json/pointer}` references into the event payload. */
export class TemplateError extends Error {
	override readonly name = "TemplateError";
}

const REFERENCE = /\$\{([^}]*)\}/g;
const WHOLE_REFERENCE = /^\$\{([^}]*)\}$/;

/** RFC 6901 pointer into the event payload: `""` is the whole payload, otherwise `/a/b/0`, with `~0` for `~` and `~1` for `/`. */
export function parsePointer(pointer: string): string[] {
	if (pointer === "") return [];
	if (!pointer.startsWith("/")) throw new TemplateError(`JSON pointer must start with "/": ${JSON.stringify(pointer)}`);
	return pointer
		.slice(1)
		.split("/")
		.map((token) => {
			if (/~(?![01])/.test(token)) throw new TemplateError(`invalid escape in JSON pointer ${JSON.stringify(pointer)}`);
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

/** Every pointer a template refers to; throws on a malformed reference (`${` without `}`, or a bad pointer). */
export function templatePointers(template: Json): string[] {
	const pointers: string[] = [];
	const visit = (node: Json): void => {
		if (typeof node === "string") {
			const stripped = node.replace(REFERENCE, (_whole, pointer: string) => {
				parsePointer(pointer);
				pointers.push(pointer);
				return "";
			});
			if (stripped.includes("${")) throw new TemplateError(`unterminated "\${" in ${JSON.stringify(node)}`);
		} else if (Array.isArray(node)) {
			node.forEach(visit);
		} else if (node !== null && typeof node === "object") {
			Object.values(node).forEach(visit);
		}
	};
	visit(template);
	return pointers;
}

const text = (value: Json): string => (typeof value === "string" ? value : JSON.stringify(value));

/**
 * Renders a reaction input. A string that is exactly `${/pointer}` becomes the typed value found there; a reference inside a longer
 * string becomes its text form. A pointer that resolves to nothing fails the whole rendering, so a firing never submits a task
 * with a hole in it.
 */
export function renderTemplate(template: Json, payload: Json): Json {
	const lookup = (pointer: string): Json => {
		const found = resolvePointer(payload, pointer);
		if (!found.found) throw new TemplateError(`event payload has nothing at ${pointer}`);
		return found.value;
	};
	const visit = (node: Json): Json => {
		if (typeof node === "string") {
			const whole = WHOLE_REFERENCE.exec(node);
			if (whole) return lookup(whole[1]!);
			if (!node.includes("${")) return node;
			return node.replace(REFERENCE, (_match, pointer: string) => text(lookup(pointer)));
		}
		if (Array.isArray(node)) return node.map(visit);
		if (node !== null && typeof node === "object") return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, visit(value)]));
		return node;
	};
	templatePointers(template);
	return visit(template);
}

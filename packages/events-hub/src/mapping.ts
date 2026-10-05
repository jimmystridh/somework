import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import jsonata from "jsonata";
import { scrubText, scrubValue } from "./scrub.ts";
import { PermanentError, type Json, type MappedEvent, type RawItem } from "./types.ts";

const TOPIC = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+){2,}$/;
const MAX_TOPIC = 200;
const MAX_KEY = 200;
export const MAX_DATA_BYTES = 64 * 1024;
export const EXCERPT_CHARS = 500;
const TASK_ID = /^[A-Za-z0-9_-]{3,100}$/;

export interface MappingInput {
	headers: Record<string, string>;
	body: unknown;
	receivedAt: string;
	source: string;
	defaults?: unknown;
}

export interface Normalized {
	events: MappedEvent[];
	rejected: string[];
}

export function clip(value: unknown, max: number): string | undefined {
	if (value === undefined || value === null) return undefined;
	const text = scrubText(typeof value === "string" ? value : String(value)).trim();
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** The only way free text leaves a mapping: a trimmed excerpt, marked as such, so a rule never mistakes it for the whole body. */
export function excerpt(value: unknown, max = EXCERPT_CHARS): Json | undefined {
	if (value === undefined || value === null) return undefined;
	const full = scrubText(String(value)).trim();
	if (full === "") return undefined;
	return { excerpt: true, text: full.length > max ? `${full.slice(0, max - 1)}…` : full, truncated: full.length > max };
}

/** Parses a webhook body: JSON when it is JSON, otherwise the text; never throws. */
export function parseBody(item: Pick<RawItem, "headers" | "body">): unknown {
	const text = item.body.toString("utf8");
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

/**
 * Turns whatever a mapping returned into events the domain will accept. Fields the contract does not name are dropped here, so a careless
 * mapping cannot carry an extra field to the domain. Invalid events are rejected with a reason instead of failing the whole item.
 */
export function normalize(raw: unknown, source: string, defaultClassification: string): Normalized {
	const candidates = raw === undefined || raw === null ? [] : Array.isArray(raw) ? raw : [raw];
	const events: MappedEvent[] = [];
	const rejected: string[] = [];
	for (const candidate of candidates) {
		if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
			rejected.push("not_an_object");
			continue;
		}
		const { topic, key, data, classification, causedByTask } = candidate as Record<string, unknown>;
		if (typeof topic !== "string" || topic.length > MAX_TOPIC || !TOPIC.test(topic)) rejected.push("invalid_topic");
		else if (!topic.startsWith(`${source}.`)) rejected.push("topic_outside_source_prefix");
		else if (typeof key !== "string" || key.length < 1 || key.length > MAX_KEY || /[\u0000-\u001f]/.test(key)) rejected.push("invalid_key");
		else if (data === undefined || data === null || typeof data !== "object") rejected.push("invalid_data");
		else if (classification !== undefined && typeof classification !== "string") rejected.push("invalid_classification");
		else if (causedByTask !== undefined && (typeof causedByTask !== "string" || !TASK_ID.test(causedByTask))) rejected.push("invalid_caused_by_task");
		else {
			const clean = scrubValue(data as Json);
			if (Buffer.byteLength(JSON.stringify(clean)) > MAX_DATA_BYTES) {
				rejected.push("data_too_large");
				continue;
			}
			events.push({ topic, key, data: clean, classification: (classification as string | undefined) ?? defaultClassification, ...(causedByTask ? { causedByTask: causedByTask as string } : {}) });
		}
	}
	return { events, rejected };
}

type Compiled = ReturnType<typeof jsonata>;

function register(expression: Compiled): Compiled {
	expression.registerFunction("clip", (value: unknown, max: unknown) => clip(value, Number(max ?? 200)), "<x-n?:s>");
	expression.registerFunction("excerpt", (value: unknown, max: unknown) => excerpt(value, max === undefined ? EXCERPT_CHARS : Number(max)), "<x-n?:x>");
	return expression;
}

/** Loads the reviewed JSONata mapping files of a directory, one per source, and runs them. */
export class MappingEngine {
	readonly #dir: string;
	readonly #cache = new Map<string, Compiled>();

	constructor(dir: string) {
		this.#dir = dir;
	}

	names(): string[] {
		return readdirSync(this.#dir).filter((name) => name.endsWith(".jsonata")).map((name) => name.slice(0, -".jsonata".length));
	}

	#compiled(name: string): Compiled {
		let expression = this.#cache.get(name);
		if (!expression) {
			if (!/^[a-z][a-z0-9_-]*$/.test(name)) throw new PermanentError("mapping", `invalid mapping name ${name}`);
			expression = register(jsonata(readFileSync(join(this.#dir, `${name}.jsonata`), "utf8")));
			this.#cache.set(name, expression);
		}
		return expression;
	}

	/** Raw mapping output. A thrown error is a defect of the mapping or an input it cannot handle: the caller dead-letters the item. */
	async evaluate(name: string, input: MappingInput): Promise<unknown> {
		try {
			return await this.#compiled(name).evaluate(input);
		} catch (error) {
			throw new PermanentError("mapping", `mapping ${name} failed: ${(error as { message?: string }).message ?? String(error)}`);
		}
	}

	async run(name: string, source: string, input: MappingInput, defaultClassification: string): Promise<Normalized> {
		return normalize(await this.evaluate(name, input), source, defaultClassification);
	}
}

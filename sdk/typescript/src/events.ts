import type { Json } from "./client.ts";
import { resolvePointer, templatePointers } from "./rule-template.ts";

/** A request or answer that does not match the events/rules contract (docs/EVENTS.md, "Interfaces"). */
export class ContractError extends Error {
	override readonly name = "ContractError";
}

export const TOPIC_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+){2,}$/;
export const MAX_TOPIC_LENGTH = 200;
export const MAX_EVENT_KEY_LENGTH = 200;
export const MAX_EVENT_DATA_BYTES = 64 * 1024;
export const RULE_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const PRINCIPAL_PATTERN = /^[a-z][a-z0-9_-]*\/[a-z0-9][a-z0-9._-]*$/;
export const SELECTOR_PATTERN = /^[a-z][a-z0-9_]*\.[a-z0-9_.*]*$/;
export const DEFAULT_MAX_DEPTH = 3;
export const DEFAULT_MAX_FIRINGS_PER_HOUR = 30;

export interface PublishEvent {
	topic: string;
	/** Stable key of the fact (delivery id, monitor id plus transition time, ...): a repeat is deduplicated for 30 days. */
	key: string;
	source: string;
	data: { [key: string]: Json };
	classification?: string;
	verified?: boolean;
	causedByTask?: string;
	occurredAt?: string;
}

export interface PublishResult {
	seq: number;
	eventId: string;
	duplicate: boolean;
}

export interface RuleWhere {
	path: string;
	equals: Json;
}

export interface Reaction {
	capability: { id: string; version: number | string };
	input: { [key: string]: Json };
	budget: { maxTokens: number; maxMinutes: number };
	maxDepth?: number;
	maxFiringsPerHour?: number;
}

export type RuleStatus = "active" | "paused";

/** The body of `PUT /v1/rules/{name}`. A rule with `wake` and no `reaction` is an agent subscription owned by that agent. */
export interface RuleSpec {
	description?: string;
	owner: string;
	selector: string;
	where?: RuleWhere[];
	wake: boolean;
	reaction?: Reaction;
	status?: RuleStatus;
}

export interface RuleCounters {
	fired: number;
	skipped: { duplicate: number; depth: number; rate: number; denied: number; approval: number; error: number };
}

export interface RuleView extends RuleSpec {
	name: string;
	description: string;
	where: RuleWhere[];
	status: RuleStatus;
	createdAt?: string;
	updatedAt?: string;
	lastFiredAt: string | null;
	counters: RuleCounters;
}

const isObject = (value: unknown): value is { [key: string]: unknown } => value !== null && typeof value === "object" && !Array.isArray(value);
const fail = (message: string): never => {
	throw new ContractError(message);
};

function wholeNumber(value: unknown, what: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) fail(`${what} must be an integer between ${min} and ${max}`);
	return value as number;
}

function text(value: unknown, what: string, pattern?: RegExp, maxLength = 200): string {
	if (typeof value !== "string" || value === "" || value.length > maxLength) fail(`${what} must be a string of 1-${maxLength} characters`);
	if (pattern && !pattern.test(value as string)) fail(`${what} has an invalid shape: ${JSON.stringify(value)}`);
	return value as string;
}

export function validatePublish(event: PublishEvent): PublishEvent {
	if (!isObject(event)) fail("event must be an object");
	text(event.topic, "topic", TOPIC_PATTERN, MAX_TOPIC_LENGTH);
	if (!isObject(event.data)) fail("data must be an object");
	text(event.key, "key", undefined, MAX_EVENT_KEY_LENGTH);
	text(event.source, "source", /^[a-z][a-z0-9_]*$/, 64);
	if (Buffer.byteLength(JSON.stringify(event.data)) > MAX_EVENT_DATA_BYTES) fail(`data exceeds ${MAX_EVENT_DATA_BYTES} bytes`);
	if (event.classification !== undefined) text(event.classification, "classification", /^[a-z][a-z0-9_-]*$/, 32);
	if (event.verified !== undefined && typeof event.verified !== "boolean") fail("verified must be a boolean");
	if (event.causedByTask !== undefined) text(event.causedByTask, "causedByTask", undefined, 64);
	if (event.occurredAt !== undefined && Number.isNaN(Date.parse(text(event.occurredAt, "occurredAt", undefined, 40)))) fail("occurredAt must be an ISO timestamp");
	return event;
}

export function parsePublishResult(value: unknown): PublishResult {
	if (!isObject(value) || typeof value.eventId !== "string" || typeof value.duplicate !== "boolean") fail("unexpected answer to an event publish");
	return { seq: wholeNumber((value as { seq?: unknown }).seq, "seq", 0), eventId: value.eventId as string, duplicate: value.duplicate as boolean };
}

function validateWhere(where: unknown): RuleWhere[] {
	if (!Array.isArray(where)) return fail("where must be a list");
	return where.map((entry, index) => {
		if (!isObject(entry) || typeof entry.path !== "string" || !("equals" in entry)) return fail(`where[${index}] needs path and equals`);
		if (entry.path !== "" && !entry.path.startsWith("/")) fail(`where[${index}].path must be a JSON pointer`);
		if (isObject(entry.equals) || Array.isArray(entry.equals)) fail(`where[${index}].equals must be a string, number, boolean or null`);
		return { path: entry.path, equals: entry.equals as Json };
	});
}

function validateReaction(reaction: unknown): Reaction {
	if (!isObject(reaction)) return fail("reaction must be an object");
	const capability = reaction.capability;
	if (!isObject(capability)) return fail("reaction.capability must be an object");
	text(capability.id, "reaction.capability.id", /^[a-z][a-z0-9_-]*(\.[a-z0-9_-]+)+$/, 100);
	if (typeof capability.version === "number") wholeNumber(capability.version, "reaction.capability.version", 1);
	else text(capability.version, "reaction.capability.version", undefined, 40);
	if (!isObject(reaction.input)) fail("reaction.input must be an object");
	try {
		templatePointers(reaction.input as Json);
	} catch (error) {
		fail(`reaction.input: ${(error as Error).message}`);
	}
	const budget = reaction.budget;
	if (!isObject(budget)) return fail("reaction.budget is required");
	wholeNumber(budget.maxTokens, "reaction.budget.maxTokens", 1);
	wholeNumber(budget.maxMinutes, "reaction.budget.maxMinutes", 1);
	if (reaction.maxDepth !== undefined) wholeNumber(reaction.maxDepth, "reaction.maxDepth", 1, 10);
	if (reaction.maxFiringsPerHour !== undefined) wholeNumber(reaction.maxFiringsPerHour, "reaction.maxFiringsPerHour", 1, 1000);
	return reaction as unknown as Reaction;
}

export function validateRuleName(name: string): string {
	return text(name, "rule name", RULE_NAME_PATTERN, 64);
}

export function validateRuleSpec(spec: RuleSpec): RuleSpec {
	if (!isObject(spec)) fail("rule must be an object");
	text(spec.owner, "owner", PRINCIPAL_PATTERN, 128);
	const selector = text(spec.selector, "selector", SELECTOR_PATTERN, MAX_TOPIC_LENGTH);
	if (selector.includes("**") || selector.includes("..")) fail(`selector ${JSON.stringify(selector)} has an empty or doubled wildcard segment`);
	if (typeof spec.wake !== "boolean") fail("wake must be stated explicitly (true or false)");
	if (spec.description !== undefined && typeof spec.description !== "string") fail("description must be a string");
	if (spec.where !== undefined) validateWhere(spec.where);
	if (spec.reaction !== undefined) validateReaction(spec.reaction);
	else if (!spec.wake) fail("a rule needs a reaction or wake: true, otherwise it does nothing");
	if (spec.status !== undefined && spec.status !== "active" && spec.status !== "paused") fail('status must be "active" or "paused"');
	return spec;
}

const ZERO_SKIPS = { duplicate: 0, depth: 0, rate: 0, denied: 0, approval: 0, error: 0 };

/** Reads one rule as the domain returns it; tolerant of fields it does not know, strict about those the tooling relies on. */
export function parseRuleView(value: unknown): RuleView {
	if (!isObject(value)) return fail("unexpected rule shape: not an object");
	const name = validateRuleName(value.name as string);
	if (value.status !== "active" && value.status !== "paused") fail(`unexpected rule shape: status of ${name}`);
	const spec = {
		owner: value.owner as string,
		selector: value.selector as string,
		wake: value.wake as boolean,
		...(value.reaction ? { reaction: value.reaction as Reaction } : {}),
	};
	text(spec.owner, `owner of ${name}`, undefined, 128);
	text(spec.selector, `selector of ${name}`, undefined, MAX_TOPIC_LENGTH);
	if (typeof spec.wake !== "boolean") fail(`unexpected rule shape: wake of ${name}`);
	const where = value.where === undefined || value.where === null ? [] : validateWhere(value.where);
	const counters = isObject(value.counters) ? value.counters : {};
	const skipped = isObject(counters.skipped) ? counters.skipped : {};
	return {
		...spec,
		name,
		description: typeof value.description === "string" ? value.description : "",
		where,
		status: value.status as RuleStatus,
		...(typeof value.createdAt === "string" ? { createdAt: value.createdAt } : {}),
		...(typeof value.updatedAt === "string" ? { updatedAt: value.updatedAt } : {}),
		lastFiredAt: typeof value.lastFiredAt === "string" ? value.lastFiredAt : null,
		counters: {
			fired: typeof counters.fired === "number" ? counters.fired : 0,
			skipped: { ...ZERO_SKIPS, ...Object.fromEntries(Object.entries(skipped).filter(([, count]) => typeof count === "number")) },
		},
	};
}

/** `GET /v1/rules` answers `{rules: [...]}`; a bare list is accepted too. */
export function parseRuleList(value: unknown): RuleView[] {
	const list = Array.isArray(value) ? value : isObject(value) && Array.isArray(value.rules) ? value.rules : fail("unexpected answer to a rule list");
	return (list as unknown[]).map(parseRuleView);
}

/** The pointers of `where` and of the reaction input that do not resolve in a sample payload. Used to check rules against recorded events. */
export function unresolvedPointers(spec: RuleSpec, payload: Json): string[] {
	const pointers = [...(spec.where ?? []).map((entry) => entry.path), ...(spec.reaction ? templatePointers(spec.reaction.input as Json) : [])];
	return pointers.filter((pointer) => !resolvePointer(payload, pointer).found);
}

/** Whether `where` accepts the payload (all entries must hold). */
export function whereMatches(where: RuleWhere[] | undefined, payload: Json): boolean {
	return (where ?? []).every((entry) => {
		const found = resolvePointer(payload, entry.path);
		return found.found && found.value === entry.equals;
	});
}

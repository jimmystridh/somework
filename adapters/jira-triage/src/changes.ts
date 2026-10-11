import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { dirname } from "node:path";
import { silent, type Log } from "@somework/agent-kit";

/** The fields the bot may write: the ones a checklist concerns. A comment is not a field and is always allowed. */
export const WRITABLE_FIELDS = ["description", "labels", "components", "priority", "environment"] as const;
export type WritableField = (typeof WRITABLE_FIELDS)[number];

/** Refused whatever the settings say: the bot acts as the owner of the token, so these would be done in the owner's name. */
export const FORBIDDEN_FIELDS = ["assignee", "status", "transition", "reporter"] as const;

export class WriteRefused extends Error {
	override readonly name = "WriteRefused";
}

export function assertWritable(field: string): asserts field is WritableField {
	if ((FORBIDDEN_FIELDS as readonly string[]).includes(field.toLowerCase())) throw new WriteRefused(`the ${field} of a ticket is never changed by this agent`);
	if (!(WRITABLE_FIELDS as readonly string[]).includes(field)) throw new WriteRefused(`${field} is not a field this agent may write (it writes ${WRITABLE_FIELDS.join(", ")} and comments)`);
}

export type FieldValue = string | string[] | null;

/** One field of one ticket: what it was and what it becomes. Labels and components are lists; the others are text. */
export interface Change {
	field: WritableField;
	before: FieldValue;
	after: FieldValue;
}

export interface ChangeRecord {
	id: string;
	at: string;
	ticket: string;
	field: WritableField;
	before: FieldValue;
	after: FieldValue;
	reason: string;
	trigger: string;
	/** `planned` is written before the call, the others after it; a `planned` without an outcome means the call never reported back. */
	state: "planned" | "applied" | "failed" | "dry_run";
	error?: string;
}

export interface JiraWriter {
	updateFields(key: string, fields: Partial<Record<"description" | "environment" | "priority" | "components", unknown>>): Promise<void>;
	updateLabels(key: string, change: { add?: readonly string[]; remove?: readonly string[] }): Promise<void>;
}

const MAX_VALUE = 40_000;

const clip = (value: FieldValue): FieldValue => (typeof value === "string" && value.length > MAX_VALUE ? `${value.slice(0, MAX_VALUE)}\n[cut at ${MAX_VALUE} characters in this record]` : value);

/**
 * Every write of the bot is recorded here first, with the value before and after, so that it can be reverted by hand: the file is append-only JSON
 * lines in the agent's state directory. A change is recorded as `planned` before the call and as `applied` or `failed` after it; when a record
 * cannot be written the change is not made.
 */
export class ChangeJournal {
	readonly #file: string;
	readonly #now: () => Date;

	constructor(file: string, now: () => Date = () => new Date()) {
		this.#file = file;
		this.#now = now;
		mkdirSync(dirname(file), { recursive: true });
	}

	record(entry: Omit<ChangeRecord, "id" | "at"> & { id?: string }): ChangeRecord {
		const record: ChangeRecord = { ...entry, id: entry.id ?? `chg-${randomBytes(5).toString("hex")}`, at: this.#now().toISOString(), before: clip(entry.before), after: clip(entry.after) };
		appendFileSync(this.#file, `${JSON.stringify(record)}\n`);
		return record;
	}

	all(): ChangeRecord[] {
		try {
			return readFileSync(this.#file, "utf8")
				.split("\n")
				.filter(Boolean)
				.flatMap((line) => {
					try {
						return [JSON.parse(line) as ChangeRecord];
					} catch {
						return [];
					}
				});
		} catch {
			return [];
		}
	}

	/** The latest state of every change of a ticket (planned, then applied or failed), oldest first. */
	forTicket(ticket: string, limit = 50): ChangeRecord[] {
		const latest = new Map<string, ChangeRecord>();
		for (const record of this.all()) if (record.ticket === ticket) latest.set(record.id, record);
		return [...latest.values()].slice(-limit);
	}

	count(): number {
		return new Set(this.all().map((record) => record.id)).size;
	}
}

/** What undoes a recorded change: the same field with the two values swapped. Applying it by hand is what the record is for. */
export const revertOf = (record: ChangeRecord): Change => ({ field: record.field, before: record.after, after: record.before });

const sameValue = (a: FieldValue, b: FieldValue): boolean => JSON.stringify(a) === JSON.stringify(b);

const asList = (value: FieldValue): string[] => (Array.isArray(value) ? value : []);

export interface ApplyOptions {
	jira: JiraWriter;
	journal: ChangeJournal;
	log?: Log;
	/** Record what would be done and call nothing. */
	dryRun?: boolean;
}

const fingerprint = (value: FieldValue): string => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 12);

/**
 * Makes the changes to one ticket, the guardrail and the record first: a field outside the write authority refuses the whole batch before anything is
 * written, every change is recorded with its before and after value, and only then does Jira hear about it. Returns what was applied.
 */
export async function applyChanges(options: ApplyOptions, ticket: string, changes: readonly Change[], why: { reason: string; trigger: string }): Promise<Change[]> {
	const log = options.log ?? silent;
	for (const change of changes) assertWritable(change.field);
	const effective = changes.filter((change) => !sameValue(change.before, change.after));
	if (effective.length === 0) return [];
	if (options.dryRun) {
		for (const change of effective) options.journal.record({ ticket, field: change.field, before: change.before, after: change.after, reason: why.reason, trigger: why.trigger, state: "dry_run" });
		log("info", "jira_change_dry_run", { ticket, fields: effective.map((change) => change.field), reason: why.reason });
		return [];
	}
	const planned = effective.map((change) => ({ change, record: options.journal.record({ ticket, field: change.field, before: change.before, after: change.after, reason: why.reason, trigger: why.trigger, state: "planned" }) }));
	const settle = (entry: (typeof planned)[number], state: "applied" | "failed", error?: string): void => {
		options.journal.record({ id: entry.record.id, ticket, field: entry.change.field, before: entry.change.before, after: entry.change.after, reason: why.reason, trigger: why.trigger, state, ...(error ? { error: error.slice(0, 300) } : {}) });
		log(state === "applied" ? "info" : "warn", `jira_change_${state}`, { ticket, field: entry.change.field, id: entry.record.id, reason: why.reason, beforeChars: JSON.stringify(entry.change.before).length, afterChars: JSON.stringify(entry.change.after).length, afterHash: fingerprint(entry.change.after), ...(error ? { error: error.slice(0, 160) } : {}) });
	};
	const applied: Change[] = [];
	const fields: Partial<Record<"description" | "environment" | "priority" | "components", unknown>> = {};
	const text = planned.filter((entry) => entry.change.field !== "labels");
	for (const { change } of text) {
		if (change.field === "components") fields.components = asList(change.after).map((name) => ({ name }));
		else if (change.field === "priority") fields.priority = { name: String(change.after ?? "") };
		else if (change.field === "description" || change.field === "environment") fields[change.field] = change.after ?? "";
	}
	try {
		if (text.length > 0) await options.jira.updateFields(ticket, fields);
		for (const entry of text) {
			settle(entry, "applied");
			applied.push(entry.change);
		}
		for (const entry of planned.filter((candidate) => candidate.change.field === "labels")) {
			const before = asList(entry.change.before);
			const after = asList(entry.change.after);
			await options.jira.updateLabels(ticket, { add: after.filter((label) => !before.includes(label)), remove: before.filter((label) => !after.includes(label)) });
			settle(entry, "applied");
			applied.push(entry.change);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		for (const entry of planned) if (!applied.includes(entry.change)) settle(entry, "failed", message);
		throw error;
	}
	return applied;
}

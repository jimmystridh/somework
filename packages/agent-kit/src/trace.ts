import { appendFileSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { redactText } from "./events/redact.ts";
import type { Log } from "./log.ts";

/**
 * The run record: everything one model run did, one JSON line per step, kept on the agent's own disk so it can be analysed later (the
 * log lines that go to Loki carry identifiers and counts only; content stays here). Secrets are removed on the way in, long strings are cut,
 * and nothing in here can fail a run.
 */

/** The per-day file that says, one short line at a time, which runs there are and how each went: what recall reads instead of every run. */
export const INDEX_FILE = "index.log";
const INDEXED_NOTES = new Set(["sent", "job_started", "no_reply", "approval"]);
const PREVIEW_CHARS = 300;
const REMEMBERED_RUNS = 200;

const SECRET_KEYS = /^(token|secret|password|passwd|authorization|apikey|api_key|accesstoken|refreshtoken|privatekey|clientsecret)$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export interface RunTraceOptions {
	dir: string;
	agentId: string;
	role: string;
	log?: Log;
	/** A string longer than this many characters is cut (the line says how much was cut). */
	maxStringChars?: number;
	/** Days kept; older day directories are removed when a run starts. */
	keepDays?: number;
	/** Total size kept; the oldest days go first. */
	maxTotalBytes?: number;
	now?: () => number;
}

/** What a run is when it starts. */
export interface RunInfo {
	requestId: string;
	agentKey: string;
	instruction: string;
	context?: unknown;
	/** What ties the run to the rest: `kind` (chat, job, event, task), `conversationId`, `messageId`, `jobId`, `replyTo`, `by`, `asked`. Free-form beyond that. */
	meta?: Record<string, unknown>;
	model?: { provider: string; modelId: string };
}

export interface RunRecording {
	/** One event of the harness's stream, as it arrives. */
	event(event: any): void;
	/** Something the service knows about the run that the harness does not (a message it sent, a job it started). Also works after `end`. */
	note(type: string, fields: Record<string, unknown>): void;
	/** The end of the run; closes the record. */
	end(outcome: { status: string; reason?: string; answer?: string; usage?: unknown }): void;
}

/** Where the engine and the tools say what a run did, by the run's request id. */
export interface RunNotes {
	note(requestId: string, type: string, fields: Record<string, unknown>): void;
}

const NONE: RunRecording = { event: () => undefined, note: () => undefined, end: () => undefined };
export const NO_RUN_TRACE = { open: (): RunRecording => NONE, note: (): void => undefined };

export interface RunTracer extends RunNotes {
	open(info: RunInfo): RunRecording;
}

const safe = (value: string): string => value.replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 80) || "run";

export class RunTrace implements RunTracer {
	readonly #o: Required<Pick<RunTraceOptions, "dir" | "agentId" | "role" | "maxStringChars" | "keepDays" | "maxTotalBytes">> & Pick<RunTraceOptions, "log" | "now">;
	#warned = false;
	readonly #open = new Map<string, RunRecording>();
	readonly #finished = new Map<string, RunRecording>();

	constructor(options: RunTraceOptions) {
		this.#o = { maxStringChars: 64_000, keepDays: 30, maxTotalBytes: 1024 * 1024 * 1024, ...options };
	}

	open(info: RunInfo): RunRecording {
		const now = this.#o.now ?? Date.now;
		const started = now();
		const day = new Date(started).toISOString().slice(0, 10);
		const directory = join(this.#o.dir, day);
		const file = join(directory, `${safe(info.requestId)}-${started.toString(36)}.jsonl`);
		let seq = 0;
		let steps = 0;
		let toolErrors = 0;
		const tools: Record<string, number> = {};
		const toolStarts = new Map<string, number>();
		const append = (target: string, fields: Record<string, unknown>): void => {
			try {
				appendFileSync(target, `${JSON.stringify(this.#clean(fields))}\n`, { mode: 0o600 });
			} catch (error) {
				this.#fail(error);
			}
		};
		const write = (type: string, fields: Record<string, unknown>): void => append(file, { seq: seq++, at: new Date(now()).toISOString(), type, ...fields });
		const index = (t: string, fields: Record<string, unknown>): void => append(join(directory, INDEX_FILE), { t, file: basename(file), runId: info.requestId, at: new Date(now()).toISOString(), ...fields });
		try {
			mkdirSync(directory, { recursive: true, mode: 0o700 });
			this.#prune(day);
		} catch (error) {
			this.#fail(error);
			return NONE;
		}
		const meta = info.meta ?? {};
		write("run_start", { runId: info.requestId, agentKey: info.agentKey, agent: this.#o.agentId, role: this.#o.role, instruction: info.instruction, ...(info.context !== undefined ? { context: info.context } : {}), ...(info.meta ? { meta: info.meta } : {}), ...(info.model ? { model: info.model } : {}) });
		index("start", { agentKey: info.agentKey, kind: typeof meta.kind === "string" ? meta.kind : "run", ...pick(meta, ["conversationId", "messageId", "jobId", "replyTo", "by"]), ...(typeof meta.asked === "string" ? { asked: meta.asked.slice(0, PREVIEW_CHARS) } : {}) });
		const recording: RunRecording = {
			event: (event) => {
				try {
					this.#step(event, write, toolStarts, now, (step) => {
						if (step.kind === "assistant") steps += 1;
						else if (step.kind === "tool") tools[step.name] = (tools[step.name] ?? 0) + 1;
						else toolErrors += 1;
					});
				} catch (error) {
					this.#fail(error);
				}
			},
			note: (type, fields) => {
				write(type, fields);
				if (INDEXED_NOTES.has(type)) index(type, fields);
			},
			end: (outcome) => {
				const usage = outcome.usage as { totalTokens?: number; costUsd?: number } | undefined;
				write("run_end", { ms: now() - started, ...outcome });
				index("end", { ms: now() - started, status: outcome.status, ...(outcome.reason ? { reason: outcome.reason } : {}), steps, tools, toolErrors, ...(typeof usage?.totalTokens === "number" ? { tokens: usage.totalTokens } : {}), ...(typeof usage?.costUsd === "number" ? { costUsd: usage.costUsd } : {}), ...(outcome.answer ? { answer: outcome.answer.slice(0, PREVIEW_CHARS) } : {}) });
				this.#open.delete(info.requestId);
				this.#finished.set(info.requestId, recording);
				for (const old of [...this.#finished.keys()].slice(0, Math.max(0, this.#finished.size - REMEMBERED_RUNS))) this.#finished.delete(old);
			},
		};
		this.#open.set(info.requestId, recording);
		return recording;
	}

	note(requestId: string, type: string, fields: Record<string, unknown>): void {
		try {
			(this.#open.get(requestId) ?? this.#finished.get(requestId))?.note(type, fields);
		} catch (error) {
			this.#fail(error);
		}
	}

	#step(event: any, write: (type: string, fields: Record<string, unknown>) => void, toolStarts: Map<string, number>, now: () => number, count: (step: { kind: "assistant" } | { kind: "tool"; name: string } | { kind: "tool_error" }) => void): void {
		switch (event?.type) {
			case "message_end": {
				const entry = event.entry;
				for (const message of Array.isArray(entry?.model) ? entry.model : []) {
					if (message.role === "toolResult") continue;
					if (message.role === "system") write("system", { entry: entry.id, text: message.content, tools: (message.toolsAdded ?? []).map((tool: any) => tool?.name), toolsRemoved: message.toolsRemoved });
					else if (message.role === "assistant") {
						count({ kind: "assistant" });
						write("assistant", { entry: entry.id, content: message.content, provider: message.provider, model: message.model, stopReason: message.stopReason, usage: message.usage });
					}
					else write(message.role ?? "message", { entry: entry.id, content: message.content });
				}
				return;
			}
			case "tool_execution_start":
				toolStarts.set(String(event.toolCallId), now());
				count({ kind: "tool", name: String(event.toolName ?? "?") });
				write("tool_start", { id: event.toolCallId, tool: event.toolName, args: event.args });
				return;
			case "tool_execution_end": {
				const result = Array.isArray(event.entry?.model) ? event.entry.model[0] : undefined;
				const began = toolStarts.get(String(event.toolCallId));
				toolStarts.delete(String(event.toolCallId));
				if (result?.isError === true) count({ kind: "tool_error" });
				write("tool_end", { id: event.toolCallId, tool: event.toolName, ...(began !== undefined ? { ms: now() - began } : {}), isError: result?.isError === true, output: result?.content, ...(event.entry?.data ? { data: event.entry.data } : {}) });
				return;
			}
			default:
				return;
		}
	}

	/** Secrets out (by key and by pattern), long strings cut. */
	#clean(value: unknown, key?: string, depth = 0): unknown {
		if (key !== undefined && SECRET_KEYS.test(key)) return "[redacted]";
		if (typeof value === "string") {
			const text = redactText(value);
			const max = this.#o.maxStringChars;
			return text.length > max ? `${text.slice(0, max)}…[${text.length - max} chars cut]` : text;
		}
		if (value === null || typeof value !== "object") return value;
		if (depth > 12) return "[too deep]";
		if (Array.isArray(value)) return value.map((item) => this.#clean(item, undefined, depth + 1));
		return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([name, item]) => [name, this.#clean(item, name, depth + 1)]));
	}

	/** Days past the limit go, then the oldest days while the total is too big. */
	#prune(today: string): void {
		const days = readdirSync(this.#o.dir).filter((name) => DAY.test(name)).sort();
		const cutoff = new Date((this.#o.now ?? Date.now)() - this.#o.keepDays * 86_400_000).toISOString().slice(0, 10);
		for (const old of days.filter((name) => name < cutoff && name !== today)) rmSync(join(this.#o.dir, old), { recursive: true, force: true });
		const kept = days.filter((name) => name >= cutoff || name === today);
		const sizes = kept.map((name) => ({ name, bytes: readdirSync(join(this.#o.dir, name)).reduce((sum, file) => sum + statSync(join(this.#o.dir, name, file)).size, 0) }));
		let total = sizes.reduce((sum, day) => sum + day.bytes, 0);
		for (const day of sizes) {
			if (total <= this.#o.maxTotalBytes || day.name === today) break;
			rmSync(join(this.#o.dir, day.name), { recursive: true, force: true });
			total -= day.bytes;
		}
	}

	#fail(error: unknown): void {
		if (this.#warned) return;
		this.#warned = true;
		this.#o.log?.("warn", "run_trace_failed", { error: error instanceof Error ? error.message : String(error) });
	}
}

const pick = (source: Record<string, unknown>, keys: string[]): Record<string, string> => Object.fromEntries(keys.flatMap((key) => (typeof source[key] === "string" ? [[key, source[key] as string]] : [])));

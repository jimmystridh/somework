import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { INDEX_FILE } from "./trace.ts";

/**
 * Reads the run record back: which runs there were, what each did, and how conversations and jobs are tied together. Everything here comes
 * from the files `RunTrace` writes on this agent's own disk; nothing is asked of Loki or the domain.
 */

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const STEP_CHARS = 220;
const OUTPUT_CHARS = 12_000;

export interface SentRecord {
	messageId?: string;
	conversationId?: string;
	to?: string[];
	/** The conversation the sending run belonged to, when it differs from where the message went: a conversation opened from another. */
	fromConversation?: string;
	via?: string;
	at: string;
}

export interface RunSummary {
	runId: string;
	file: string;
	day: string;
	at: string;
	kind: string;
	agentKey?: string;
	conversationId?: string;
	messageId?: string;
	jobId?: string;
	replyTo?: string;
	by?: string;
	asked?: string;
	status?: string;
	reason?: string;
	ms?: number;
	steps?: number;
	tools: Record<string, number>;
	toolErrors?: number;
	tokens?: number;
	costUsd?: number;
	answer?: string;
	sent: SentRecord[];
	jobsStarted: { jobId: string; label?: string }[];
	approvals: { tool?: string; approved?: boolean }[];
	noReply?: string;
}

export interface Link {
	conversationId: string;
	runId: string;
	at: string;
}

const str = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);

const cut = (text: string, max: number): string => {
	// eslint-disable-next-line no-control-regex
	const flat = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

export function ago(at: string | undefined, now: number): string {
	const then = at === undefined ? Number.NaN : Date.parse(at);
	if (!Number.isFinite(then)) return "some time ago";
	const seconds = Math.max(0, Math.round((now - then) / 1000));
	return seconds < 90 ? `${seconds}s ago` : seconds < 5400 ? `${Math.round(seconds / 60)} min ago` : seconds < 172_800 ? `${(seconds / 3600).toFixed(1)} h ago` : `${Math.round(seconds / 86_400)} days ago`;
}

const duration = (ms: number | undefined): string => (ms === undefined ? "" : ms < 1000 ? `${ms}ms` : ms < 90_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 60_000)} min`);

/** `bash×3, read×2` */
export const toolCounts = (tools: Record<string, number>): string =>
	Object.entries(tools)
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.map(([name, count]) => (count > 1 ? `${name}×${count}` : name))
		.join(", ");

interface IndexCache {
	size: number;
	mtimeMs: number;
	runs: Map<string, RunSummary>;
}

export interface RunRecallOptions {
	dir: string;
	now?: () => number;
}

/** One step of a run as the model reads it: what happened, short. */
export interface Step {
	seq: number;
	text: string;
}

export class RunRecall {
	readonly #dir: string;
	readonly #now: () => number;
	readonly #cache = new Map<string, IndexCache>();
	#merged: { key: string; runs: RunSummary[] } | undefined;

	constructor(options: RunRecallOptions) {
		this.#dir = options.dir;
		this.#now = options.now ?? Date.now;
	}

	/** Every run in the index, newest first. The same list is handed out until an index grows. */
	all(): RunSummary[] {
		const days = this.#days().map((day) => ({ day, entry: this.#day(day) }));
		const key = days.map(({ day, entry }) => `${day}:${entry.size}:${entry.mtimeMs}`).join("|");
		if (this.#merged?.key === key) return this.#merged.runs;
		const runs = days.flatMap(({ entry }) => [...entry.runs.values()]).sort((a, b) => b.at.localeCompare(a.at));
		this.#merged = { key, runs };
		return runs;
	}

	/** The runs of a conversation, newest first. */
	inConversation(conversationId: string): RunSummary[] {
		return this.all().filter((run) => run.conversationId === conversationId);
	}

	/** The runs of a job (the job's own run, and the chat runs that started it), newest first. */
	ofJob(jobId: string): RunSummary[] {
		return this.all().filter((run) => run.jobId === jobId || run.jobsStarted.some((job) => job.jobId === jobId));
	}

	/** The newest run with this request id (a run that was taken up again after a restart has several). */
	find(runId: string): RunSummary | undefined {
		return this.all().find((run) => run.runId === runId);
	}

	/** The run that wrote a message of this agent, found by the message's id. */
	writerOf(messageId: string): RunSummary | undefined {
		return this.all().find((run) => run.sent.some((sent) => sent.messageId === messageId));
	}

	/** The conversation this one was opened from: the first message this agent wrote into it from a run of another conversation. */
	parentOf(conversationId: string): (Link & { to?: string[] }) | undefined {
		const opened = this.all()
			.flatMap((run) => run.sent.filter((sent) => sent.conversationId === conversationId && sent.fromConversation !== undefined && sent.fromConversation !== conversationId).map((sent) => ({ conversationId: sent.fromConversation!, runId: run.runId, at: sent.at, ...(sent.to ? { to: sent.to } : {}) })))
			.sort((a, b) => a.at.localeCompare(b.at));
		return opened[0];
	}

	/** The conversations this agent opened from this one, oldest first. */
	childrenOf(conversationId: string): (Link & { to?: string[] })[] {
		const seen = new Map<string, Link & { to?: string[] }>();
		for (const run of [...this.all()].reverse())
			for (const sent of run.sent) {
				if (sent.fromConversation !== conversationId || sent.conversationId === undefined || sent.conversationId === conversationId || seen.has(sent.conversationId)) continue;
				seen.set(sent.conversationId, { conversationId: sent.conversationId, runId: run.runId, at: sent.at, ...(sent.to ? { to: sent.to } : {}) });
			}
		return [...seen.values()];
	}

	/** The conversations linked to this one, through any number of openings in either direction. */
	linked(conversationId: string): Set<string> {
		const reached = new Set<string>([conversationId]);
		const queue = [conversationId];
		const edges = this.all().flatMap((run) => run.sent.filter((sent) => sent.conversationId !== undefined && sent.fromConversation !== undefined && sent.conversationId !== sent.fromConversation).map((sent) => [sent.fromConversation!, sent.conversationId!] as const));
		while (queue.length > 0) {
			const here = queue.shift()!;
			for (const [from, to] of edges) {
				const other = from === here ? to : to === here ? from : undefined;
				if (other === undefined || reached.has(other)) continue;
				reached.add(other);
				queue.push(other);
			}
		}
		return reached;
	}

	/** For each of these message ids that this agent wrote: which run wrote it and what that run did. One pass over the record. */
	notesFor(messageIds: readonly string[]): Map<string, string> {
		const wanted = new Set(messageIds);
		const notes = new Map<string, string>();
		if (wanted.size === 0) return notes;
		for (const run of this.all())
			for (const sent of run.sent) {
				if (!sent.messageId || !wanted.has(sent.messageId) || notes.has(sent.messageId)) continue;
				const tools = Object.keys(run.tools).length > 0 ? `tools: ${toolCounts(run.tools)}${run.toolErrors ? `, ${run.toolErrors} failed` : ""}` : "no tools";
				notes.set(sent.messageId, [`run ${run.runId}`, tools, ...(run.jobsStarted.length > 0 ? [`started ${run.jobsStarted.map((job) => job.jobId).join(", ")}`] : [])].join("; "));
			}
		return notes;
	}

	/** One run in the list the model reads. */
	digest(run: RunSummary): string {
		const when = `${run.at.slice(0, 16).replace("T", " ")} (${ago(run.at, this.#now())})`;
		const outcome = run.status ? `${run.status}${run.reason ? ` (${run.reason})` : ""}${run.ms !== undefined ? ` in ${duration(run.ms)}` : ""}` : "unfinished or interrupted";
		const work = `${run.steps ?? 0} steps, ${Object.values(run.tools).reduce((sum, count) => sum + count, 0)} tool calls${Object.keys(run.tools).length > 0 ? ` (${toolCounts(run.tools)}${run.toolErrors ? `; ${run.toolErrors} failed` : ""})` : ""}`;
		const lines = [`${run.runId} · ${run.kind} · ${when} · ${outcome} · ${work}`];
		if (run.asked) lines.push(`  asked${run.by ? ` by ${run.by}` : ""}: "${cut(run.asked, 160)}"`);
		const tail = [
			...(run.answer ? [`answered: "${cut(run.answer, 160)}"`] : []),
			...(run.noReply ? [`sent no reply (${run.noReply})`] : []),
			...run.sent.map((sent) => `sent ${sent.messageId ?? "a message"}${sent.to?.length ? ` to ${sent.to.join(", ")}` : ""}${sent.conversationId ? ` in ${sent.conversationId}` : ""}${sent.via && sent.via !== "reply" ? ` (${sent.via})` : ""}`),
			...run.jobsStarted.map((job) => `started ${job.jobId}${job.label ? ` (${cut(job.label, 60)})` : ""}`),
			...(run.approvals.length > 0 ? [`${run.approvals.length} approval${run.approvals.length === 1 ? "" : "s"} asked (${run.approvals.map((entry) => `${entry.tool ?? "?"} ${entry.approved ? "approved" : "denied"}`).join(", ")})`] : []),
			...(run.conversationId ? [`conversation ${run.conversationId}`] : []),
			...(run.jobId && run.kind === "job" ? [`job ${run.jobId}`] : []),
		];
		if (tail.length > 0) lines.push(`  ${tail.join(" · ")}`);
		return lines.join("\n");
	}

	// ---- the steps of one run ---------------------------------------------------------------------------------------------------------

	/** The records of a run's file, in order. */
	records(run: RunSummary): any[] {
		const path = join(this.#dir, run.day, run.file);
		if (!existsSync(path)) return [];
		return readFileSync(path, "utf8")
			.split("\n")
			.flatMap((line) => {
				if (line === "") return [];
				try {
					return [JSON.parse(line)];
				} catch {
					return [];
				}
			});
	}

	/** The run as numbered steps, one short line each: what was said, which tools were called with what, what came back. */
	steps(run: RunSummary): Step[] {
		const records = this.records(run);
		const ended = new Map<string, any>();
		for (const record of records) if (record.type === "tool_end") ended.set(String(record.id), record);
		const steps: Step[] = [];
		let sawPrompt = false;
		for (const record of records) {
			switch (record.type) {
				case "run_start":
					steps.push({ seq: record.seq, text: `start: ${record.model ? `${record.model.provider}/${record.model.modelId}, ` : ""}prompt ${String(record.instruction ?? "").length} chars` });
					break;
				case "user":
					steps.push({ seq: record.seq, text: sawPrompt ? `message in: "${cut(textOf(record.content), STEP_CHARS)}"` : `prompt (${textOf(record.content).length} chars)` });
					sawPrompt = true;
					break;
				case "assistant": {
					const said = cut(textOf(record.content), STEP_CHARS);
					const calls = callsOf(record.content);
					steps.push({ seq: record.seq, text: `model${said ? ` says: "${said}"` : ""}${calls.length > 0 ? ` (calls ${calls.join(", ")})` : ""}${record.stopReason && record.stopReason !== "toolUse" ? ` [${record.stopReason}]` : ""}` });
					break;
				}
				case "tool_start": {
					const end = ended.get(String(record.id));
					const result = end ? `${end.isError ? "FAILED" : "ok"}${end.ms !== undefined ? ` ${duration(end.ms)}` : ""}: "${cut(textOf(end.output), 120)}"` : "no result recorded";
					steps.push({ seq: record.seq, text: `tool ${record.tool} ${cut(compact(record.args), 140)} → ${result}` });
					break;
				}
				case "tool_end":
				case "system":
					break;
				case "sent":
					steps.push({ seq: record.seq, text: `sent ${record.messageId ?? "a message"}${Array.isArray(record.to) && record.to.length > 0 ? ` to ${record.to.join(", ")}` : ""}${record.conversationId ? ` in ${record.conversationId}` : ""}${record.via ? ` (${record.via})` : ""}` });
					break;
				case "job_started":
					steps.push({ seq: record.seq, text: `started job ${record.jobId}${record.label ? ` (${cut(String(record.label), 60)})` : ""}` });
					break;
				case "approval":
					steps.push({ seq: record.seq, text: `approval for ${record.tool}: ${record.approved ? "approved" : `denied${record.reason ? ` (${cut(String(record.reason), 80)})` : ""}`}` });
					break;
				case "no_reply":
					steps.push({ seq: record.seq, text: `no reply sent (${record.why ?? "none"})` });
					break;
				case "run_end":
					steps.push({ seq: record.seq, text: `end: ${record.status}${record.reason ? ` (${record.reason})` : ""} in ${duration(record.ms)}${record.answer ? `; answer "${cut(String(record.answer), 160)}"` : ""}` });
					break;
				default:
					steps.push({ seq: record.seq, text: `${record.type}` });
			}
		}
		return steps;
	}

	/** One record in full (its tool call joined with its result), cut at `OUTPUT_CHARS` from `offset`. */
	step(run: RunSummary, seq: number, offset = 0): { text: string; more?: number } | undefined {
		const records = this.records(run);
		const record = records.find((entry) => entry.seq === seq);
		if (!record) return undefined;
		const joined = record.type === "tool_start" ? { ...record, result: records.find((entry) => entry.type === "tool_end" && entry.id === record.id) } : record;
		const text = JSON.stringify(joined, null, 1);
		const slice = text.slice(offset, offset + OUTPUT_CHARS);
		const rest = text.length - offset - slice.length;
		return { text: slice, ...(rest > 0 ? { more: rest } : {}) };
	}

	/** The steps whose text contains the words (all of them, any case), across these runs, newest run first. */
	search(runs: readonly RunSummary[], words: string, maxHits: number): { run: RunSummary; seq: number; snippet: string }[] {
		const needles = words.toLowerCase().split(/\s+/).filter(Boolean);
		if (needles.length === 0) return [];
		const hits: { run: RunSummary; seq: number; snippet: string }[] = [];
		for (const run of runs) {
			for (const record of this.records(run)) {
				if (record.type === "system" || record.type === "run_start") continue;
				const text = JSON.stringify([record.content, record.args, record.output, record.answer, record.text]);
				const lower = text.toLowerCase();
				if (!needles.every((needle) => lower.includes(needle))) continue;
				const at = lower.indexOf(needles[0]!);
				hits.push({ run, seq: record.seq, snippet: cut(text.slice(Math.max(0, at - 60), at + 160), 220) });
				if (hits.length >= maxHits) return hits;
			}
		}
		return hits;
	}

	// ---- the index --------------------------------------------------------------------------------------------------------------------

	#days(): string[] {
		try {
			return readdirSync(this.#dir).filter((name) => DAY.test(name)).sort().reverse();
		} catch {
			return [];
		}
	}

	/** The runs of one day, from its index; read again only when the index has grown. */
	#day(day: string): IndexCache {
		const path = join(this.#dir, day, INDEX_FILE);
		let stat;
		try {
			stat = statSync(path);
		} catch {
			return { size: 0, mtimeMs: 0, runs: new Map() };
		}
		const cached = this.#cache.get(path);
		if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached;
		const runs = new Map<string, RunSummary>();
		for (const line of readFileSync(path, "utf8").split("\n")) {
			if (line === "") continue;
			let entry: any;
			try {
				entry = JSON.parse(line);
			} catch {
				continue;
			}
			const file = str(entry.file);
			const runId = str(entry.runId);
			if (!file || !runId) continue;
			let run = runs.get(file);
			if (!run) {
				run = { runId, file, day, at: str(entry.at) ?? `${day}T00:00:00.000Z`, kind: "run", tools: {}, sent: [], jobsStarted: [], approvals: [] };
				runs.set(file, run);
			}
			switch (entry.t) {
				case "start":
					Object.assign(run, { at: str(entry.at) ?? run.at, kind: str(entry.kind) ?? "run", agentKey: str(entry.agentKey), conversationId: str(entry.conversationId), messageId: str(entry.messageId), jobId: str(entry.jobId), replyTo: str(entry.replyTo), by: str(entry.by), asked: str(entry.asked) });
					break;
				case "end":
					Object.assign(run, { status: str(entry.status), reason: str(entry.reason), ms: typeof entry.ms === "number" ? entry.ms : undefined, steps: typeof entry.steps === "number" ? entry.steps : undefined, tools: entry.tools && typeof entry.tools === "object" ? entry.tools : {}, toolErrors: typeof entry.toolErrors === "number" ? entry.toolErrors : undefined, tokens: typeof entry.tokens === "number" ? entry.tokens : undefined, costUsd: typeof entry.costUsd === "number" ? entry.costUsd : undefined, answer: str(entry.answer) });
					break;
				case "sent":
					run.sent.push({ messageId: str(entry.messageId), conversationId: str(entry.conversationId), to: Array.isArray(entry.to) ? entry.to.map(String) : undefined, fromConversation: str(entry.fromConversation), via: str(entry.via), at: str(entry.at) ?? run.at });
					break;
				case "job_started":
					if (str(entry.jobId)) run.jobsStarted.push({ jobId: str(entry.jobId)!, label: str(entry.label) });
					break;
				case "approval":
					run.approvals.push({ tool: str(entry.tool), approved: entry.approved === true });
					break;
				case "no_reply":
					run.noReply = str(entry.why) ?? "none";
					break;
			}
		}
		const entry = { size: stat.size, mtimeMs: stat.mtimeMs, runs };
		this.#cache.set(path, entry);
		return entry;
	}
}

const textOf = (content: unknown): string => {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return content === undefined || content === null ? "" : JSON.stringify(content);
	return content.map((block: any) => (typeof block === "string" ? block : block?.type === "text" ? String(block.text ?? "") : block?.type === "toolCall" ? "" : block?.text !== undefined ? String(block.text) : "")).join(" ");
};

const callsOf = (content: unknown): string[] => (Array.isArray(content) ? content.filter((block: any) => block?.type === "toolCall").map((block: any) => String(block.name ?? "?")) : []);

const compact = (value: unknown): string => {
	if (value === undefined) return "";
	const text = JSON.stringify(value);
	return text === undefined ? "" : text;
};

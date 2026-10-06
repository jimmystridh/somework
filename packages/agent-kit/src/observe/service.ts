import { silent, type Log } from "../log.ts";
import type { Metrics } from "../metrics.ts";
import { GrafanaError, type GrafanaClient, type LogEntry } from "./client.ts";
import type { ResolvedObserve } from "./config.ts";
import { clean, formatEntry, frame, isoSeconds } from "./format.ts";
import { ALLOWED_LABELS, parseDuration, parseLogQuery, QueryRefused, renderQuery, renderSelector, type LogQuery } from "./logql.ts";

export interface ObserveStatus {
	enabled: boolean;
	calls: number;
	errors: number;
	lastError?: string;
}

export interface ObserveDeps {
	config: ResolvedObserve;
	client: Pick<GrafanaClient, "queryRange" | "labels" | "labelValues" | "alertRules" | "searchDashboards">;
	log?: Log;
	metrics?: Metrics;
	now?: () => number;
}

/** What a tool call is refused for, said to the model as a plain sentence. */
export class ObserveRefused extends Error {
	override readonly name = "ObserveRefused";
}

const HOUR = 3_600_000;
const JOB_EVENTS = "job_finished|job_failed|job_refused|job_done|job_blocked|job_resumed";

/**
 * The service side of the observe tools: scope, limits and formatting. The tools are thin; the model never writes text that reaches Loki
 * unparsed, and nothing here can write. Every call counts against an hourly budget.
 */
export class ObserveService {
	readonly #config: ResolvedObserve;
	readonly #client: ObserveDeps["client"];
	readonly #log: Log;
	readonly #now: () => number;
	readonly #calls: number[] = [];
	readonly #count?: (labels?: Record<string, string>, by?: number) => void;
	errors = 0;
	total = 0;
	lastError?: string;

	constructor(deps: ObserveDeps) {
		this.#config = deps.config;
		this.#client = deps.client;
		this.#log = deps.log ?? silent;
		this.#now = deps.now ?? Date.now;
		this.#count = deps.metrics?.counter("somework_observe_calls_total", "Observe tool calls by tool and result");
	}

	status(): ObserveStatus {
		return { enabled: true, calls: this.total, errors: this.errors, ...(this.lastError ? { lastError: this.lastError } : {}) };
	}

	/** Runs one tool call under the budget, turns every failure into one sentence for the model and keeps the counters. */
	async run(tool: string, work: () => Promise<string>): Promise<{ text: string; ok: boolean }> {
		const now = this.#now();
		while (this.#calls.length > 0 && now - this.#calls[0]! > HOUR) this.#calls.shift();
		if (this.#calls.length >= this.#config.hourlyCalls) {
			this.#count?.({ tool, result: "budget" });
			return { text: `refused: this agent has used its ${this.#config.hourlyCalls} observe calls for the hour; try again later or work with what you have`, ok: false };
		}
		this.#calls.push(now);
		this.total++;
		try {
			const text = await work();
			this.#count?.({ tool, result: "ok" });
			return { text, ok: true };
		} catch (error) {
			this.errors++;
			if (error instanceof QueryRefused || error instanceof ObserveRefused) {
				this.#count?.({ tool, result: "refused" });
				return { text: `refused: ${error.message}`, ok: false };
			}
			const message = error instanceof GrafanaError ? error.message : "the observe call failed";
			this.lastError = clean(message, 160);
			this.#log("warn", "observe_failed", { tool, kind: error instanceof GrafanaError ? error.kind : "unknown", status: error instanceof GrafanaError ? error.status : undefined });
			this.#count?.({ tool, result: "error" });
			return { text: `Grafana could not answer: ${message}`, ok: false };
		}
	}

	#window(since: string | undefined, until: string | undefined): { startMs: number; endMs: number; sinceMs: number } {
		const now = this.#now();
		const sinceMs = since === undefined || since === "" ? this.#config.defaultRangeMs : parseDuration(since);
		const untilMs = until === undefined || until === "" ? 0 : parseDuration(until.replace(/^0$/, "0s"));
		if (sinceMs > this.#config.maxRangeMs) throw new ObserveRefused(`this agent may look back at most ${Math.round(this.#config.maxRangeMs / HOUR)} hours`);
		if (untilMs >= sinceMs) throw new ObserveRefused("until must be shorter than since (both count back from now)");
		return { startMs: now - sinceMs, endMs: now - untilMs, sinceMs };
	}

	#parse(text: string): LogQuery {
		return parseLogQuery(text, { allowMetricFunctions: this.#config.metricFunctions, maxWindowMs: this.#config.maxRangeMs });
	}

	async logsQuery(args: { query: string; since?: string; until?: string; limit?: number; order?: "newest" | "oldest" }): Promise<string> {
		const parsed = this.#parse(args.query);
		const { startMs, endMs } = this.#window(args.since, args.until);
		const limit = Math.max(1, Math.min(this.#config.maxLines, Math.floor(args.limit ?? this.#config.defaultLines)));
		const scope = this.#config.fleet ? [] : this.#config.own;
		const text = renderQuery(parsed, scope);
		const result = await this.#client.queryRange({ query: text, startMs, endMs, limit, direction: args.order === "oldest" ? "forward" : "backward" });
		const title = `Logs for ${renderSelector([...parsed.matchers, ...scope])} from ${new Date(startMs).toISOString().slice(0, 19)}Z to ${new Date(endMs).toISOString().slice(0, 19)}Z${this.#config.fleet ? "" : " (limited to this agent's own logs)"}:`;
		if (result.kind === "series") {
			const lines = result.series
				.sort((a, b) => b.total - a.total)
				.slice(0, 20)
				.map((series) => `${Object.entries(series.labels).map(([k, v]) => `${k}=${clean(v, 60)}`).join(" ") || "all"}: ${Math.round(series.total * 100) / 100}`);
			return frame(`${title} ${result.series.length} series, summed over the range.`, lines, this.#config.maxBytes);
		}
		const lines = result.entries.map(formatEntry);
		const header = `${title} ${result.entries.length} line${result.entries.length === 1 ? "" : "s"}${result.entries.length >= limit ? ` (the limit of ${limit} was reached: narrow the query or the time range for more)` : ""}.`;
		return frame(result.entries.length === 0 ? `${header} No lines matched.` : header, lines, this.#config.maxBytes);
	}

	async myHistory(args: { since?: string; limit?: number }): Promise<string> {
		if (this.#config.own.length === 0) throw new ObserveRefused("this agent has no own log scope configured (OBSERVE_OWN), so it cannot tell which logs are its own");
		const { startMs, endMs } = this.#window(args.since ?? "24h", undefined);
		const wanted = Math.max(1, Math.min(30, Math.floor(args.limit ?? 10)));
		const query: LogQuery = { matchers: [...this.#config.own], stages: [{ kind: "line", op: "|~", value: `"event":"(${JOB_EVENTS})"` }] };
		const result = await this.#client.queryRange({ query: renderQuery(query), startMs, endMs, limit: this.#config.maxLines, direction: "backward" });
		if (result.kind !== "streams") throw new ObserveRefused("unexpected answer from Loki");
		const jobs = summariseJobs(result.entries);
		const lines = jobs.slice(0, wanted).map(describeJob);
		const header = `Your own recent jobs (${Math.min(jobs.length, wanted)} of ${jobs.length} found in the last ${Math.round((endMs - startMs) / HOUR)} hours, newest first), built by the service from your structured logs. capability is shown when the log line carries it.`;
		return frame(jobs.length === 0 ? `${header} No finished, failed or refused jobs in that time.` : header, lines, this.#config.maxBytes);
	}

	async labels(args: { label?: string; since?: string; limit?: number }): Promise<string> {
		const { startMs, endMs } = this.#window(args.since ?? "6h", undefined);
		const query = this.#config.fleet ? undefined : renderSelector(this.#config.own);
		if (!args.label) {
			const present = new Set(await this.#client.labels(startMs, endMs, query));
			return `Labels you may use in a query: ${ALLOWED_LABELS.filter((name) => present.has(name)).join(", ") || "(none seen in that time)"}. Ask for one label's values by naming it.`;
		}
		if (!(ALLOWED_LABELS as readonly string[]).includes(args.label)) throw new ObserveRefused(`the label '${clean(args.label, 40)}' is not available (allowed: ${ALLOWED_LABELS.join(", ")})`);
		const values = await this.#client.labelValues(args.label, startMs, endMs, query);
		const cap = Math.max(1, Math.min(100, Math.floor(args.limit ?? 50)));
		return frame(`Values of ${args.label} seen in the last ${Math.round((endMs - startMs) / HOUR)} hours${this.#config.fleet ? "" : " in your own logs"} (${Math.min(values.length, cap)} of ${values.length}):`, values.slice(0, cap).map((value) => clean(value, 100)), this.#config.maxBytes);
	}

	async alerts(): Promise<string> {
		const rules = await this.#client.alertRules(this.#config.alertFolder);
		const order: Record<string, number> = { firing: 0, pending: 1, error: 2, nodata: 3, normal: 4, inactive: 4 };
		const lines = rules
			.sort((a, b) => (order[a.state] ?? 5) - (order[b.state] ?? 5) || a.name.localeCompare(b.name))
			.map((rule) => clean(`${rule.state.toUpperCase()} ${rule.name}${rule.since ? ` since ${rule.since.slice(0, 19)}Z` : ""}${rule.severity ? ` [${rule.severity}]` : ""}${rule.summary ? `: ${rule.summary}` : ""}`, 260));
		return frame(`Alert rules in "${this.#config.alertFolder}": ${rules.filter((r) => r.state === "firing").length} firing of ${rules.length}.`, lines, this.#config.maxBytes);
	}

	async dashboards(args: { query?: string; tag?: string; limit?: number }): Promise<string> {
		const hits = await this.#client.searchDashboards({ text: args.query ? clean(args.query, 80) : undefined, tag: args.tag ? clean(args.tag, 40) : undefined, limit: Math.max(1, Math.min(30, Math.floor(args.limit ?? 15))) });
		return frame(`Dashboards (${hits.length}); titles and addresses only, no panel data:`, hits.map((hit) => clean(`${hit.title}${hit.folder ? ` [${hit.folder}]` : ""}${hit.tags.length ? ` tags=${hit.tags.join(",")}` : ""} ${hit.url}`, 300)), this.#config.maxBytes);
	}
}

interface Job {
	taskId: string;
	at: string;
	outcome: string;
	status?: string;
	tokens?: number;
	durationMs?: number;
	costUsd?: number;
	error?: string;
	reason?: string;
	agentKey?: string;
	capability?: string;
	commits?: number;
}

/** Folds the job lines of one agent (newest first) into one record per task. */
export function summariseJobs(entries: readonly LogEntry[]): Job[] {
	const byTask = new Map<string, Job>();
	for (const entry of entries) {
		let line: Record<string, unknown>;
		try {
			line = JSON.parse(entry.line);
		} catch {
			continue;
		}
		const taskId = typeof line.taskId === "string" ? line.taskId : undefined;
		if (!taskId) continue;
		const job = byTask.get(taskId) ?? { taskId, at: isoSeconds(entry.ts), outcome: "unknown" };
		const event = String(line.event ?? "");
		if (event === "job_finished") {
			job.status = typeof line.status === "string" ? line.status : job.status;
			job.tokens = typeof line.totalTokens === "number" ? line.totalTokens : job.tokens;
			job.durationMs = typeof line.durationMs === "number" ? line.durationMs : job.durationMs;
			job.costUsd = typeof line.costUsd === "number" ? line.costUsd : job.costUsd;
			if (job.outcome === "unknown") job.outcome = "ran";
		} else if (event === "job_done") {
			job.outcome = typeof line.status === "string" ? line.status : "done";
			if (typeof line.commits === "number") job.commits = line.commits;
		} else if (event === "job_failed") {
			job.outcome = "failed";
			job.error = clean(line.error, 160);
		} else if (event === "job_refused") {
			job.outcome = "refused";
			job.reason = clean(line.reason, 120);
		} else if (event === "job_blocked") {
			job.outcome = "blocked";
			job.reason = clean(line.reason, 160);
		} else if (event === "job_resumed" && job.outcome === "unknown") job.outcome = "resumed";
		if (typeof line.agentKey === "string") job.agentKey = clean(line.agentKey, 80);
		if (typeof line.capability === "string") job.capability = clean(line.capability, 60);
		if (job.at < isoSeconds(entry.ts)) job.at = isoSeconds(entry.ts);
		byTask.set(taskId, job);
	}
	return [...byTask.values()].sort((a, b) => (a.at < b.at ? 1 : -1));
}

function describeJob(job: Job): string {
	const parts = [job.at, job.taskId, `outcome=${job.outcome}`];
	if (job.capability) parts.push(`capability=${job.capability}`);
	if (job.status) parts.push(`run=${job.status}`);
	if (job.tokens !== undefined) parts.push(`tokens=${job.tokens}`);
	if (job.durationMs !== undefined) parts.push(`seconds=${Math.round(job.durationMs / 1000)}`);
	if (job.costUsd !== undefined) parts.push(`usd=${Math.round(job.costUsd * 1000) / 1000}`);
	if (job.commits !== undefined) parts.push(`commits=${job.commits}`);
	if (job.agentKey) parts.push(`key=${job.agentKey}`);
	if (job.reason) parts.push(`reason=${job.reason}`);
	if (job.error) parts.push(`error=${job.error}`);
	return parts.join(" ");
}

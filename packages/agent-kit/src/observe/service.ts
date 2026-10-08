import { silent, type Log } from "../log.ts";
import type { Metrics } from "../metrics.ts";
import { GrafanaError, type GrafanaClient, type LogEntry } from "./client.ts";
import type { ResolvedObserve } from "./config.ts";
import { clean, formatEntry, frame, isoSeconds } from "./format.ts";
import { buildQuery, checkGroup, checkLabel, checkMatchers, checkMetric, renderMatchers, seconds, selectorOf, type PromAggregation, type PromFunction, type PromMatcher } from "./promql.ts";
import { ALLOWED_LABELS, parseDuration, parseLogQuery, QueryRefused, renderQuery, renderSelector, type LogQuery } from "./logql.ts";

export interface ObserveStatus {
	enabled: boolean;
	calls: number;
	errors: number;
	lastError?: string;
}

export interface ObserveDeps {
	config: ResolvedObserve;
	client: Pick<GrafanaClient, "queryRange" | "labels" | "labelValues" | "alertRules" | "searchDashboards" | "promQuery" | "promRange" | "promLabelValues" | "promSeriesOf" | "promMetadata">;
	/** The agent whose own series a role without fleet scope may read (the `agent` label every kit metric carries). */
	agentId?: string;
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
	readonly #agentId: string | undefined;
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
		this.#agentId = deps.agentId;
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

	/** The matchers every metrics query carries: none for a fleet role, the agent's own `agent` label otherwise. */
	#metricsScope(): PromMatcher[] {
		if (this.#config.fleet) return [];
		if (!this.#agentId) throw new ObserveRefused("this agent cannot tell which metrics are its own (no agent id), so it may not read metrics");
		return [{ label: "agent", op: "=", value: this.#agentId }];
	}

	#metricsWindow(since: string | undefined, until: string | undefined, fallback: string): { startMs: number; endMs: number; windowMs: number } {
		const now = this.#now();
		const sinceMs = parseDuration(since === undefined || since === "" ? fallback : since);
		const untilMs = until === undefined || until === "" ? 0 : parseDuration(until.replace(/^0$/, "0s"));
		if (sinceMs > this.#config.metricsMaxRangeMs) throw new ObserveRefused(`this agent may look back at most ${Math.round(this.#config.metricsMaxRangeMs / HOUR)} hours in metrics`);
		if (untilMs >= sinceMs) throw new ObserveRefused("until must be shorter than since (both count back from now)");
		return { startMs: now - sinceMs, endMs: now - untilMs, windowMs: sinceMs - untilMs };
	}

	async metricsCatalog(args: { metric?: string; contains?: string; limit?: number }): Promise<string> {
		const scope = this.#metricsScope();
		const { startMs, endMs } = this.#metricsWindow("6h", undefined, "6h");
		const note = this.#config.fleet ? "" : " (limited to this agent's own series)";
		if (args.metric === undefined || args.metric === "") {
			const names = await this.#client.promLabelValues("__name__", startMs, endMs, selectorOf(undefined, scope));
			const needle = args.contains ? clean(args.contains, 60).toLowerCase() : undefined;
			const cap = Math.max(1, Math.min(200, Math.floor(args.limit ?? 100)));
			const wanted = names.filter((name) => (needle ? name.toLowerCase().includes(needle) : true)).sort();
			return frame(`Metrics with data in the last 6 hours${note}: ${Math.min(wanted.length, cap)} of ${wanted.length}${needle ? ` containing '${needle}'` : ""}. Ask about one metric by name to see its type, labels and values.`, wanted.slice(0, cap), this.#config.maxBytes, "use contains to narrow the list");
		}
		const metric = checkMetric(args.metric);
		const [series, metadata] = await Promise.all([this.#client.promSeriesOf(selectorOf(metric, scope)!, startMs, endMs), this.#client.promMetadata(metric).catch(() => undefined)]);
		if (series.length === 0) return frame(`No series for ${metric} in the last 6 hours${note}.`, [], this.#config.maxBytes);
		const values = new Map<string, Set<string>>();
		for (const labels of series) for (const [name, value] of Object.entries(labels)) if (name !== "__name__") (values.get(name) ?? values.set(name, new Set()).get(name)!).add(value);
		const lines = [...values.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, set]) => {
			const shown = [...set].sort().slice(0, 15).map((value) => clean(value, 60));
			return `${name}: ${shown.join(", ")}${set.size > 15 ? `, ... (${set.size} values)` : ""}`;
		});
		const kind = metadata ? ` ${metadata.type}${metadata.help ? ` - ${clean(metadata.help, 160)}` : ""}.` : "";
		return frame(`${metric}:${kind} ${series.length} series${note}. Labels and the values seen:`, lines, this.#config.maxBytes);
	}

	async metricsQuery(args: {
		metric: string;
		matchers?: PromMatcher[];
		fn?: PromFunction;
		window?: string;
		agg?: PromAggregation;
		by?: string[];
		quantile?: number;
		since?: string;
		until?: string;
		step?: string;
		limit?: number;
	}): Promise<string> {
		const scope = this.#metricsScope();
		const metric = checkMetric(args.metric);
		const matchers = checkMatchers(args.matchers);
		const by = checkGroup(args.by);
		const fn = args.fn ?? "last";
		const range = args.step !== undefined && args.step !== "";
		const { startMs, endMs, windowMs: spanMs } = this.#metricsWindow(args.since, args.until, range ? "1h" : "5m");
		const windowMs = parseDuration(args.window || "5m");
		if (windowMs > this.#config.metricsMaxRangeMs) throw new ObserveRefused("the window is longer than this agent may look back");
		const query = buildQuery({ metric, matchers, scope, fn, windowMs, ...(args.agg ? { agg: args.agg } : {}), by, ...(args.quantile !== undefined ? { quantile: args.quantile } : {}) });
		const cap = Math.max(1, Math.min(30, Math.floor(args.limit ?? 20)));
		const title = query;
		if (!range) {
			const series = await this.#client.promQuery(query, endMs);
			const rows = series.map((item) => ({ labels: item.labels, value: item.points.at(-1)?.[1] ?? Number.NaN })).sort((a, b) => b.value - a.value);
			const lines = rows.slice(0, cap).map((row) => `${describeLabels(row.labels)}: ${formatNumber(row.value)}`);
			return frame(`${clean(title, 400)} at ${new Date(endMs).toISOString().slice(0, 19)}Z: ${rows.length} series${rows.length > cap ? `, the ${cap} highest shown` : ""}.`, lines, this.#config.maxBytes, "group with by or narrow with matchers");
		}
		const stepSeconds = Math.max(15, Math.round(parseDuration(args.step!) / 1000));
		if (spanMs / 1000 / stepSeconds > 500) throw new ObserveRefused("that is too many points: use a longer step");
		const series = await this.#client.promRange({ query, startMs, endMs, stepSeconds });
		const rows = series.map((item) => ({ labels: item.labels, points: item.points.filter(([, value]) => Number.isFinite(value)) })).filter((row) => row.points.length > 0).sort((a, b) => peak(b.points) - peak(a.points));
		const lines = rows.slice(0, cap).map((row) => {
			const values = row.points.map(([, value]) => value);
			const sampled = downsample(row.points, 12).map(([, value]) => formatNumber(value)).join(" ");
			return `${describeLabels(row.labels)}: last=${formatNumber(values.at(-1)!)} min=${formatNumber(Math.min(...values))} max=${formatNumber(Math.max(...values))} points[${stepSeconds}s step, oldest first]=${sampled}`;
		});
		return frame(`${clean(title, 400)} from ${new Date(startMs).toISOString().slice(0, 19)}Z to ${new Date(endMs).toISOString().slice(0, 19)}Z: ${rows.length} series${rows.length > cap ? `, the ${cap} with the highest peak shown` : ""}.`, lines, this.#config.maxBytes, "group with by or narrow with matchers");
	}

	/** Tokens by kind and cost over a period, grouped by agent, role, provider and model (default: agent, provider, model). */
	async llmUsage(args: { since?: string; until?: string; group?: string[]; limit?: number }): Promise<string> {
		const scope = this.#metricsScope();
		const { endMs, windowMs } = this.#metricsWindow(args.since, args.until, "24h");
		const group = args.group && args.group.length > 0 ? args.group.map((label) => checkLabel(label, "grouping label")) : ["agent", "provider", "model"];
		const allowed = ["agent", "role", "provider", "model"];
		const unknown = group.filter((label) => !allowed.includes(label));
		if (unknown.length > 0) throw new ObserveRefused(`group by ${allowed.join(", ")} (not ${unknown.join(", ")})`);
		const window = `[${seconds(windowMs)}]`;
		const matchers = renderMatchers(scope);
		const by = (extra: string[]) => `by (${[...group, ...extra].join(",")})`;
		const [tokens, cost] = await Promise.all([
			this.#client.promQuery(`sum ${by(["kind"])} (increase(somework_llm_tokens_total${matchers}${window}))`, endMs),
			this.#client.promQuery(`sum ${by([])} (increase(somework_llm_cost_usd_total${matchers}${window}))`, endMs),
		]);
		const rows = new Map<string, { labels: Record<string, string>; kinds: Record<string, number>; usd: number }>();
		const row = (labels: Record<string, string>) => {
			const id = group.map((label) => labels[label] ?? "").join("\u0000");
			return rows.get(id) ?? rows.set(id, { labels: Object.fromEntries(group.map((label) => [label, labels[label] ?? "-"])), kinds: {}, usd: 0 }).get(id)!;
		};
		for (const item of tokens) row(item.labels).kinds[item.labels.kind ?? "other"] = item.points.at(-1)?.[1] ?? 0;
		for (const item of cost) row(item.labels).usd += item.points.at(-1)?.[1] ?? 0;
		const all = [...rows.values()].filter((entry) => entry.usd > 0 || Object.values(entry.kinds).some((value) => value >= 0.5)).sort((a, b) => b.usd - a.usd || sum(b.kinds) - sum(a.kinds));
		const cap = Math.max(1, Math.min(50, Math.floor(args.limit ?? 25)));
		const lines = all.slice(0, cap).map((entry) => `${describeLabels(entry.labels)}: input=${whole(entry.kinds.input)} output=${whole(entry.kinds.output)} cache_read=${whole(entry.kinds.cache_read)} cache_write=${whole(entry.kinds.cache_write)} usd=${entry.usd.toFixed(4)}`);
		const total = { input: 0, output: 0, usd: 0 };
		for (const entry of all) {
			total.input += entry.kinds.input ?? 0;
			total.output += entry.kinds.output ?? 0;
			total.usd += entry.usd;
		}
		const hours = Math.round((windowMs / HOUR) * 10) / 10;
		return frame(`Model usage over the ${hours} hours before ${new Date(endMs).toISOString().slice(0, 19)}Z${this.#config.fleet ? "" : " (this agent only)"}, grouped by ${group.join(", ")}, most expensive first: ${all.length} rows, input=${whole(total.input)} output=${whole(total.output)} usd=${total.usd.toFixed(4)} in total. Counts are increases of the counters and approximate at the edges of the period.`, lines, this.#config.maxBytes, "use a shorter period or group by fewer labels");
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

const sum = (values: Record<string, number>): number => Object.values(values).reduce((total, value) => total + value, 0);
const whole = (value: number | undefined): string => String(Math.round(value ?? 0));
const peak = (points: readonly [number, number][]): number => points.reduce((best, [, value]) => (Number.isFinite(value) && value > best ? value : best), -Infinity);

function formatNumber(value: number): string {
	if (!Number.isFinite(value)) return String(value);
	if (Number.isInteger(value)) return String(value);
	return Math.abs(value) >= 100 ? value.toFixed(1) : Math.abs(value) >= 1 ? value.toFixed(3) : String(Number(value.toPrecision(3)));
}

const describeLabels = (labels: Record<string, string>): string => {
	const shown = Object.entries(labels).filter(([name]) => name !== "__name__").map(([name, value]) => `${name}=${clean(value, 60)}`);
	return shown.length > 0 ? shown.join(" ") : "all";
};

function downsample<T>(points: readonly T[], most: number): T[] {
	if (points.length <= most) return [...points];
	return Array.from({ length: most }, (_, i) => points[Math.round((i * (points.length - 1)) / (most - 1))]!);
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

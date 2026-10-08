import { QueryRefused } from "./logql.ts";

/**
 * Builds the PromQL the metrics tools send. The model never writes PromQL: it names a metric, matchers, a function, a grouping and a window,
 * every part is validated here, and the text is assembled from them with the scope's matchers added, so a query cannot reach another
 * agent's series, a subquery, a second metric or a function that is not listed.
 */

export type PromMatcherOp = "=" | "!=" | "=~" | "!~";

export interface PromMatcher {
	label: string;
	op: PromMatcherOp;
	value: string;
}

export const PROM_FUNCTIONS = ["rate", "increase", "avg_over_time", "max_over_time", "min_over_time", "last", "quantile"] as const;
export type PromFunction = (typeof PROM_FUNCTIONS)[number];

export const PROM_AGGREGATIONS = ["sum", "avg", "max", "min", "count"] as const;
export type PromAggregation = (typeof PROM_AGGREGATIONS)[number];

const METRIC = /^[a-zA-Z_:][a-zA-Z0-9_:]{0,100}$/;
const LABEL = /^[a-zA-Z_][a-zA-Z0-9_]{0,40}$/;
const MAX_MATCHERS = 8;
const MAX_GROUP_LABELS = 5;
const MAX_VALUE = 200;
const OPS: readonly string[] = ["=", "!=", "=~", "!~"];

export function checkMetric(name: unknown): string {
	if (typeof name !== "string" || !METRIC.test(name)) throw new QueryRefused("the metric must be a plain metric name such as somework_llm_tokens_total");
	return name;
}

export function checkLabel(name: unknown, what = "label"): string {
	if (typeof name !== "string" || !LABEL.test(name) || name.startsWith("__")) throw new QueryRefused(`'${String(name).slice(0, 40)}' is not a usable ${what} name`);
	return name;
}

export function checkMatchers(matchers: readonly PromMatcher[] | undefined): PromMatcher[] {
	const list = matchers ?? [];
	if (list.length > MAX_MATCHERS) throw new QueryRefused(`at most ${MAX_MATCHERS} matchers`);
	return list.map((matcher) => {
		if (!OPS.includes(matcher.op)) throw new QueryRefused("a matcher operator is one of =, !=, =~, !~");
		const value = String(matcher.value ?? "");
		if (value.length > MAX_VALUE) throw new QueryRefused(`a matcher value may be at most ${MAX_VALUE} characters`);
		if (/[\u0000-\u001f\u007f]/.test(value)) throw new QueryRefused("a matcher value may not contain control characters");
		return { label: checkLabel(matcher.label), op: matcher.op, value };
	});
}

export function checkGroup(labels: readonly string[] | undefined): string[] {
	const list = labels ?? [];
	if (list.length > MAX_GROUP_LABELS) throw new QueryRefused(`group by at most ${MAX_GROUP_LABELS} labels`);
	return list.map((label) => checkLabel(label, "grouping label"));
}

const quote = (value: string): string => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

export const renderMatchers = (matchers: readonly PromMatcher[]): string => `{${matchers.map((m) => `${m.label}${m.op}${quote(m.value)}`).join(",")}}`;

/** A window as PromQL wants it: whole seconds. */
export const seconds = (ms: number): string => `${Math.max(1, Math.round(ms / 1000))}s`;

export interface PromQueryParts {
	metric: string;
	matchers: readonly PromMatcher[];
	/** Matchers of the scope, always applied. */
	scope: readonly PromMatcher[];
	fn: PromFunction;
	windowMs: number;
	agg?: PromAggregation;
	by?: readonly string[];
	quantile?: number;
}

/** The PromQL text of a structured query. */
export function buildQuery(parts: PromQueryParts): string {
	const all = [...parts.matchers, ...parts.scope];
	const by = parts.by ?? [];
	const grouping = by.length > 0 ? ` by (${by.join(",")})` : "";
	const window = `[${seconds(parts.windowMs)}]`;
	if (parts.fn === "quantile") {
		const q = parts.quantile ?? 0.95;
		if (!(q > 0 && q < 1)) throw new QueryRefused("quantile must be between 0 and 1 (for example 0.95)");
		const base = parts.metric.replace(/_bucket$/, "");
		const grouped = ["le", ...by.filter((label) => label !== "le")].join(",");
		return `histogram_quantile(${q}, sum by (${grouped}) (rate(${base}_bucket${renderMatchers(all)}${window})))`;
	}
	const selector = `${parts.metric}${renderMatchers(all)}`;
	const inner = parts.fn === "last" ? selector : `${parts.fn}(${selector}${window})`;
	const agg = parts.agg ?? (by.length > 0 ? "sum" : undefined);
	return agg ? `${agg}${grouping} (${inner})` : inner;
}

/** A series selector for the catalog calls (`series` and label values). */
export const selectorOf = (metric: string | undefined, scope: readonly PromMatcher[]): string | undefined => {
	if (!metric && scope.length === 0) return undefined;
	return `${metric ?? ""}${renderMatchers(scope)}`;
};

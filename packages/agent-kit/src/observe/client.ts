import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";

export type GrafanaErrorKind = "unreachable" | "unauthorized" | "forbidden" | "not_found" | "bad_request" | "server" | "too_large" | "bad_response";

export class GrafanaError extends Error {
	override readonly name = "GrafanaError";
	readonly kind: GrafanaErrorKind;
	readonly status?: number;
	constructor(kind: GrafanaErrorKind, message: string, status?: number) {
		super(message);
		this.kind = kind;
		this.status = status;
	}
}

export interface GrafanaClientOptions {
	url: string;
	/** The service account token (a Viewer): read from a file by the service, never visible to the sandbox. */
	token: () => string;
	caPem?: string;
	lokiUid: string;
	/** The Prometheus data source (default "cluster-prometheus"). */
	promUid?: string;
	timeoutMs?: number;
	maxResponseBytes?: number;
}

export interface LogEntry {
	/** Nanoseconds since the epoch, as Loki reports it. */
	ts: string;
	line: string;
	labels: Record<string, string>;
}

export type RangeResult = { kind: "streams"; entries: LogEntry[] } | { kind: "series"; series: { labels: Record<string, string>; total: number }[] };

export interface PromSeries {
	labels: Record<string, string>;
	/** Unix seconds and value, oldest first; an instant query has one point. */
	points: [number, number][];
}

export interface AlertRule {
	name: string;
	state: string;
	since?: string;
	summary?: string;
	severity?: string;
	group?: string;
}

export interface DashboardHit {
	title: string;
	folder?: string;
	url: string;
	tags: string[];
}

const SEARCH_LIMIT = 50;

export function readTokenFile(path: string): () => string {
	return () => {
		const token = readFileSync(path, "utf8").trim();
		if (token.length < 8) throw new GrafanaError("unauthorized", "the Grafana token file is empty");
		return token;
	};
}

/**
 * A read-only client of Grafana: GET requests to the data source proxy of one Loki data source, the rules list and the search, to the one
 * origin it was given and nowhere else, no redirects followed, a time limit and a size limit on every call. Error messages never carry the
 * token.
 */
export class GrafanaClient {
	readonly #base: URL;
	readonly #options: GrafanaClientOptions;

	constructor(options: GrafanaClientOptions) {
		this.#base = new URL(options.url);
		if (this.#base.protocol !== "https:" && this.#base.protocol !== "http:") throw new Error("the Grafana address must be http or https");
		this.#options = options;
	}

	async #get(path: string, params: Record<string, string | number | undefined> = {}): Promise<unknown> {
		const url = new URL(path, this.#base);
		if (url.origin !== this.#base.origin) throw new GrafanaError("bad_request", "refusing to call another host");
		for (const [name, value] of Object.entries(params)) if (value !== undefined && value !== "") url.searchParams.set(name, String(value));
		const secure = url.protocol === "https:";
		const maxBytes = this.#options.maxResponseBytes ?? 4_000_000;
		const response = await new Promise<{ status: number; body: string; location?: string }>((resolve, reject) => {
			const req = (secure ? https : http).request(
				url,
				{ method: "GET", headers: { authorization: `Bearer ${this.#options.token()}`, accept: "application/json" }, ...(secure && this.#options.caPem ? { ca: this.#options.caPem } : {}) },
				(res) => {
					const chunks: Buffer[] = [];
					let size = 0;
					res.on("data", (chunk: Buffer) => {
						size += chunk.length;
						if (size > maxBytes) {
							res.destroy();
							req.destroy();
							reject(new GrafanaError("too_large", "the answer is larger than the limit: narrow the query"));
							return;
						}
						chunks.push(chunk);
					});
					res.on("error", (error) => reject(error));
					res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8"), location: res.headers.location }));
				},
			);
			req.setTimeout(this.#options.timeoutMs ?? 15_000, () => {
				req.destroy();
				reject(new GrafanaError("unreachable", "Grafana did not answer in time"));
			});
			req.on("error", (error) => reject(error));
			req.end();
		}).catch((error: unknown) => {
			if (error instanceof GrafanaError) throw error;
			throw new GrafanaError("unreachable", `Grafana could not be reached: ${error instanceof Error ? error.message.slice(0, 120) : "network error"}`);
		});
		if (response.status >= 300 && response.status < 400) throw new GrafanaError("bad_response", "Grafana answered with a redirect, which is not followed", response.status);
		if (response.status === 401) throw new GrafanaError("unauthorized", "Grafana refused the token", 401);
		if (response.status === 403) throw new GrafanaError("forbidden", "Grafana says the token may not read this", 403);
		if (response.status === 404) throw new GrafanaError("not_found", "Grafana has no such thing", 404);
		if (response.status >= 400 && response.status < 500) throw new GrafanaError("bad_request", `the data source refused the query: ${response.body.replace(/\s+/g, " ").slice(0, 200)}`, response.status);
		if (response.status >= 500) throw new GrafanaError("server", `Grafana failed (${response.status})`, response.status);
		try {
			return JSON.parse(response.body);
		} catch {
			throw new GrafanaError("bad_response", "Grafana answered with something that is not JSON", response.status);
		}
	}

	#loki(path: string): string {
		return `/api/datasources/proxy/uid/${encodeURIComponent(this.#options.lokiUid)}/loki/api/v1/${path}`;
	}

	#prom(path: string): string {
		return `/api/datasources/proxy/uid/${encodeURIComponent(this.#options.promUid ?? "cluster-prometheus")}/api/v1/${path}`;
	}

	#promSeries(body: unknown): PromSeries[] {
		const data = (body as { data?: { resultType?: string; result?: any[] } })?.data;
		if (!data || !Array.isArray(data.result)) throw new GrafanaError("bad_response", "Prometheus answered in a shape this tool does not know");
		const number = (value: unknown) => Number(value);
		if (data.resultType === "vector") return data.result.map((item) => ({ labels: item.metric ?? {}, points: [[number(item.value?.[0]), number(item.value?.[1])]] }));
		if (data.resultType === "matrix") return data.result.map((item) => ({ labels: item.metric ?? {}, points: (item.values ?? []).map((point: [number, string]) => [number(point[0]), number(point[1])]) }));
		throw new GrafanaError("bad_response", `Prometheus answered with a ${String(data.resultType)}, which this tool does not read`);
	}

	/** An instant PromQL query at `atMs`; the text is built by the service from validated parts, never taken from the model. */
	async promQuery(query: string, atMs: number): Promise<PromSeries[]> {
		return this.#promSeries(await this.#get(this.#prom("query"), { query, time: Math.floor(atMs / 1000) }));
	}

	async promRange(request: { query: string; startMs: number; endMs: number; stepSeconds: number }): Promise<PromSeries[]> {
		return this.#promSeries(await this.#get(this.#prom("query_range"), { query: request.query, start: Math.floor(request.startMs / 1000), end: Math.floor(request.endMs / 1000), step: request.stepSeconds }));
	}

	/** Metric names (no `label`) or the values of one label, optionally limited to the series matching `match`. */
	async promLabelValues(label: string, startMs: number, endMs: number, match?: string): Promise<string[]> {
		const body = (await this.#get(this.#prom(`label/${encodeURIComponent(label)}/values`), { start: Math.floor(startMs / 1000), end: Math.floor(endMs / 1000), "match[]": match })) as { data?: string[] };
		return Array.isArray(body?.data) ? body.data.map(String) : [];
	}

	/** The label sets of the series matching `match`. */
	async promSeriesOf(match: string, startMs: number, endMs: number): Promise<Record<string, string>[]> {
		const body = (await this.#get(this.#prom("series"), { "match[]": match, start: Math.floor(startMs / 1000), end: Math.floor(endMs / 1000) })) as { data?: Record<string, string>[] };
		return Array.isArray(body?.data) ? body.data : [];
	}

	/** The type and help text of a metric, as its exporter declared them. */
	async promMetadata(metric: string): Promise<{ type: string; help: string } | undefined> {
		const body = (await this.#get(this.#prom("metadata"), { metric, limit: 1 })) as { data?: Record<string, { type?: string; help?: string }[]> };
		const first = body?.data?.[metric]?.[0];
		return first ? { type: String(first.type ?? "unknown"), help: String(first.help ?? "") } : undefined;
	}

	async queryRange(request: { query: string; startMs: number; endMs: number; limit: number; direction: "backward" | "forward" }): Promise<RangeResult> {
		const body = (await this.#get(this.#loki("query_range"), {
			query: request.query,
			start: `${request.startMs}000000`,
			end: `${request.endMs}000000`,
			limit: request.limit,
			direction: request.direction,
			step: 60,
		})) as { data?: { resultType?: string; result?: any[] } };
		const data = body?.data;
		if (!data || !Array.isArray(data.result)) throw new GrafanaError("bad_response", "Loki answered in a shape this tool does not know");
		if (data.resultType === "matrix") {
			return {
				kind: "series",
				series: data.result.map((item) => ({ labels: item.metric ?? {}, total: (item.values ?? []).reduce((sum: number, point: [number, string]) => sum + Number(point[1] ?? 0), 0) })),
			};
		}
		const entries: LogEntry[] = [];
		for (const stream of data.result) for (const value of stream.values ?? []) entries.push({ ts: String(value[0]), line: String(value[1] ?? ""), labels: stream.stream ?? {} });
		entries.sort((a, b) => (a.ts === b.ts ? 0 : BigInt(a.ts) < BigInt(b.ts) ? -1 : 1));
		if (request.direction === "backward") entries.reverse();
		return { kind: "streams", entries };
	}

	async labels(startMs: number, endMs: number, query?: string): Promise<string[]> {
		const body = (await this.#get(this.#loki("labels"), { start: `${startMs}000000`, end: `${endMs}000000`, query })) as { data?: string[] };
		return Array.isArray(body?.data) ? body.data.map(String) : [];
	}

	async labelValues(label: string, startMs: number, endMs: number, query?: string): Promise<string[]> {
		const body = (await this.#get(this.#loki(`label/${encodeURIComponent(label)}/values`), { start: `${startMs}000000`, end: `${endMs}000000`, query })) as { data?: string[] };
		return Array.isArray(body?.data) ? body.data.map(String) : [];
	}

	/** The state of the Grafana-managed alert rules whose folder is `folder`. */
	async alertRules(folder: string): Promise<AlertRule[]> {
		const body = (await this.#get("/api/prometheus/grafana/api/v1/rules")) as { data?: { groups?: any[] } };
		const out: AlertRule[] = [];
		for (const group of body?.data?.groups ?? []) {
			if (group.file !== folder) continue;
			for (const rule of group.rules ?? []) {
				out.push({
					name: String(rule.name ?? ""),
					state: String(rule.state ?? "unknown"),
					...(rule.activeAt && !String(rule.activeAt).startsWith("0001") ? { since: String(rule.activeAt) } : {}),
					...(rule.annotations?.summary ? { summary: String(rule.annotations.summary) } : {}),
					...(rule.labels?.severity ? { severity: String(rule.labels.severity) } : {}),
					group: String(group.name ?? ""),
				});
			}
		}
		return out;
	}

	async searchDashboards(query: { text?: string; tag?: string; limit?: number }): Promise<DashboardHit[]> {
		const body = (await this.#get("/api/search", { type: "dash-db", query: query.text, tag: query.tag, limit: Math.min(query.limit ?? 20, SEARCH_LIMIT) })) as any[];
		if (!Array.isArray(body)) throw new GrafanaError("bad_response", "Grafana's search answered in a shape this tool does not know");
		return body.map((hit) => ({ title: String(hit.title ?? ""), ...(hit.folderTitle ? { folder: String(hit.folderTitle) } : {}), url: `${this.#base.origin}${String(hit.url ?? "")}`, tags: Array.isArray(hit.tags) ? hit.tags.map(String) : [] }));
	}
}

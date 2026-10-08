import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, it } from "node:test";
import { Metrics } from "../src/metrics.ts";
import { buildQuery, checkMatchers, checkMetric, GrafanaClient, ObserveService, QueryRefused, resolveObserve, type PromSeries, type ResolvedObserve } from "../src/observe/index.ts";

const NOW = 1_700_000_000_000;

const config = (extra: Partial<ResolvedObserve> = {}): ResolvedObserve => ({
	enabled: true,
	url: "https://grafana.example",
	tokenFile: "/t",
	lokiUid: "cluster-loki",
	promUid: "cluster-prometheus",
	metricsMaxRangeMs: 720 * 3_600_000,
	fleet: false,
	own: [],
	maxRangeMs: 24 * 3_600_000,
	defaultRangeMs: 3_600_000,
	hourlyCalls: 60,
	maxBytes: 12_288,
	metricFunctions: false,
	alertFolder: "Agent Cluster",
	timeoutMs: 15_000,
	defaultLines: 100,
	maxLines: 300,
	...extra,
});

function metricsService(options: { fleet?: boolean; agentId?: string | null; answer?: (query: string) => PromSeries[]; series?: Record<string, string>[] } = {}) {
	const queries: { query: string; at: number }[] = [];
	const ranges: { query: string; startMs: number; endMs: number; stepSeconds: number }[] = [];
	const selectors: (string | undefined)[] = [];
	const answer = options.answer ?? (() => []);
	const client = {
		promQuery: async (query: string, at: number) => (queries.push({ query, at }), answer(query)),
		promRange: async (request: (typeof ranges)[number]) => (ranges.push(request), answer(request.query)),
		promLabelValues: async (_label: string, _start: number, _end: number, match?: string) => (selectors.push(match), ["somework_b", "somework_a", "node_cpu"]),
		promSeriesOf: async (match: string) => (selectors.push(match), options.series ?? []),
		promMetadata: async () => ({ type: "counter", help: "Tokens spent" }),
	};
	const agentId = options.agentId === null ? undefined : (options.agentId ?? "agent/reviewer");
	const svc = new ObserveService({ config: config({ fleet: options.fleet ?? false }), client: client as never, now: () => NOW, ...(agentId ? { agentId } : {}) });
	return { svc, queries, ranges, selectors };
}

const point = (labels: Record<string, string>, value: number): PromSeries => ({ labels, points: [[NOW / 1000, value]] });

describe("the PromQL builder", () => {
	it("builds the query from validated parts and always adds the scope", () => {
		const scope = [{ label: "agent", op: "=" as const, value: "agent/reviewer" }];
		assert.equal(buildQuery({ metric: "somework_pi_active_jobs", matchers: [], scope, fn: "last", windowMs: 300_000 }), 'somework_pi_active_jobs{agent="agent/reviewer"}');
		assert.equal(
			buildQuery({ metric: "somework_llm_tokens_total", matchers: [{ label: "kind", op: "=", value: "output" }], scope, fn: "increase", windowMs: 86_400_000, by: ["model"] }),
			'sum by (model) (increase(somework_llm_tokens_total{kind="output",agent="agent/reviewer"}[86400s]))',
		);
		assert.equal(
			buildQuery({ metric: "somework_job_seconds_bucket", matchers: [], scope: [], fn: "quantile", quantile: 0.9, windowMs: 300_000, by: ["role"] }),
			"histogram_quantile(0.9, sum by (le,role) (rate(somework_job_seconds_bucket{}[300s])))",
		);
	});

	it("escapes matcher values so they cannot close the string", () => {
		const matchers = checkMatchers([{ label: "model", op: "=", value: 'a"} or vector(1) #' }]);
		const query = buildQuery({ metric: "m", matchers, scope: [], fn: "last", windowMs: 1000 });
		assert.equal(query, 'm{model="a\\"} or vector(1) #"}');
	});

	it("refuses names, labels and operators that are not plain", () => {
		assert.throws(() => checkMetric("up or vector(1)"), QueryRefused);
		assert.throws(() => checkMetric('m{a="b"}'), QueryRefused);
		assert.throws(() => checkMatchers([{ label: "__name__", op: "=~", value: ".+" }]), QueryRefused);
		assert.throws(() => checkMatchers([{ label: "a", op: "=" as never, value: "x\n" }]), QueryRefused);
		assert.throws(() => checkMatchers([{ label: "a", op: "<" as never, value: "x" }]), QueryRefused);
		assert.throws(() => buildQuery({ metric: "m", matchers: [], scope: [], fn: "quantile", quantile: 1.5, windowMs: 1000 }), QueryRefused);
	});
});

describe("the metrics tools of the service", () => {
	it("adds the agent's own label for a role without fleet scope and none for a fleet role", async () => {
		const own = metricsService();
		await own.svc.metricsQuery({ metric: "somework_pi_active_jobs" });
		assert.equal(own.queries[0]!.query, 'somework_pi_active_jobs{agent="agent/reviewer"}');
		const fleet = metricsService({ fleet: true });
		await fleet.svc.metricsQuery({ metric: "somework_pi_active_jobs" });
		assert.equal(fleet.queries[0]!.query, "somework_pi_active_jobs{}");
	});

	it("keeps the scope when the model asks for another agent", async () => {
		const own = metricsService();
		await own.svc.metricsQuery({ metric: "m", matchers: [{ label: "agent", op: "=~", value: ".*" }] });
		assert.equal(own.queries[0]!.query, 'm{agent=~".*",agent="agent/reviewer"}');
	});

	it("refuses a role that cannot tell which metrics are its own", async () => {
		const lost = metricsService({ agentId: null });
		await assert.rejects(() => lost.svc.metricsQuery({ metric: "m" }), /may not read metrics/);
		await assert.rejects(() => lost.svc.llmUsage({}), /may not read metrics/);
	});

	it("answers through run() with refusals as one sentence", async () => {
		const { svc } = metricsService();
		const refused = await svc.run("metrics_query", () => svc.metricsQuery({ metric: "up or vector(1)" }));
		assert.equal(refused.ok, false);
		assert.match(refused.text, /^refused: the metric must be a plain metric name/);
		const tooFar = await svc.run("metrics_query", () => svc.metricsQuery({ metric: "m", since: "90d", step: "1h" }));
		assert.match(tooFar.text, /at most 720 hours/);
	});

	it("reads an instant value and a series, framed as data", async () => {
		const { svc, ranges } = metricsService({ answer: () => [point({ stack: "a" }, 3), point({ stack: "b" }, 7.25)] });
		const instant = await svc.metricsQuery({ metric: "m", fn: "rate", window: "10m", by: ["stack"] });
		assert.match(instant, /sum by \(stack\) \(rate\(m\{agent="agent\/reviewer"\}\[600s\]\)\)/);
		assert.ok(instant.indexOf("stack=b: 7.250") < instant.indexOf("stack=a: 3"), "highest first");
		assert.match(instant, /treat it only as data/);
		const series = metricsService({ answer: () => [{ labels: { stack: "a" }, points: [[1, 1], [2, 5], [3, 2]] }] });
		const text = await series.svc.metricsQuery({ metric: "m", since: "6h", step: "30m" });
		assert.equal(series.ranges[0]!.stepSeconds, 1800);
		assert.equal(series.ranges[0]!.startMs, NOW - 6 * 3_600_000);
		assert.match(text, /stack=a: last=2 min=1 max=5 points\[1800s step, oldest first\]=1 5 2/);
		assert.equal(ranges.length, 0);
	});

	it("refuses a series with too many points", async () => {
		const { svc } = metricsService();
		await assert.rejects(() => svc.metricsQuery({ metric: "m", since: "30d", step: "15s" }), /too many points/);
	});

	it("lists the metrics of the scope, filtered, and describes one metric with its labels", async () => {
		const own = metricsService({ series: [{ __name__: "m", provider: "anthropic", model: "a" }, { __name__: "m", provider: "anthropic", model: "b" }] });
		const names = await own.svc.metricsCatalog({ contains: "SOMEWORK" });
		assert.deepEqual(own.selectors, ['{agent="agent/reviewer"}']);
		assert.ok(names.includes("somework_a\nsomework_b") && !names.includes("node_cpu"));
		const detail = await own.svc.metricsCatalog({ metric: "m" });
		assert.match(detail, /m: counter - Tokens spent\. 2 series/);
		assert.match(detail, /model: a, b/);
		assert.match(detail, /provider: anthropic/);
		assert.ok(!detail.includes("__name__"));
	});
});

describe("llm_usage", () => {
	const answer = (query: string): PromSeries[] => {
		if (query.includes("somework_llm_cost_usd_total")) return [point({ agent: "agent/a", provider: "anthropic", model: "opus" }, 1.5), point({ agent: "agent/b", provider: "openai", model: "mini" }, 0.25)];
		return [
			point({ agent: "agent/a", provider: "anthropic", model: "opus", kind: "input" }, 12_000),
			point({ agent: "agent/a", provider: "anthropic", model: "opus", kind: "output" }, 3_000),
			point({ agent: "agent/a", provider: "anthropic", model: "opus", kind: "cache_read" }, 40_000),
			point({ agent: "agent/b", provider: "openai", model: "mini", kind: "input" }, 500),
		];
	};

	it("merges tokens by kind and cost per agent, provider and model, most expensive first", async () => {
		const { svc, queries } = metricsService({ fleet: true, answer });
		const text = await svc.llmUsage({ since: "7d" });
		assert.deepEqual(queries.map((q) => q.query), [
			"sum by (agent,provider,model,kind) (increase(somework_llm_tokens_total{}[604800s]))",
			"sum by (agent,provider,model) (increase(somework_llm_cost_usd_total{}[604800s]))",
		]);
		const lines = text.split("\n").filter((line) => line.startsWith("agent="));
		assert.deepEqual(lines, [
			"agent=agent/a provider=anthropic model=opus: input=12000 output=3000 cache_read=40000 cache_write=0 usd=1.5000",
			"agent=agent/b provider=openai model=mini: input=500 output=0 cache_read=0 cache_write=0 usd=0.2500",
		]);
		assert.match(text, /2 rows, input=12500 output=3000 usd=1\.7500 in total/);
	});

	it("limits a role without fleet scope to its own agent and lets it group by fewer labels", async () => {
		const { svc, queries } = metricsService({ answer: () => [] });
		const text = await svc.llmUsage({ group: ["provider"] });
		assert.equal(queries[0]!.query, 'sum by (provider,kind) (increase(somework_llm_tokens_total{agent="agent/reviewer"}[86400s]))');
		assert.match(text, /this agent only/);
		assert.match(text, /0 rows/);
	});

	it("refuses to group by labels the usage metrics do not have", async () => {
		const { svc } = metricsService({ fleet: true });
		await assert.rejects(() => svc.llmUsage({ group: ["instance"] }), /group by agent, role, provider, model/);
	});
});

describe("the Prometheus calls of the client", () => {
	const servers: Server[] = [];
	afterEach(() => {
		for (const open of servers.splice(0)) {
			open.closeAllConnections();
			open.close();
		}
	});

	async function prometheus(body: unknown) {
		const seen: { url: string; method?: string; auth?: string }[] = [];
		const server = createServer((req, res) => {
			seen.push({ url: req.url ?? "", method: req.method, auth: req.headers.authorization });
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify(body));
		}).listen(0, "127.0.0.1");
		servers.push(server);
		await new Promise((resolve) => server.once("listening", resolve));
		const client = new GrafanaClient({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, token: () => "glsa_secret_token_value", lokiUid: "cluster-loki", promUid: "prom-1", timeoutMs: 500 });
		return { client, seen };
	}

	it("reads vectors and matrices through the data source proxy with GET and the token", async () => {
		const { client, seen } = await prometheus({ data: { resultType: "vector", result: [{ metric: { a: "1" }, value: [1700000000, "4.5"] }] } });
		assert.deepEqual(await client.promQuery("m", NOW), [{ labels: { a: "1" }, points: [[1700000000, 4.5]] }]);
		assert.equal(seen[0]!.method, "GET");
		assert.equal(seen[0]!.auth, "Bearer glsa_secret_token_value");
		assert.match(seen[0]!.url, /^\/api\/datasources\/proxy\/uid\/prom-1\/api\/v1\/query\?query=m&time=1700000000$/);
		const matrix = await prometheus({ data: { resultType: "matrix", result: [{ metric: {}, values: [[1, "2"], [2, "3"]] }] } });
		assert.deepEqual(await matrix.client.promRange({ query: "m", startMs: 1000, endMs: 2000, stepSeconds: 15 }), [{ labels: {}, points: [[1, 2], [2, 3]] }]);
		assert.match(matrix.seen[0]!.url, /query_range\?query=m&start=1&end=2&step=15/);
	});

	it("refuses an answer in a shape it does not read", async () => {
		const { client } = await prometheus({ data: { resultType: "scalar", result: [1, "2"] } });
		await assert.rejects(() => client.promQuery("m", NOW), /does not read/);
	});
});

describe("the metrics settings", () => {
	it("defaults to the cluster Prometheus data source and thirty days, and takes both from the environment", () => {
		const env = { OBSERVE_ENABLED: "1", GRAFANA_URL: "https://g", GRAFANA_TOKEN_FILE: "/t", OBSERVE_SCOPE: "fleet" };
		const plain = resolveObserve(undefined, env);
		assert.equal(plain.promUid, "cluster-prometheus");
		assert.equal(plain.metricsMaxRangeMs, 720 * 3_600_000);
		const custom = resolveObserve(undefined, { ...env, GRAFANA_PROM_UID: "p2", OBSERVE_METRICS_MAX_RANGE_HOURS: "48" });
		assert.equal(custom.promUid, "p2");
		assert.equal(custom.metricsMaxRangeMs, 48 * 3_600_000);
		assert.throws(() => resolveObserve(undefined, { ...env, OBSERVE_METRICS_MAX_RANGE_HOURS: "9999" }), /OBSERVE_METRICS_MAX_RANGE_HOURS/);
	});
});

describe("the metrics registry with constant labels", () => {
	it("puts the constant labels on every series unless the series sets them", () => {
		const metrics = new Metrics();
		metrics.constantLabels({ agent: "agent/x" });
		metrics.counter("c_total", "c")({ a: "1" });
		metrics.counter("d_total", "d")({ agent: "other" });
		metrics.gauge("g", "g").set(2);
		metrics.histogram("h", "h", [1])(0.5);
		const text = metrics.render();
		assert.match(text, /^c_total\{agent="agent\/x",a="1"\} 1$/m);
		assert.match(text, /^d_total\{agent="other"\} 1$/m);
		assert.match(text, /^g\{agent="agent\/x"\} 2$/m);
		assert.match(text, /^h_bucket\{agent="agent\/x",le="1"\} 1$/m);
		assert.match(text, /^h_count\{agent="agent\/x"\} 1$/m);
	});
});

// Checks the cost the agents recorded against the price list: for every model, the tokens that Prometheus holds (by kind) priced at the list's standard
// rates against somework_llm_cost_usd_total, and the tokens of models that have no price at all.
// Usage: node scripts/pricing-audit.ts [--prometheus URL] [--days 14] [--tolerance 0.02]   Exit status 1 when a model differs or has no price.
// The standard rates cannot see a long-context request (an aggregate has no per-request sizes), so a model with such requests records a little more.
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { estimateCostUsd, findPrice } from "../packages/agent-kit/src/pricing.ts";

export interface ModelTotals {
	provider: string;
	model: string;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	recordedUsd: number;
}

export interface AuditLine {
	model: string;
	recordedUsd: number;
	expectedUsd?: number;
	verdict: "ok" | "differs" | "unpriced";
}

export function audit(models: readonly ModelTotals[], tolerance = 0.02): AuditLine[] {
	return models.map((m) => {
		const price = findPrice(m.model);
		if (!price) return { model: `${m.provider}/${m.model}`, recordedUsd: m.recordedUsd, verdict: "unpriced" };
		const expectedUsd = estimateCostUsd(price, { inputTokens: m.input, outputTokens: m.output, cacheReadTokens: m.cacheRead, cacheWriteTokens: m.cacheWrite });
		const differs = Math.abs(m.recordedUsd - expectedUsd) > Math.max(0.01, expectedUsd * tolerance);
		return { model: `${m.provider}/${m.model}`, recordedUsd: m.recordedUsd, expectedUsd, verdict: differs ? "differs" : "ok" };
	});
}

async function instant(base: string, expression: string): Promise<{ metric: Record<string, string>; value: [number, string] }[]> {
	const response = await fetch(`${base.replace(/\/$/, "")}/api/v1/query?${new URLSearchParams({ query: expression })}`);
	if (!response.ok) throw new Error(`Prometheus answered ${response.status}`);
	return ((await response.json()) as any).data.result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const { values } = parseArgs({ options: { prometheus: { type: "string", default: "https://admin-cloud-observability.tail371505.ts.net/api/datasources/proxy/uid/cluster-prometheus" }, days: { type: "string", default: "14" }, tolerance: { type: "string", default: "0.02" } } });
	const window = `${Number(values.days)}d`;
	const totals = new Map<string, ModelTotals>();
	const entry = (metric: Record<string, string>): ModelTotals => {
		const key = `${metric.provider}/${metric.model}`;
		if (!totals.has(key)) totals.set(key, { provider: metric.provider!, model: metric.model!, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, recordedUsd: 0 });
		return totals.get(key)!;
	};
	for (const row of await instant(values.prometheus!, `sum by (provider,model,kind)(increase(somework_llm_tokens_total[${window}]))`)) {
		const target = entry(row.metric);
		const kind = row.metric.kind;
		const amount = Number(row.value[1]);
		if (kind === "input") target.input += amount;
		else if (kind === "output") target.output += amount;
		else if (kind === "cache_read") target.cacheRead += amount;
		else if (kind === "cache_write") target.cacheWrite += amount;
	}
	for (const row of await instant(values.prometheus!, `sum by (provider,model)(increase(somework_llm_cost_usd_total[${window}]))`)) entry(row.metric).recordedUsd += Number(row.value[1]);
	const lines = audit([...totals.values()], Number(values.tolerance));
	for (const line of lines) console.log(`${line.verdict.padEnd(9)} ${line.model.padEnd(36)} recorded $${line.recordedUsd.toFixed(2).padStart(8)}  list ${line.expectedUsd === undefined ? "no price" : `$${line.expectedUsd.toFixed(2)}`}`);
	process.exit(lines.some((line) => line.verdict !== "ok") ? 1 : 0);
}

import type { Metrics } from "./metrics.ts";
import type { ModelSpend } from "./pi-runtime.ts";

const KINDS = ["input", "output", "cache_read", "cache_write"] as const;

/**
 * The model-usage counters of an agent, `somework_llm_tokens_total` (by kind) and `somework_llm_cost_usd_total`, labelled with the agent,
 * its role, the provider and the model. Prometheus counts an increase only from the second sample of a series, so `start` creates the
 * series of the configured model at zero before the first scrape.
 */
export function llmUsageCounters(metrics: Metrics, who: { agent: string; role: string }): { record(spent: ModelSpend): void; start(model: { provider: string; modelId: string }): void } {
	const tokens = metrics.counter("somework_llm_tokens_total", "Tokens spent on models, by agent, role, provider, model and kind (input, output, cache_read, cache_write)");
	const cost = metrics.counter("somework_llm_cost_usd_total", "Cost in US dollars of the tokens spent on models, by agent, role, provider and model");
	const labels = (provider: string, model: string) => ({ agent: who.agent, role: who.role, provider, model });
	return {
		start: ({ provider, modelId }) => {
			for (const kind of KINDS) tokens({ ...labels(provider, modelId), kind }, 0);
			cost(labels(provider, modelId), 0);
		},
		record: (spent) => {
			const base = labels(spent.provider, spent.modelId);
			const byKind = { input: spent.inputTokens, output: spent.outputTokens, cache_read: spent.cacheReadTokens, cache_write: spent.cacheWriteTokens };
			for (const kind of KINDS) if (byKind[kind] > 0) tokens({ ...base, kind }, byKind[kind]);
			if (spent.costUsd > 0) cost(base, spent.costUsd);
		},
	};
}

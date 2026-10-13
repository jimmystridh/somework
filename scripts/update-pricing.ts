// Refreshes the model price table of the agent kit from LiteLLM's published list (the source ccusage prices from).
// Usage: node scripts/update-pricing.ts [--from file.json]   (default: download from GitHub)
// Writes packages/agent-kit/src/pricing-data.json: dollars per million tokens, only the providers the fleet can use, one model per line.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export const LITELLM_URL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const PROVIDERS = new Set(["openai", "text-completion-openai", "anthropic", "gemini", "xai", "deepseek", "mistral"]);
const MODES = new Set(["chat", "responses", "completion"]);
const OUT = fileURLToPath(new URL("../packages/agent-kit/src/pricing-data.json", import.meta.url));

const perMillion = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value * 1e12) / 1e6 : undefined);

/** One LiteLLM entry as the table keeps it, or undefined when it has no usable price. */
export function priceEntry(entry: Record<string, unknown>): Record<string, number> | undefined {
	const fields: [string, string][] = [
		["i", "input_cost_per_token"],
		["o", "output_cost_per_token"],
		["cr", "cache_read_input_token_cost"],
		["cw", "cache_creation_input_token_cost"],
		["cw1h", "cache_creation_input_token_cost_above_1hr"],
		["i2", "input_cost_per_token_above_272k_tokens"],
		["o2", "output_cost_per_token_above_272k_tokens"],
		["cr2", "cache_read_input_token_cost_above_272k_tokens"],
		["cw2", "cache_creation_input_token_cost_above_272k_tokens"],
		["i3", "input_cost_per_token_above_200k_tokens"],
		["o3", "output_cost_per_token_above_200k_tokens"],
		["cr3", "cache_read_input_token_cost_above_200k_tokens"],
		["cw3", "cache_creation_input_token_cost_above_200k_tokens"],
		["flex", "input_cost_per_token_flex"],
		["fast", "input_cost_per_token_priority"],
	];
	const price: Record<string, number> = {};
	for (const [key, source] of fields) {
		const value = perMillion(entry[source]);
		if (value !== undefined) price[key] = value;
	}
	return price.i !== undefined && price.o !== undefined ? price : undefined;
}

export function buildTable(litellm: Record<string, Record<string, unknown>>): Record<string, Record<string, number>> {
	const table: Record<string, Record<string, number>> = {};
	for (const [name, entry] of Object.entries(litellm)) {
		if (!entry || typeof entry !== "object" || name === "sample_spec") continue;
		if (!PROVIDERS.has(String(entry.litellm_provider)) || !MODES.has(String(entry.mode))) continue;
		const bare = name.includes("/") ? name.slice(name.lastIndexOf("/") + 1) : name;
		const price = priceEntry(entry);
		if (price && (!table[bare] || !name.includes("/"))) table[bare] = price;
	}
	return Object.fromEntries(Object.entries(table).sort(([a], [b]) => (a < b ? -1 : 1)));
}

export const render = (table: Record<string, Record<string, number>>): string => `{\n${Object.entries(table).map(([name, price]) => `${JSON.stringify(name)}:${JSON.stringify(price)}`).join(",\n")}\n}\n`;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const { values } = parseArgs({ options: { from: { type: "string" } } });
	const raw = values.from ? readFileSync(values.from, "utf8") : await (await fetch(LITELLM_URL)).text();
	const table = buildTable(JSON.parse(raw));
	writeFileSync(OUT, render(table));
	console.log(`${Object.keys(table).length} models written to ${OUT}`);
}

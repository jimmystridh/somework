import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Dollars per million tokens, from LiteLLM's price list (`scripts/update-pricing.ts`), the source ccusage prices from. */
export interface ModelPrice {
	/** Fresh (uncached) input. */
	i: number;
	o: number;
	/** Cache read; absent: the model has no discount and a cached token costs the input price. */
	cr?: number;
	/** Cache write (5 minutes); absent: the input price. */
	cw?: number;
	/** Cache write with one hour of retention (Anthropic). */
	cw1h?: number;
	/** The rates of a request whose context passes the long-context threshold (272k tokens, or 200k for the models that name 200k). */
	i2?: number;
	o2?: number;
	cr2?: number;
	cw2?: number;
	i3?: number;
	o3?: number;
	cr3?: number;
	cw3?: number;
	/** Input price in the flex and in the priority (fast) service tier. */
	flex?: number;
	fast?: number;
}

export interface TokenSpend {
	/** Fresh input: what the provider did not read from its cache. */
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	cacheWrite1hTokens?: number;
}

export type ServiceTier = "standard" | "flex" | "fast";

const TABLE: Record<string, ModelPrice> = JSON.parse(readFileSync(fileURLToPath(new URL("./pricing-data.json", import.meta.url)), "utf8"));

/** A dated alias (`-20250929`, `-2025-09-29`) names the same model as the undated one, as ccusage reads it; other numeric suffixes are other versions. */
const DATE_SUFFIX = /-(?:\d{8}|\d{4}-\d{2}-\d{2})$/;

/** The price of a model, found the way ccusage finds it: the name as given, then without its provider prefix, then without a date suffix and `-latest`. */
export function findPrice(modelId: string, table: Readonly<Record<string, ModelPrice>> = TABLE): ModelPrice | undefined {
	const name = modelId.trim().toLowerCase();
	const bare = name.includes("/") ? name.slice(name.lastIndexOf("/") + 1) : name;
	const candidates = [name, bare, bare.replace(/@.*$/, ""), bare.replace(DATE_SUFFIX, ""), bare.replace(/-latest$/, "").replace(DATE_SUFFIX, "")];
	for (const candidate of candidates) if (Object.hasOwn(table, candidate)) return table[candidate];
	return undefined;
}

/** What an input of this size is billed at: a request whose whole context (cached or not) passes the threshold is billed entirely at the higher rates. */
export const LONG_CONTEXT_TOKENS = { "272k": 272_000, "200k": 200_000 } as const;

/**
 * The cost in dollars of one request's usage at a model's price, as ccusage computes it: fresh input, cache reads and cache writes each at their own
 * rate, output at its own, the cache read at the input price when the model has no cache discount. `contextTokens` is the size of the request's whole
 * context (fresh input plus everything read from or written to the cache); when it passes the long-context threshold every bucket is billed at the
 * higher rates. Without it the usage counts as one short request, which is what an aggregate of many requests can only be priced as.
 */
export function estimateCostUsd(price: ModelPrice, spend: TokenSpend, options: { contextTokens?: number; tier?: ServiceTier } = {}): number {
	const context = options.contextTokens ?? 0;
	const long272 = price.i2 !== undefined && context > LONG_CONTEXT_TOKENS["272k"];
	const long200 = !long272 && price.i3 !== undefined && context > LONG_CONTEXT_TOKENS["200k"];
	const rate = (base: number | undefined, tier272: number | undefined, tier200: number | undefined): number => (long272 ? (tier272 ?? base ?? 0) : long200 ? (tier200 ?? base ?? 0) : (base ?? 0));
	const input = rate(price.i, price.i2, price.i3);
	const output = rate(price.o, price.o2, price.o3);
	const read = rate(price.cr ?? price.i, price.cr2 ?? (price.cr === undefined ? price.i2 : undefined), price.cr3 ?? (price.cr === undefined ? price.i3 : undefined));
	const write = rate(price.cw ?? price.i, price.cw2, price.cw3);
	const write1h = long272 || long200 ? write * 2 : (price.cw1h ?? (price.cw ?? price.i) * 2);
	const dollars =
		((spend.inputTokens ?? 0) * input +
			(spend.outputTokens ?? 0) * output +
			(spend.cacheReadTokens ?? 0) * read +
			(spend.cacheWriteTokens ?? 0) * write +
			(spend.cacheWrite1hTokens ?? 0) * write1h) /
		1e6;
	const tierPrice = options.tier === "flex" ? price.flex : options.tier === "fast" ? price.fast : undefined;
	return tierPrice !== undefined && price.i > 0 ? dollars * (tierPrice / price.i) : dollars;
}

/** The price of `provider/modelId` (or a bare model id) and the cost of a spend at it, or undefined for a model that has no price. */
export function priceSpend(modelId: string, spend: TokenSpend, options?: Parameters<typeof estimateCostUsd>[2]): number | undefined {
	const price = findPrice(modelId);
	return price ? estimateCostUsd(price, spend, options) : undefined;
}

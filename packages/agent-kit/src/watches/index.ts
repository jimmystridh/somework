import { readFileSync } from "node:fs";
import type { Log } from "../log.ts";
import { WatchesClient, readWatchToken } from "./client.ts";
import { resolveWatches } from "./config.ts";
import { createWatchTools } from "./tools.ts";

export * from "./client.ts";
export * from "./config.ts";
export * from "./tools.ts";

/** The watch tools and client of a service, or undefined when `WATCH_URL` is not set. Throws when it is set but incomplete. */
export function createWatches(options: { env: NodeJS.ProcessEnv; agentId: string; log?: Log }): { extension: ReturnType<typeof createWatchTools>["extension"]; toolNames: string[]; client: WatchesClient } | undefined {
	const config = resolveWatches(options.env);
	if (!config.enabled) return undefined;
	const client = new WatchesClient({ url: config.url!, agentId: options.agentId, token: readWatchToken(config.tokenFile!), ...(config.caFile ? { caPem: readFileSync(config.caFile, "utf8") } : {}) });
	options.log?.("info", "watches_enabled", { url: new URL(config.url!).origin });
	return { ...createWatchTools(client), client };
}

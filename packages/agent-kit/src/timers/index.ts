import { readFileSync } from "node:fs";
import type { Log } from "../log.ts";
import { TimersClient, readTimersToken } from "./client.ts";
import { resolveTimers } from "./config.ts";
import { createTimerTools } from "./tools.ts";

export * from "./client.ts";
export * from "./config.ts";
export * from "./tools.ts";

/** The timer tools and client of a service, or undefined when `TIMERS_URL` is not set. Throws when it is set but incomplete. */
export function createTimers(options: { env: NodeJS.ProcessEnv; agentId: string; log?: Log }): { extension: ReturnType<typeof createTimerTools>["extension"]; toolNames: string[]; client: TimersClient } | undefined {
	const config = resolveTimers(options.env);
	if (!config.enabled) return undefined;
	const client = new TimersClient({ url: config.url!, agentId: options.agentId, token: readTimersToken(config.tokenFile!), ...(config.caFile ? { caPem: readFileSync(config.caFile, "utf8") } : {}) });
	options.log?.("info", "timers_enabled", { url: new URL(config.url!).origin });
	return { ...createTimerTools(client), client };
}

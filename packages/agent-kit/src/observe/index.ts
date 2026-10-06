import { readFileSync } from "node:fs";
import type { Log } from "../log.ts";
import type { Metrics } from "../metrics.ts";
import { GrafanaClient, readTokenFile } from "./client.ts";
import type { ObserveProfile } from "./config.ts";
import { resolveObserve } from "./config.ts";
import { ObserveService, type ObserveStatus } from "./service.ts";
import { createObserveTools } from "./tools.ts";

export * from "./client.ts";
export * from "./config.ts";
export * from "./format.ts";
export * from "./logql.ts";
export * from "./service.ts";
export * from "./tools.ts";

/** The observe tools of a service, or undefined when they are off. Throws when they are on but cannot be made safe. */
export function createObserve(options: { profile: ObserveProfile | undefined; env: NodeJS.ProcessEnv; log?: Log; metrics?: Metrics }): { extension: ReturnType<typeof createObserveTools>["extension"]; toolNames: string[]; status(): ObserveStatus; service: ObserveService } | undefined {
	const config = resolveObserve(options.profile, options.env);
	if (!config.enabled) return undefined;
	const client = new GrafanaClient({ url: config.url!, token: readTokenFile(config.tokenFile!), lokiUid: config.lokiUid, timeoutMs: config.timeoutMs, ...(config.caFile ? { caPem: readFileSync(config.caFile, "utf8") } : {}) });
	const service = new ObserveService({ config, client, log: options.log, metrics: options.metrics });
	const tools = createObserveTools(service);
	return { ...tools, status: () => service.status(), service };
}

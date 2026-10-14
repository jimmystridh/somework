import { readFileSync } from "node:fs";
import type { Log } from "../log.ts";
import { PlaneClient, readPlaneKey } from "./client.ts";
import { resolvePlane } from "./config.ts";
import { createPlaneTools } from "./tools.ts";

export * from "./client.ts";
export * from "./config.ts";
export * from "./tools.ts";

/** The Plane tools and client of a service, or undefined when `PLANE_BASE_URL` is not set. Throws when it is set but incomplete. */
export function createPlane(options: { env: NodeJS.ProcessEnv; conversationOf: (api: any) => string | undefined; log?: Log }): { extension: ReturnType<typeof createPlaneTools>["extension"]; toolNames: string[]; client: PlaneClient } | undefined {
	const config = resolvePlane(options.env);
	if (!config.enabled) return undefined;
	const client = new PlaneClient({
		baseUrl: config.baseUrl!,
		workspace: config.workspace!,
		projectId: config.projectId!,
		apiKey: readPlaneKey(config.apiKeyFile!),
		labels: config.labels,
		...(config.caFile ? { caPem: readFileSync(config.caFile, "utf8") } : {}),
	});
	options.log?.("info", "plane_enabled", { url: new URL(config.baseUrl!).origin, workspace: config.workspace });
	return { ...createPlaneTools(client, options.conversationOf), client };
}

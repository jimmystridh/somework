import { createServer, type Server } from "node:http";
import type { Metrics } from "./metrics.ts";
import type { AgentRuntime } from "./runtime.ts";

export interface HealthOptions {
	runtime: AgentRuntime;
	metrics: Metrics;
	/** Extra readiness checks (sandbox reachable, ...): name -> ok. */
	checks?: Record<string, () => Promise<boolean>>;
	/** Extra fields for `/status` and `/ready` (event handlers and token pools). */
	status?: () => Record<string, unknown>;
	/** The agent's setup as a document (no secrets, see `describe.ts`): served on `/profile`. */
	profile?: () => unknown;
}

/** `/live`: the process is up. `/ready`: it can accept a job (storage open and resumed, dependencies reachable). `/status`: handlers and token pools. `/profile`: how the agent is set up. `/metrics`: Prometheus. */
export function createHealthServer(options: HealthOptions): Server {
	return createServer(async (req, res) => {
		if (req.url === "/live") return void res.writeHead(200).end("live\n");
		if (req.url === "/metrics") return void res.writeHead(200, { "content-type": "text/plain; version=0.0.4" }).end(options.metrics.render());
		if (req.url === "/status") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(options.status?.() ?? {}));
		if (req.url === "/profile" && options.profile) return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(options.profile()));
		if (req.url === "/ready") {
			const runtime = options.runtime.health();
			const failed: string[] = runtime.ready ? [] : [`runtime: ${runtime.reason}`];
			for (const [name, check] of Object.entries(options.checks ?? {})) if (!(await check().catch(() => false))) failed.push(name);
			return void res.writeHead(failed.length ? 503 : 200, { "content-type": "application/json" }).end(JSON.stringify({ ready: failed.length === 0, failed, ...(options.status?.() ?? {}) }));
		}
		res.writeHead(404).end();
	});
}

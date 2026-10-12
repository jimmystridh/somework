import { createServer, type Server } from "node:http";
import type { Metrics } from "./metrics.ts";
import type { PreflightResult } from "./preflight.ts";
import type { AgentRuntime } from "./runtime.ts";

export interface HealthOptions {
	runtime: AgentRuntime;
	metrics: Metrics;
	/** Extra readiness checks (sandbox reachable, ...): name -> ok. */
	checks?: Record<string, () => Promise<boolean>>;
	/** Extra fields for `/status` and `/ready` (event handlers and token pools). */
	status?: () => Record<string, unknown>;
	/** True while the agent drains for a deployment (see `Drain`): `/status` and `/ready` say so, and `/ready` stays 200. */
	draining?: () => boolean;
	/** The agent's setup as a document (no secrets, see `describe.ts`): served on `/profile`. */
	profile?: () => unknown;
	/** The agent's recent jobs, newest first (names, outcomes, counts and short redacted text, see `journal.ts`): served on `/history?limit=N`. */
	history?: (limit: number) => unknown[];
	/** The role's preflight results (see `preflight.ts`): shown in `/ready`, where a failed blocking check makes the answer 503. */
	preflight?: { results(): PreflightResult[]; blocking(): string[] };
}

/** `/live`: the process is up. `/ready`: it can accept a job (storage open and resumed, dependencies reachable). `/status`: handlers, token pools and whether it drains. `/profile`: how the agent is set up. `/history`: its recent jobs. `/metrics`: Prometheus. */
export function createHealthServer(options: HealthOptions): Server {
	const status = (): Record<string, unknown> => ({ ...(options.status?.() ?? {}), ...(options.draining ? { draining: options.draining() } : {}) });
	return createServer(async (req, res) => {
		if (req.url === "/live") return void res.writeHead(200).end("live\n");
		if (req.url === "/metrics") return void res.writeHead(200, { "content-type": "text/plain; version=0.0.4" }).end(options.metrics.render());
		if (req.url === "/status") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(status()));
		if (req.url === "/profile" && options.profile) return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(options.profile()));
		if (req.url?.split("?")[0] === "/history" && options.history) {
			const asked = Number(new URL(req.url, "http://health").searchParams.get("limit"));
			const limit = Number.isInteger(asked) && asked > 0 ? Math.min(asked, 500) : 100;
			return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jobs: options.history(limit) }));
		}
		if (req.url === "/ready") {
			const runtime = options.runtime.health();
			const failed: string[] = runtime.ready ? [] : [`runtime: ${runtime.reason}`];
			for (const [name, check] of Object.entries(options.checks ?? {})) if (!(await check().catch(() => false))) failed.push(name);
			if (options.preflight) failed.push(...options.preflight.blocking().map((name) => `preflight: ${name}`));
			return void res.writeHead(failed.length ? 503 : 200, { "content-type": "application/json" }).end(JSON.stringify({ ready: failed.length === 0, failed, ...(options.preflight ? { preflight: options.preflight.results() } : {}), ...status() }));
		}
		res.writeHead(404).end();
	});
}

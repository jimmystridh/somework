import { createServer, type Server } from "node:http";

export interface HealthOptions {
	/** The Manager's setup as a document (no secrets): served on `/profile`, which Operations polls the way it polls an agent's. */
	profile: () => Promise<unknown> | unknown;
}

/** `/live`: the process is up. `/profile`: how the Manager is set up and which setup revision it has applied. Read only; no token, nothing secret in it. */
export function createHealthServer(options: HealthOptions): Server {
	return createServer(async (request, response) => {
		const path = (request.url ?? "").split("?")[0];
		if (request.method === "GET" && path === "/live") return void response.writeHead(200).end("live\n");
		if (request.method === "GET" && path === "/profile") {
			try {
				return void response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(await options.profile()));
			} catch {
				return void response.writeHead(500).end();
			}
		}
		response.writeHead(404).end();
	});
}

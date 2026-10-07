import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createTlsServer } from "node:https";
import { adminToken, safeEqual, timerToken } from "./derive.ts";
import type { Hub } from "./hub.ts";
import type { Store } from "./store.ts";
import { TimerError } from "./timers.ts";

const MAX_BODY = 1024 * 1024;
const FORWARDED = /^(content-type|user-agent|x-grafana-.+|x-hook-.+)$/;

const send = (res: ServerResponse, status: number, body: unknown): void => {
	const text = typeof body === "string" ? body : JSON.stringify(body);
	res.writeHead(status, { "content-type": typeof body === "string" ? "text/plain; version=0.0.4" : "application/json", "content-length": Buffer.byteLength(text), "cache-control": "no-store" });
	res.end(text);
};

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer | null> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		size += (chunk as Buffer).length;
		if (size > limit) return null;
		chunks.push(chunk as Buffer);
	}
	return Buffer.concat(chunks);
}

const MAX_TIMER_BODY = 16 * 1024;

/** One listener, four audiences: senders inside the private network (`/in`), agents asking for timers (`/v1/timers`, a token per agent), the operator (`/admin`, bearer) and monitoring (`/healthz`, `/metrics`). */
export function createHubServer(hub: Hub, store: Store, secret: string, tls?: { cert: Buffer | string; key: Buffer | string }): Server {
	const admin = adminToken(secret);
	const authorized = (req: IncomingMessage): boolean => safeEqual(/^Bearer (.+)$/.exec(String(req.headers.authorization ?? ""))?.[1] ?? "", admin);

	const handler = async (req: IncomingMessage, res: ServerResponse) => {
		const url = new URL(req.url ?? "/", "http://hub");
		if (req.method === "GET" && url.pathname === "/healthz") return send(res, 200, { ok: true });
		if (req.method === "GET" && url.pathname === "/metrics") return send(res, 200, hub.metrics.render());

		if (url.pathname === "/v1/timers" || url.pathname.startsWith("/v1/timers/")) {
			const timers = hub.timers;
			if (!timers) return send(res, 404, { error: "timers_not_enabled" });
			const agent = String(req.headers["x-somework-agent"] ?? "");
			const presented = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ""))?.[1] ?? "";
			if (!timers.mayAsk(agent) || !safeEqual(presented, timerToken(secret, agent))) return send(res, 401, { error: "unauthorized" });
			try {
				if (req.method === "POST" && url.pathname === "/v1/timers") {
					const body = await readBody(req, MAX_TIMER_BODY);
					if (body === null) return send(res, 413, { error: "too_large" });
					let parsed: unknown;
					try {
						parsed = JSON.parse(body.toString("utf8"));
					} catch {
						return send(res, 400, { error: "the body must be JSON" });
					}
					if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return send(res, 400, { error: "the body must be a JSON object" });
					return send(res, 201, timers.request(agent, parsed as Record<string, unknown>));
				}
				if (req.method === "GET" && url.pathname === "/v1/timers") return send(res, 200, { timers: timers.list(agent) });
				const one = /^\/v1\/timers\/([A-Za-z0-9:_./#-]{1,100})$/.exec(url.pathname);
				if (req.method === "DELETE" && one) return timers.cancel(agent, decodeURIComponent(one[1]!)) ? send(res, 200, { cancelled: true }) : send(res, 404, { error: "no_such_pending_timer" });
			} catch (error) {
				if (error instanceof TimerError) return send(res, error.status, { error: error.message });
				throw error;
			}
			return send(res, 404, { error: "not_found" });
		}

		const inbound = /^\/in\/([a-z][a-z0-9-]{0,30})\/([A-Za-z0-9_-]{20,64})$/.exec(url.pathname);
		if (inbound && req.method === "POST") {
			const body = await readBody(req, MAX_BODY);
			if (body === null) return send(res, 413, { error: "too_large" });
			const headers = Object.fromEntries(Object.entries(req.headers).filter(([name, value]) => FORWARDED.test(name) && typeof value === "string")) as Record<string, string>;
			const result = hub.acceptInternal(inbound[1]!, inbound[2]!, headers, body);
			return send(res, result.status, result.status === 202 ? { id: result.id } : { error: result.status === 401 ? "bad_token" : result.status === 400 ? "empty_body" : "unknown_source" });
		}

		if (url.pathname.startsWith("/admin/")) {
			if (!authorized(req)) return send(res, 401, { error: "unauthorized" });
			const control = /^\/admin\/sources\/([a-z][a-z0-9-]{0,30})\/(pause|resume)$/.exec(url.pathname);
			if (req.method === "POST" && control) {
				if (!hub.hasSource(control[1]!)) return send(res, 404, { error: "unknown source" });
				await hub.setSourcePaused(control[1]!, control[2] === "pause");
				return send(res, 200, { source: control[1], paused: control[2] === "pause" });
			}
			if (req.method === "GET" && url.pathname === "/admin/stats") return send(res, 200, hub.adminStats());
			if (req.method === "GET" && url.pathname === "/admin/dead-letters") {
				return send(res, 200, { deadLetters: store.deadLetters().map(({ body, headers, query, ...rest }) => ({ ...rest, bytes: body.length })) });
			}
			const replay = /^\/admin\/dead-letters\/([A-Za-z0-9-]{1,64})\/replay$/.exec(url.pathname);
			if (req.method === "POST" && replay) {
				try {
					return send(res, 200, await hub.replayDeadLetter(replay[1]!));
				} catch (error) {
					return send(res, 409, { error: (error as Error).message });
				}
			}
		}
		return send(res, 404, { error: "not_found" });
	};

	const onRequest = (req: IncomingMessage, res: ServerResponse) => {
		handler(req, res).catch(() => {
			if (!res.headersSent) send(res, 500, { error: "internal" });
		});
	};
	const server = (tls ? createTlsServer({ maxHeaderSize: 16 * 1024, cert: tls.cert, key: tls.key, minVersion: "TLSv1.2" }, onRequest) : createServer({ maxHeaderSize: 16 * 1024 }, onRequest)) as unknown as Server;
	server.headersTimeout = 15_000;
	return server;
}

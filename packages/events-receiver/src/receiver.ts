import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttpsServer, type ServerOptions as TlsServerOptions } from "node:https";
import type { ReceiverConfig, SourceConfig } from "./config.ts";
import { hasDotSegment, SOURCE_NAME } from "./config.ts";
import { githubSignature, hookToken, pullToken, safeEqual, signingSecret } from "./derive.ts";
import { FailureLimiter, TokenBucket } from "./limits.ts";
import { silent, type Log } from "./log.ts";
import type { Queue } from "./queue.ts";

const HEADER_ALLOW = /^(content-type|user-agent|x-hub-signature-256|x-event-key|cf-connecting-ip|x-github-[a-z0-9-]+|x-datadog-[a-z0-9-]+|x-atlassian-[a-z0-9-]+|x-hook-[a-z0-9-]+)$/;
const MAX_HEADER_VALUE = 512;
const MAX_PULL_BYTES = 8 * 1024 * 1024;
const MAX_PULL_ITEMS = 200;
const MAX_WAIT_SECONDS = 55;
const HOOK_PATH = /^\/hook\/([a-z][a-z0-9-]{0,30})\/([A-Za-z0-9_-]{20,64})((?:\/[A-Za-z0-9._~-]{1,100}){0,8})$/;
const MAX_QUERY = 4096;

export interface ReceiverDeps {
	config: ReceiverConfig;
	secret: string;
	queue: Queue;
	log?: Log;
	now?: () => number;
}

export interface Counters {
	accepted: Record<string, number>;
	rejected: Record<string, number>;
}

const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void => {
	const text = JSON.stringify(body);
	res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text), "cache-control": "no-store", ...headers });
	res.end(text);
};

export function allowedHeaders(raw: IncomingMessage["headers"]): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [name, value] of Object.entries(raw)) {
		if (!HEADER_ALLOW.test(name) || value === undefined) continue;
		out[name] = (Array.isArray(value) ? value.join(", ") : value).slice(0, MAX_HEADER_VALUE);
	}
	return out;
}

class TooLarge extends Error {}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		req.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > limit) {
				chunks.length = 0;
				req.pause();
				reject(new TooLarge());
				return;
			}
			if (size <= limit) chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks)));
		req.on("error", reject);
	});
}

export class Receiver {
	readonly counters: Counters = { accepted: {}, rejected: {} };
	readonly #deps: ReceiverDeps;
	readonly #log: Log;
	readonly #now: () => number;
	readonly #sources = new Map<string, SourceConfig>();
	readonly #bucketBySource = new Map<string, TokenBucket>();
	readonly #global: TokenBucket;
	readonly #failures: FailureLimiter;
	readonly #startedAt: number;

	constructor(deps: ReceiverDeps) {
		this.#deps = deps;
		this.#log = deps.log ?? silent;
		this.#now = deps.now ?? Date.now;
		for (const source of deps.config.sources) {
			this.#sources.set(source.name, source);
			this.#bucketBySource.set(source.name, new TokenBucket(deps.config.perSource, this.#now));
		}
		this.#global = new TokenBucket(deps.config.global, this.#now);
		this.#failures = new FailureLimiter(deps.config.authFailuresPerMinute, this.#now);
		this.#startedAt = this.#now();
	}

	publicServer(): Server {
		const server = createHttpServer({ maxHeaderSize: 16 * 1024 }, (req, res) => {
			this.#handleHook(req, res).catch((error) => {
				this.#log("error", "hook_failed", { error });
				if (!res.headersSent) send(res, 500, { error: "internal" });
			});
		});
		this.#harden(server);
		return server;
	}

	privateServer(tls?: TlsServerOptions): Server {
		const handler = (req: IncomingMessage, res: ServerResponse) => {
			this.#handlePrivate(req, res).catch((error) => {
				this.#log("error", "private_request_failed", { error });
				if (!res.headersSent) send(res, 500, { error: "internal" });
			});
		};
		const server = tls ? createHttpsServer({ maxHeaderSize: 16 * 1024, ...tls }, handler) : createHttpServer({ maxHeaderSize: 16 * 1024 }, handler);
		this.#harden(server);
		return server;
	}

	#harden(server: Server): void {
		server.headersTimeout = 15_000;
		server.requestTimeout = 0;
		server.keepAliveTimeout = 5_000;
	}

	#reject(source: string, reason: string, res: ServerResponse, status: number, extra: Record<string, string> = {}): void {
		this.counters.rejected[reason] = (this.counters.rejected[reason] ?? 0) + 1;
		this.#log("warn", "hook_rejected", { source, reason, status });
		send(res, status, { error: reason }, extra);
		if (extra.connection === "close") res.once("finish", () => res.socket?.destroy());
	}

	async #handleHook(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const target = req.url ?? "";
		const questionMark = target.indexOf("?");
		const path = questionMark < 0 ? target : target.slice(0, questionMark);
		const query = questionMark < 0 ? "" : target.slice(questionMark + 1);
		if (path === "/healthz") return send(res, 200, { ok: true });
		const match = HOOK_PATH.exec(path);
		if (!match) return this.#reject("-", "not_found", res, 404);
		if (req.method !== "POST") return this.#reject("-", "method_not_allowed", res, 405, { allow: "POST" });
		const [, name, token, suffix] = match as unknown as [string, string, string, string];
		if (query.length > MAX_QUERY) return this.#reject(name, "query_too_long", res, 414);

		if (!this.#global.take()) return this.#reject(name, "rate_limited", res, 429, { "retry-after": "1" });
		const client = String(req.headers["cf-connecting-ip"] ?? req.socket.remoteAddress ?? "unknown");
		if (this.#failures.blocked(client)) return this.#reject(name, "too_many_failures", res, 429, { "retry-after": "60" });

		const source = this.#sources.get(name);
		if (!source || this.#deps.queue.isPaused(name)) return this.#reject(name, "unknown_source", res, 404);
		if (suffix !== source.path || hasDotSegment(suffix)) return this.#reject(name, "unknown_path", res, 404);
		if (!this.#bucketBySource.get(name)!.take()) return this.#reject(name, "rate_limited", res, 429, { "retry-after": "1" });
		if (!safeEqual(token, hookToken(this.#deps.secret, source.name, source.version))) {
			this.#failures.record(client);
			return this.#reject(name, "bad_token", res, 401);
		}

		const declared = Number(req.headers["content-length"] ?? 0);
		if (declared > this.#deps.config.maxBodyBytes) return this.#reject(name, "too_large", res, 413, { connection: "close" });
		let body: Buffer;
		try {
			body = await readBody(req, this.#deps.config.maxBodyBytes);
		} catch (error) {
			if (error instanceof TooLarge) return this.#reject(name, "too_large", res, 413, { connection: "close" });
			return this.#reject(name, "unreadable", res, 400);
		}
		if (body.length === 0) return this.#reject(name, "empty_body", res, 400);

		if (source.verify === "github-hmac") {
			const expected = githubSignature(signingSecret(this.#deps.secret, source.name, source.version), body);
			if (!safeEqual(String(req.headers["x-hub-signature-256"] ?? ""), expected)) {
				this.#failures.record(client);
				return this.#reject(name, "bad_signature", res, 401);
			}
		}

		const { id } = this.#deps.queue.enqueue(name, allowedHeaders(req.headers), body, suffix, query);
		this.counters.accepted[name] = (this.counters.accepted[name] ?? 0) + 1;
		this.#log("info", "hook_accepted", { source: name, id, bytes: body.length });
		send(res, 202, { id });
	}

	async #handlePrivate(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const url = new URL(req.url ?? "/", "http://receiver");
		if (url.pathname === "/healthz") return send(res, 200, { ok: true, queued: this.#deps.queue.stats().queued });
		const bearer = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ""))?.[1] ?? "";
		if (!safeEqual(bearer, pullToken(this.#deps.secret))) {
			this.#log("warn", "private_unauthorized", {});
			return send(res, 401, { error: "unauthorized" });
		}

		if (req.method === "GET" && url.pathname === "/v1/pull") return this.#pull(url, req, res);
		if (req.method === "POST" && url.pathname === "/v1/ack") {
			const body = JSON.parse((await readBody(req, 4096)).toString("utf8") || "{}") as { upTo?: unknown };
			if (!Number.isInteger(body.upTo) || (body.upTo as number) < 0) return send(res, 400, { error: "upTo must be a non-negative integer" });
			const removed = this.#deps.queue.ack(body.upTo as number);
			this.#log("info", "queue_acked", { upTo: body.upTo, removed });
			return send(res, 200, { removed });
		}
		if (req.method === "GET" && url.pathname === "/v1/stats") return send(res, 200, this.stats());
		const control = /^\/v1\/sources\/([a-z][a-z0-9-]{0,30})\/(pause|resume)$/.exec(url.pathname);
		if (req.method === "POST" && control) {
			const [, name, action] = control as unknown as [string, string, "pause" | "resume"];
			if (!SOURCE_NAME.test(name) || !this.#sources.has(name)) return send(res, 404, { error: "unknown source" });
			this.#deps.queue.setPaused(name, action === "pause");
			this.#log("info", "source_control", { source: name, action });
			return send(res, 200, { source: name, paused: action === "pause" });
		}
		return send(res, 404, { error: "not found" });
	}

	async #pull(url: URL, req: IncomingMessage, res: ServerResponse): Promise<void> {
		const after = Number(url.searchParams.get("after") ?? 0);
		const limit = Math.min(Number(url.searchParams.get("limit") ?? 50) || 50, MAX_PULL_ITEMS);
		const wait = Math.min(Math.max(Number(url.searchParams.get("wait") ?? 0) || 0, 0), MAX_WAIT_SECONDS);
		if (!Number.isInteger(after) || after < 0) return send(res, 400, { error: "after must be a non-negative integer" });
		const aborted = new AbortController();
		res.on("close", () => aborted.abort());
		await this.#deps.queue.waitFor(after, wait * 1000, aborted.signal);
		if (aborted.signal.aborted) return;
		const items = this.#deps.queue.pull(after, limit, MAX_PULL_BYTES).map((item) => ({
			seq: item.seq,
			id: item.id,
			source: item.source,
			receivedAt: new Date(item.receivedAt).toISOString(),
			headers: item.headers,
			path: item.path,
			query: item.query,
			bodyBase64: item.body.toString("base64"),
		}));
		send(res, 200, { items });
	}

	stats(): Record<string, unknown> {
		const queue = this.#deps.queue.stats();
		const now = this.#now();
		return {
			queued: queue.queued,
			bytes: queue.bytes,
			lastSeq: queue.lastSeq,
			oldestAgeSeconds: queue.oldestReceivedAt === null ? 0 : Math.round((now - queue.oldestReceivedAt) / 1000),
			uptimeSeconds: Math.round((now - this.#startedAt) / 1000),
			sources: Object.fromEntries([...this.#sources.keys()].map((name) => [name, { paused: this.#deps.queue.isPaused(name), accepted: this.counters.accepted[name] ?? 0 }])),
			rejected: this.counters.rejected,
		};
	}
}


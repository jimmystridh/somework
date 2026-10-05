import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { SomeWorkError } from "@somework/sdk";
import { PolicyError } from "./policy.ts";
import { sizeOf } from "./redact.ts";
import type { ManagerService } from "./service.ts";

const MAX_BODY_BYTES = 256 * 1024;

export type Log = (event: string, fields?: Record<string, unknown>) => void;

export interface GatewayOptions {
	service: ManagerService;
	token: string;
	log?: Log;
}

const sameToken = (given: string, expected: string): boolean => {
	const a = Buffer.from(given);
	const b = Buffer.from(expected);
	return a.length === b.length && timingSafeEqual(a, b);
};

async function readJson(request: IncomingMessage): Promise<any> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of request) {
		size += chunk.length;
		if (size > MAX_BODY_BYTES) throw new PolicyError(413, "payload_too_large", "request body too large");
		chunks.push(chunk);
	}
	if (size === 0) return {};
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw new PolicyError(400, "invalid_json", "request body is not valid JSON");
	}
}

function send(response: ServerResponse, status: number, body: unknown): number {
	const text = JSON.stringify(body);
	response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
	response.end(text);
	return status;
}

function errorAnswer(error: unknown): { status: number; body: unknown } {
	if (error instanceof PolicyError) return { status: error.status, body: { error: { code: error.code, message: error.message } } };
	if (error instanceof SomeWorkError) {
		const status = error.status === 0 ? 503 : error.status >= 500 ? 502 : error.status;
		return { status, body: { error: { code: error.code, message: error.message.slice(0, 300) } } };
	}
	return { status: 500, body: { error: { code: "internal", message: "internal error" } } };
}

/**
 * The only door from the Pi container to the domain. It authenticates one shared bearer token, exposes narrow operations and
 * delegates every decision to the service. Payloads are never logged: only route, status and sizes.
 */
export function createGateway(options: GatewayOptions): Server {
	const { service, token } = options;
	const log = options.log ?? (() => {});

	async function route(method: string, url: URL, request: IncomingMessage): Promise<unknown> {
		const path = url.pathname;
		if (method === "GET" && path === "/v1/catalog") return service.catalog(url.searchParams.get("query") ?? "");
		if (method === "POST" && path === "/v1/tasks") {
			const body = await readJson(request);
			return service.submit({ capability: body.capability ?? {}, input: body.input, targetAgentId: body.targetAgentId });
		}
		const task = /^\/v1\/tasks\/([^/]+)$/.exec(path);
		if (method === "GET" && task) return service.task(decodeURIComponent(task[1]!), Number(url.searchParams.get("wait") ?? 0) || 0);
		const cancel = /^\/v1\/tasks\/([^/]+)\/cancel$/.exec(path);
		if (method === "POST" && cancel) return service.cancel(decodeURIComponent(cancel[1]!), (await readJson(request)).reason);
		if (method === "POST" && path === "/v1/messages") {
			const body = await readJson(request);
			return service.message({ to: String(body.to ?? ""), text: String(body.text ?? ""), conversationId: body.conversationId });
		}
		if (method === "GET" && path === "/v1/inbox") {
			return service.inbox({ conversationId: url.searchParams.get("conversationId") ?? undefined, limit: Number(url.searchParams.get("limit") ?? 20) || 20 });
		}
		throw new PolicyError(404, "not_found", "no such route");
	}

	return createServer(async (request, response) => {
		const url = new URL(request.url ?? "/", "http://gateway");
		const method = request.method ?? "GET";
		if (method === "GET" && url.pathname === "/healthz") {
			send(response, 200, { ok: true });
			return;
		}
		const header = request.headers.authorization ?? "";
		if (!header.startsWith("Bearer ") || !sameToken(header.slice(7), token)) {
			log("gateway_request", { route: `${method} ${url.pathname.split("/").slice(0, 3).join("/")}`, status: 401 });
			send(response, 401, { error: { code: "unauthorized", message: "missing or wrong gateway token" } });
			return;
		}
		let status: number;
		let bytes = 0;
		try {
			const answer = await route(method, url, request);
			bytes = sizeOf(answer);
			status = send(response, 200, answer);
		} catch (error) {
			const { status: code, body } = errorAnswer(error);
			status = send(response, code, body);
		}
		log("gateway_request", { route: `${method} ${url.pathname.replace(/\/(task_|a)[^/]+/, "/:id")}`, status, bytes });
	});
}

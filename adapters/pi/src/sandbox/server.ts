import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context";
import type { ExecutionEnv, Result } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";

export interface SandboxServerOptions {
	/** Shared secret of the harness. The sandbox holds no other credential. */
	token: string;
	/** Working directory when a request names none. */
	root: string;
	/** Environment of every command: nothing else is inherited from the daemon's own environment. */
	baseEnv?: Record<string, string>;
	maxBodyBytes?: number;
}

const MAX_BODY = 64 * 1024 * 1024;
const digest = (value: string): Buffer => createHash("sha256").update(value).digest();

/** A serializable form of a Pi `Result`: the daemon is a thin RPC wrapper around the real NodeExecutionEnv inside the container. */
export function serializeResult(result: Result<unknown, any>): unknown {
	if (result.ok) return { ok: true, value: encodeValue(result.value) };
	const error = result.error;
	return { ok: false, error: { name: error?.name, code: error?.code, message: error?.message, path: error?.path, spillPath: error?.spillPath } };
}

function encodeValue(value: unknown): unknown {
	return value instanceof Uint8Array ? { __b64: Buffer.from(value).toString("base64") } : value;
}

export function decodeContent(content: unknown): string | Uint8Array {
	if (typeof content === "string") return content;
	if (content && typeof content === "object" && "__b64" in content) return Buffer.from((content as { __b64: string }).__b64, "base64");
	throw new Error("content must be a string or {__b64}");
}

async function readBody(req: IncomingMessage, limit: number): Promise<any> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req as AsyncIterable<Buffer>) {
		size += chunk.length;
		if (size > limit) throw new Error("request body too large");
		chunks.push(chunk);
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

const json = (res: ServerResponse, status: number, body: unknown) => {
	res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
};

export function createSandboxServer(options: SandboxServerOptions): Server {
	const expected = digest(options.token);
	const baseEnv = options.baseEnv ?? { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: options.root, LANG: "C.UTF-8" };
	const envFor = (cwd?: string): NodeExecutionEnv => new NodeExecutionEnv({ cwd: cwd ?? options.root, shellEnv: baseEnv });

	return createServer(async (req, res) => {
		try {
			if (req.method === "GET" && req.url === "/healthz") return json(res, 200, { status: "ok" });
			const presented = digest((req.headers.authorization ?? "").replace(/^Bearer /, ""));
			if (!timingSafeEqual(presented, expected)) return json(res, 401, { code: "unauthenticated" });
			if (req.method !== "POST") return json(res, 405, { code: "method_not_allowed" });
			const body = await readBody(req, options.maxBodyBytes ?? MAX_BODY);
			if (req.url === "/exec") return await handleExec(res, envFor(body.cwd), body, baseEnv);
			if (req.url === "/fs") return json(res, 200, await handleFs(envFor(body.cwd), body.op, body.args ?? {}));
			return json(res, 404, { code: "not_found" });
		} catch (error) {
			if (!res.headersSent) json(res, 400, { code: "bad_request", message: error instanceof Error ? error.message : String(error) });
			else res.end();
		}
	});
}

async function handleFs(env: ExecutionEnv, op: string, a: any): Promise<unknown> {
	const ctx = BACKGROUND_CONTEXT;
	switch (op) {
		case "absolutePath": return serializeResult(await env.absolutePath(a.path, ctx));
		case "joinPath": return serializeResult(await env.joinPath(a.parts, ctx));
		case "readTextFile": return serializeResult(await env.readTextFile(a.path, ctx));
		case "readTextLines": return serializeResult(await env.readTextLines(a.path, a.options, ctx));
		case "readBinaryFile": return serializeResult(await env.readBinaryFile(a.path, ctx));
		case "writeFile": return serializeResult(await env.writeFile(a.path, decodeContent(a.content), ctx));
		case "appendFile": return serializeResult(await env.appendFile(a.path, decodeContent(a.content), ctx));
		case "truncateFile": return serializeResult(await env.truncateFile(a.path, a.size, ctx));
		case "flushFile": return serializeResult(await env.flushFile(a.path, ctx));
		case "renameFile": return serializeResult(await env.renameFile(a.source, a.destination, ctx));
		case "fileInfo": return serializeResult(await env.fileInfo(a.path, ctx));
		case "listDir": return serializeResult(await env.listDir(a.path, ctx));
		case "canonicalPath": return serializeResult(await env.canonicalPath(a.path, ctx));
		case "exists": return serializeResult(await env.exists(a.path, ctx));
		case "createDir": return serializeResult(await env.createDir(a.path, a.options, ctx));
		case "remove": return serializeResult(await env.remove(a.path, a.options, ctx));
		case "createTempDir": return serializeResult(await env.createTempDir(a.prefix, ctx));
		case "createTempFile": return serializeResult(await env.createTempFile(a.options, ctx));
		default: throw new Error(`unknown operation ${op}`);
	}
}

/** Commands get exactly `baseEnv` plus the call's own variables: the daemon's environment is never inherited, whatever the caller asks.
 * Streams combined output as NDJSON; when the client goes away the command's whole process tree is cancelled. */
async function handleExec(res: ServerResponse, env: ExecutionEnv, body: any, baseEnv: Record<string, string>): Promise<void> {
	const { context, cancel } = withCancel(BACKGROUND_CONTEXT);
	res.writeHead(200, { "content-type": "application/x-ndjson" });
	res.on("close", () => {
		if (!res.writableEnded) cancel("client disconnected");
	});
	const result = await env.exec(
		body.command,
		{ cwd: body.cwd, env: { ...baseEnv, ...(body.env ?? {}) }, inheritEnv: false, timeout: body.timeout, spill: body.spill, onOutput: (text) => void res.write(`${JSON.stringify({ t: "out", d: text })}\n`) },
		context,
	);
	res.end(`${JSON.stringify({ t: "result", ...(serializeResult(result) as object) })}\n`);
}

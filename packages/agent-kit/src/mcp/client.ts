import { spawn, type ChildProcess } from "node:child_process";
import { redactText } from "../events/redact.ts";
import { silent, type Log } from "../log.ts";

/**
 * A minimal MCP client (Model Context Protocol, 2025-06-18): `initialize`, `tools/list` and `tools/call` over a child process (stdio, one JSON
 * message per line) or over streamable HTTP (one POST per message, answered with JSON or an event stream). Pi Durable has no MCP client of its own.
 */

export const PROTOCOL_VERSION = "2025-06-18";
const CLIENT_INFO = { name: "somework-agent-kit", version: "0.1.0" };
const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
const MAX_LIST_PAGES = 20;

export interface McpToolInfo {
	name: string;
	description?: string;
	inputSchema?: unknown;
	annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; title?: string };
}

export interface McpCallResult {
	isError: boolean;
	/** The text parts of the result; anything else is named, never carried. */
	text: string;
}

export interface McpClient {
	listTools(): Promise<McpToolInfo[]>;
	callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult>;
	close(): Promise<void>;
}

export class McpError extends Error {}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function toolInfo(raw: unknown): McpToolInfo | undefined {
	if (!isRecord(raw) || typeof raw.name !== "string" || raw.name === "") return undefined;
	const annotations = isRecord(raw.annotations) ? raw.annotations : undefined;
	return {
		name: raw.name,
		...(typeof raw.description === "string" ? { description: raw.description } : {}),
		...(raw.inputSchema !== undefined ? { inputSchema: raw.inputSchema } : {}),
		...(annotations ? { annotations: { ...(typeof annotations.readOnlyHint === "boolean" ? { readOnlyHint: annotations.readOnlyHint } : {}), ...(typeof annotations.destructiveHint === "boolean" ? { destructiveHint: annotations.destructiveHint } : {}), ...(typeof annotations.title === "string" ? { title: annotations.title } : {}) } } : {}),
	};
}

export function flattenResult(raw: unknown): McpCallResult {
	const result = isRecord(raw) ? raw : {};
	const parts = Array.isArray(result.content) ? result.content : [];
	const lines = parts.map((part: unknown) => {
		if (isRecord(part) && part.type === "text" && typeof part.text === "string") return part.text;
		if (isRecord(part) && part.type === "resource" && isRecord(part.resource) && typeof part.resource.text === "string") return part.resource.text;
		return `[${isRecord(part) && typeof part.type === "string" ? part.type : "unknown"} content omitted]`;
	});
	if (lines.length === 0 && result.structuredContent !== undefined) lines.push(JSON.stringify(result.structuredContent));
	return { isError: result.isError === true, text: lines.join("\n") };
}

/** The shared part of both transports: the handshake, paging through the tool list, and reading a tool result. */
abstract class JsonRpcClient implements McpClient {
	#ready: Promise<void> | undefined;
	#nextId = 1;
	protected readonly timeoutMs: number;

	constructor(timeoutMs: number) {
		this.timeoutMs = timeoutMs;
	}

	protected newId(): number {
		return this.#nextId++;
	}

	protected abstract request(method: string, params: Record<string, unknown>): Promise<any>;
	protected abstract notify(method: string): Promise<void>;
	protected abstract onProtocol(version: string): void;
	abstract close(): Promise<void>;

	/** The handshake runs once; when it fails, or the connection is lost, the next call starts over. */
	protected async ensure(): Promise<void> {
		if (!this.#ready) {
			this.#ready = (async () => {
				const result = await this.request("initialize", { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO });
				if (isRecord(result) && typeof result.protocolVersion === "string") this.onProtocol(result.protocolVersion);
				await this.notify("notifications/initialized");
			})();
			this.#ready.catch(() => this.reset());
		}
		await this.#ready;
	}

	protected reset(): void {
		this.#ready = undefined;
	}

	async listTools(): Promise<McpToolInfo[]> {
		await this.ensure();
		const tools: McpToolInfo[] = [];
		let cursor: string | undefined;
		for (let page = 0; page < MAX_LIST_PAGES; page++) {
			const result = await this.request("tools/list", cursor ? { cursor } : {});
			for (const raw of Array.isArray(result?.tools) ? result.tools : []) {
				const info = toolInfo(raw);
				if (info) tools.push(info);
			}
			cursor = typeof result?.nextCursor === "string" && result.nextCursor !== "" ? result.nextCursor : undefined;
			if (!cursor) break;
		}
		return tools;
	}

	async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
		await this.ensure();
		return flattenResult(await this.request("tools/call", { name, arguments: args }));
	}
}

export interface StdioOptions {
	command: string;
	args: string[];
	/** The whole environment of the child: nothing else is inherited. */
	env: Record<string, string>;
	cwd?: string;
	timeoutMs: number;
	log?: Log;
	name?: string;
}

interface Pending {
	resolve: (value: any) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

export class StdioMcpClient extends JsonRpcClient {
	readonly #options: StdioOptions;
	readonly #log: Log;
	readonly #pending = new Map<number, Pending>();
	#child: ChildProcess | undefined;
	#buffer = "";
	#stderrTail = "";
	#closed = false;

	constructor(options: StdioOptions) {
		super(options.timeoutMs);
		this.#options = options;
		this.#log = options.log ?? silent;
	}

	#spawn(): ChildProcess {
		if (this.#closed) throw new McpError("the MCP server is closed");
		if (this.#child) return this.#child;
		const child = spawn(this.#options.command, this.#options.args, { env: this.#options.env, ...(this.#options.cwd ? { cwd: this.#options.cwd } : {}), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
		this.#child = child;
		this.#buffer = "";
		child.stdout!.setEncoding("utf8");
		child.stdout!.on("data", (chunk: string) => this.#onData(chunk));
		child.stderr!.setEncoding("utf8");
		child.stderr!.on("data", (chunk: string) => {
			this.#stderrTail = `${this.#stderrTail}${chunk}`.slice(-1000);
		});
		child.stdin!.on("error", () => undefined);
		child.on("error", (error) => this.#lost(`could not start: ${error.message}`));
		child.on("exit", (code, signal) => this.#lost(`exited (${signal ?? code})`));
		return child;
	}

	#lost(why: string): void {
		const detail = redactText(this.#stderrTail.trim().split("\n").at(-1) ?? "").slice(0, 200);
		const error = new McpError(`the MCP server ${why}${detail ? `: ${detail}` : ""}`);
		this.#child = undefined;
		this.reset();
		if (!this.#closed) this.#log("warn", "mcp_server_lost", { server: this.#options.name, reason: why });
		for (const [id, pending] of this.#pending) {
			clearTimeout(pending.timer);
			pending.reject(error);
			this.#pending.delete(id);
		}
	}

	#onData(chunk: string): void {
		this.#buffer += chunk;
		if (this.#buffer.length > MAX_MESSAGE_BYTES) {
			this.#buffer = "";
			this.#child?.kill("SIGKILL");
			return;
		}
		let newline = this.#buffer.indexOf("\n");
		while (newline >= 0) {
			const line = this.#buffer.slice(0, newline).trim();
			this.#buffer = this.#buffer.slice(newline + 1);
			if (line) this.#onMessage(line);
			newline = this.#buffer.indexOf("\n");
		}
	}

	#onMessage(line: string): void {
		let message: any;
		try {
			message = JSON.parse(line);
		} catch {
			return;
		}
		if (!isRecord(message)) return;
		if (typeof message.method === "string") {
			// a request from the server: only `ping` is answered, nothing else is offered to it
			if (message.id !== undefined) this.#write(message.method === "ping" ? { jsonrpc: "2.0", id: message.id, result: {} } : { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "method not supported" } });
			return;
		}
		const pending = typeof message.id === "number" ? this.#pending.get(message.id) : undefined;
		if (!pending) return;
		this.#pending.delete(message.id);
		clearTimeout(pending.timer);
		if (isRecord(message.error)) pending.reject(new McpError(`the MCP server answered with an error: ${redactText(String(message.error.message ?? message.error.code)).slice(0, 300)}`));
		else pending.resolve(message.result);
	}

	#write(message: Record<string, unknown>): void {
		this.#child?.stdin?.write(`${JSON.stringify(message)}\n`);
	}

	protected request(method: string, params: Record<string, unknown>): Promise<any> {
		return new Promise((resolve, reject) => {
			try {
				this.#spawn();
			} catch (error) {
				return reject(error);
			}
			const id = this.newId();
			const timer = setTimeout(() => {
				this.#pending.delete(id);
				reject(new McpError(`the MCP server did not answer ${method} within ${Math.round(this.timeoutMs / 1000)} seconds`));
			}, this.timeoutMs);
			this.#pending.set(id, { resolve, reject, timer });
			this.#write({ jsonrpc: "2.0", id, method, params });
		});
	}

	protected async notify(method: string): Promise<void> {
		this.#write({ jsonrpc: "2.0", method });
	}

	protected onProtocol(): void {}

	async close(): Promise<void> {
		this.#closed = true;
		const child = this.#child;
		this.#child = undefined;
		for (const [id, pending] of this.#pending) {
			clearTimeout(pending.timer);
			pending.reject(new McpError("the MCP server was closed"));
			this.#pending.delete(id);
		}
		if (!child || child.exitCode !== null || child.signalCode !== null) return;
		const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
		child.stdin?.end();
		child.kill("SIGTERM");
		const hardKill = setTimeout(() => child.kill("SIGKILL"), 2000);
		await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 4000))]);
		clearTimeout(hardKill);
	}
}

export interface HttpOptions {
	url: string;
	headers: Record<string, string>;
	timeoutMs: number;
	fetch?: typeof fetch;
}

/** Streamable HTTP: every message is a POST; the answer is a JSON body or an event stream that carries it. A session id from the server is sent back. */
export class HttpMcpClient extends JsonRpcClient {
	readonly #options: HttpOptions;
	readonly #fetch: typeof fetch;
	#session: string | undefined;
	#protocol = PROTOCOL_VERSION;

	constructor(options: HttpOptions) {
		super(options.timeoutMs);
		this.#options = options;
		this.#fetch = options.fetch ?? fetch;
	}

	#headers(): Record<string, string> {
		return { ...this.#options.headers, "content-type": "application/json", accept: "application/json, text/event-stream", ...(this.#session ? { "mcp-session-id": this.#session, "mcp-protocol-version": this.#protocol } : {}) };
	}

	async #post(body: Record<string, unknown>, expectId: number | undefined): Promise<any> {
		let response: Response;
		try {
			response = await this.#fetch(this.#options.url, { method: "POST", headers: this.#headers(), body: JSON.stringify(body), signal: AbortSignal.timeout(this.timeoutMs), redirect: "error" });
		} catch (error) {
			throw new McpError(`the MCP server could not be reached: ${redactText(error instanceof Error ? error.message : String(error)).slice(0, 200)}`);
		}
		if (body.method === "initialize") this.#session = response.headers.get("mcp-session-id") ?? undefined;
		if (response.status === 404 && this.#session && body.method !== "initialize") {
			this.#session = undefined;
			this.reset();
			throw new McpError("the MCP session has ended; the next call starts a new one");
		}
		if (!response.ok) throw new McpError(`the MCP server answered HTTP ${response.status}`);
		if (expectId === undefined) {
			await response.body?.cancel().catch(() => undefined);
			return undefined;
		}
		const type = response.headers.get("content-type") ?? "";
		const message = type.includes("text/event-stream") ? await this.#fromStream(response, expectId) : this.#pick(JSON.parse(await this.#readText(response)), expectId);
		if (!message) throw new McpError("the MCP server did not answer the request");
		if (isRecord(message.error)) throw new McpError(`the MCP server answered with an error: ${redactText(String(message.error.message ?? message.error.code)).slice(0, 300)}`);
		return message.result;
	}

	#pick(body: unknown, id: number): Record<string, any> | undefined {
		const candidates = Array.isArray(body) ? body : [body];
		return candidates.find((candidate): candidate is Record<string, any> => isRecord(candidate) && candidate.id === id && typeof candidate.method !== "string");
	}

	async #readText(response: Response): Promise<string> {
		const reader = response.body?.getReader();
		if (!reader) return "";
		const decoder = new TextDecoder();
		let text = "";
		let bytes = 0;
		for (;;) {
			const { done, value } = await reader.read();
			if (done) return text + decoder.decode();
			bytes += value.length;
			if (bytes > MAX_MESSAGE_BYTES) {
				await reader.cancel().catch(() => undefined);
				throw new McpError("the MCP server's answer is too large");
			}
			text += decoder.decode(value, { stream: true });
		}
	}

	async #fromStream(response: Response, id: number): Promise<Record<string, any> | undefined> {
		const reader = response.body?.getReader();
		if (!reader) return undefined;
		const decoder = new TextDecoder();
		let buffer = "";
		let bytes = 0;
		const take = (block: string): Record<string, any> | undefined => {
			const data = block
				.split(/\r?\n/)
				.filter((line) => line.startsWith("data:"))
				.map((line) => line.slice(5).replace(/^ /, ""))
				.join("\n");
			if (!data) return undefined;
			try {
				return this.#pick(JSON.parse(data), id);
			} catch {
				return undefined;
			}
		};
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) return take(buffer);
				bytes += value.length;
				if (bytes > MAX_MESSAGE_BYTES) throw new McpError("the MCP server's answer is too large");
				buffer += decoder.decode(value, { stream: true });
				const blocks = buffer.split(/\r?\n\r?\n/);
				buffer = blocks.pop() ?? "";
				for (const block of blocks) {
					const found = take(block);
					if (found) return found;
				}
			}
		} finally {
			await reader.cancel().catch(() => undefined);
		}
	}

	protected request(method: string, params: Record<string, unknown>): Promise<any> {
		const id = this.newId();
		return this.#post({ jsonrpc: "2.0", id, method, params }, id);
	}

	protected async notify(method: string): Promise<void> {
		await this.#post({ jsonrpc: "2.0", method }, undefined);
	}

	protected onProtocol(version: string): void {
		this.#protocol = version;
	}

	async close(): Promise<void> {
		const session = this.#session;
		this.#session = undefined;
		this.reset();
		if (!session) return;
		await this.#fetch(this.#options.url, { method: "DELETE", headers: { ...this.#options.headers, "mcp-session-id": session, "mcp-protocol-version": this.#protocol }, signal: AbortSignal.timeout(3000), redirect: "error" }).then((response) => response.body?.cancel()).catch(() => undefined);
	}
}

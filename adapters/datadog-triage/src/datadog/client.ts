import { readFileSync } from "node:fs";
import { redactText } from "@somework/agent-kit";

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/** The only POST requests this client makes: both are searches that change nothing. */
const SEARCH_PATHS = new Set(["/api/v2/logs/events/search", "/api/v2/events/search"]);

export class DatadogError extends Error {
	override readonly name = "DatadogError";
	readonly status?: number;
	/** Retrying will not help: the monitor does not exist, the query is wrong, or the keys are refused. */
	readonly permanent: boolean;
	readonly kind: "not_found" | "unauthorized" | "bad_request" | "rate_limited" | "unavailable" | "bad_response";
	constructor(kind: DatadogError["kind"], message: string, status?: number) {
		super(message);
		this.kind = kind;
		this.status = status;
		this.permanent = kind === "not_found" || kind === "unauthorized" || kind === "bad_request";
	}
}

export interface DatadogCredentials {
	apiKey: string;
	appKey: string;
}

/** The key pair from a mounted file: `{"apiKey", "appKey"}` (the snake_case spelling is accepted too). Errors never quote the file. */
export function readCredentials(file: string): DatadogCredentials {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch (error) {
		throw new Error(`the Datadog key file ${file} cannot be read: ${(error as NodeJS.ErrnoException).code ?? "error"}`);
	}
	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(text);
	} catch {
		// the parser's own message quotes the text it choked on, which here is a secret
		throw new Error(`the Datadog key file ${file} is not valid JSON`);
	}
	if (typeof parsed !== "object" || parsed === null) throw new Error(`the Datadog key file ${file} needs apiKey and appKey`);
	const apiKey = parsed.apiKey ?? parsed.api_key;
	const appKey = parsed.appKey ?? parsed.app_key;
	if (typeof apiKey !== "string" || apiKey.trim() === "" || typeof appKey !== "string" || appKey.trim() === "") throw new Error(`the Datadog key file ${file} needs apiKey and appKey`);
	return { apiKey: apiKey.trim(), appKey: appKey.trim() };
}

export interface DatadogClientOptions {
	site?: string;
	credentials: DatadogCredentials | (() => DatadogCredentials);
	/** Only for tests: the API base. Its host becomes the only host this client talks to. */
	apiBase?: string;
	fetch?: typeof fetch;
	timeoutMs?: number;
	maxBytes?: number;
}

type Json = Record<string, any>;

export interface TimeRange {
	/** Milliseconds since the epoch. */
	from: number;
	to: number;
}

const isoOf = (ms: number): string => new Date(ms).toISOString();

/**
 * A read-only client of Datadog's API: `GET` requests and two search `POST`s only, the API host of one site and nothing else (https, no redirects),
 * a size cap and a timeout on every call. The keys are read per request from the credentials function and sent only as headers. Errors never
 * contain a key or a response body (a short, redacted message from Datadog is kept for a 400, so a wrong query can be corrected).
 */
export class DatadogClient {
	readonly #base: string;
	readonly #host: string;
	readonly #credentials: () => DatadogCredentials;
	readonly #fetch: typeof fetch;
	readonly #timeoutMs: number;
	readonly #maxBytes: number;

	constructor(options: DatadogClientOptions) {
		const site = (options.site ?? "datadoghq.eu").toLowerCase();
		this.#base = (options.apiBase ?? `https://api.${site}`).replace(/\/$/, "");
		this.#host = new URL(this.#base).host;
		const credentials = options.credentials;
		this.#credentials = typeof credentials === "function" ? credentials : () => credentials;
		this.#fetch = options.fetch ?? fetch;
		this.#timeoutMs = options.timeoutMs ?? 20_000;
		this.#maxBytes = options.maxBytes ?? MAX_RESPONSE_BYTES;
	}

	async #read(response: Response): Promise<string> {
		const reader = response.body?.getReader();
		const chunks: Uint8Array[] = [];
		let size = 0;
		while (reader) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > this.#maxBytes) {
				await reader.cancel();
				throw new DatadogError("bad_response", `Datadog answered with more than ${this.#maxBytes} bytes: narrow the query or the time range`);
			}
			chunks.push(value);
		}
		return Buffer.concat(chunks).toString("utf8");
	}

	async #send(method: "GET" | "POST", path: string, body?: unknown): Promise<Json> {
		if (method === "POST" && !SEARCH_PATHS.has(path)) throw new DatadogError("bad_response", "this client only posts searches");
		const url = new URL(`${this.#base}${path}`);
		if (url.protocol !== "https:" && !(url.hostname === "127.0.0.1" || url.hostname === "localhost")) throw new DatadogError("bad_response", "Datadog is only reached over https");
		if (url.host !== this.#host) throw new DatadogError("bad_response", `refusing to call ${url.host}`);
		const { apiKey, appKey } = this.#credentials();
		let status: number;
		let text: string;
		try {
			const response = await this.#fetch(url, {
				method,
				redirect: "error",
				signal: AbortSignal.timeout(this.#timeoutMs),
				headers: { "DD-API-KEY": apiKey, "DD-APPLICATION-KEY": appKey, accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
				...(body !== undefined ? { body: JSON.stringify(body) } : {}),
			});
			status = response.status;
			text = await this.#read(response);
		} catch (error) {
			if (error instanceof DatadogError) throw error;
			throw new DatadogError("unavailable", `Datadog could not be reached: ${error instanceof Error ? error.name : "error"}`);
		}
		const where = path.split("?")[0]!.split("/").slice(0, 5).join("/");
		if (status === 401 || status === 403) throw new DatadogError("unauthorized", `Datadog refused the keys for ${where} (${status}): the application key lacks the scope this call needs`, status);
		if (status === 404) throw new DatadogError("not_found", `Datadog has nothing at ${where}`, 404);
		if (status === 429) throw new DatadogError("rate_limited", "Datadog is rate limiting these keys", 429);
		if (status >= 500) throw new DatadogError("unavailable", `Datadog answered ${status}`, status);
		if (status >= 400) throw new DatadogError("bad_request", `Datadog rejected the request (${status})${firstError(text)}`, status);
		try {
			const parsed = JSON.parse(text);
			if (typeof parsed !== "object" || parsed === null) throw new Error("not an object");
			return parsed as Json;
		} catch {
			throw new DatadogError("bad_response", "Datadog did not answer with a JSON object");
		}
	}

	#id(id: string | number): string {
		const key = String(id);
		if (!/^[0-9]{1,15}$/.test(key)) throw new DatadogError("not_found", "a Datadog monitor id is a whole number");
		return key;
	}

	async getMonitor(id: string | number): Promise<Json> {
		return this.#send("GET", `/api/v1/monitor/${this.#id(id)}`);
	}

	async searchMonitors(query: string, limit = 25): Promise<Json> {
		return this.#send("GET", `/api/v1/monitor/search?${new URLSearchParams({ query, per_page: String(Math.min(Math.max(limit, 1), 50)), page: "0" })}`);
	}

	searchLogs(params: { query: string; range: TimeRange; limit: number }): Promise<Json> {
		return this.#send("POST", "/api/v2/logs/events/search", { filter: { query: params.query, from: isoOf(params.range.from), to: isoOf(params.range.to) }, sort: "-timestamp", page: { limit: params.limit } });
	}

	queryMetrics(params: { query: string; range: TimeRange }): Promise<Json> {
		return this.#send("GET", `/api/v1/query?${new URLSearchParams({ query: params.query, from: String(Math.floor(params.range.from / 1000)), to: String(Math.floor(params.range.to / 1000)) })}`);
	}

	searchEvents(params: { query: string; range: TimeRange; limit: number }): Promise<Json> {
		return this.#send("POST", "/api/v2/events/search", { filter: { query: params.query, from: isoOf(params.range.from), to: isoOf(params.range.to) }, sort: "-timestamp", page: { limit: params.limit } });
	}

	listIncidents(limit = 10): Promise<Json> {
		return this.#send("GET", `/api/v2/incidents?${new URLSearchParams({ "page[size]": String(Math.min(Math.max(limit, 1), 25)) })}`);
	}
}

/** The first error line of a Datadog 400 (`{"errors": ["..."]}`), redacted and short, as a suffix. */
function firstError(text: string): string {
	try {
		const parsed = JSON.parse(text);
		const first = Array.isArray(parsed?.errors) ? parsed.errors[0] : undefined;
		const message = typeof first === "string" ? first : typeof first?.detail === "string" ? first.detail : typeof first?.title === "string" ? first.title : undefined;
		return message ? `: ${redactText(message.replace(/\s+/g, " ")).slice(0, 200)}` : "";
	} catch {
		return "";
	}
}

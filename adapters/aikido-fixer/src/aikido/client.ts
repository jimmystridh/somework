import { readFileSync } from "node:fs";

export const API_BASES: Record<string, string> = {
	eu: "https://app.aikido.dev/api/public/v1",
	us: "https://app.us.aikido.dev/api/public/v1",
	me: "https://app.me.aikido.dev/api/public/v1",
};
export const OAUTH_URL = "https://app.aikido.dev/api/oauth/token";

const MAX_RESPONSE_BYTES = 512 * 1024;
const TOKEN_MARGIN_MS = 60_000;

export class AikidoError extends Error {
	override readonly name = "AikidoError";
	readonly status?: number;
	/** Retrying will not help: the issue does not exist, or the credentials are refused. */
	readonly permanent: boolean;
	readonly kind: "not_found" | "unauthorized" | "rate_limited" | "unavailable" | "bad_response";
	constructor(kind: AikidoError["kind"], message: string, status?: number) {
		super(message);
		this.kind = kind;
		this.status = status;
		this.permanent = kind === "not_found" || kind === "unauthorized";
	}
}

export interface AikidoCredentials {
	clientId: string;
	clientSecret: string;
}

/** The OAuth2 client pair from a mounted file: `{"clientId", "clientSecret"}` (the snake_case spelling is accepted too). */
export function readCredentials(file: string): AikidoCredentials {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch (error) {
		throw new Error(`the Aikido client file ${file} cannot be read: ${(error as NodeJS.ErrnoException).code ?? "error"}`);
	}
	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(text);
	} catch {
		// the parser's own message quotes the text it choked on, which here is a secret
		throw new Error(`the Aikido client file ${file} is not valid JSON`);
	}
	if (typeof parsed !== "object" || parsed === null) throw new Error(`the Aikido client file ${file} needs clientId and clientSecret`);
	const clientId = parsed.clientId ?? parsed.client_id;
	const clientSecret = parsed.clientSecret ?? parsed.client_secret;
	if (typeof clientId !== "string" || clientId === "" || typeof clientSecret !== "string" || clientSecret === "") throw new Error(`the Aikido client file ${file} needs clientId and clientSecret`);
	return { clientId, clientSecret };
}

export interface AikidoClientOptions {
	region?: string;
	credentials?: AikidoCredentials | (() => AikidoCredentials);
	/** Only for tests and a staging tenant: the API and the token endpoint. Their hosts become the only hosts this client talks to. */
	apiBase?: string;
	oauthUrl?: string;
	fetch?: typeof fetch;
	now?: () => number;
	timeoutMs?: number;
	/** The least time between two requests to Aikido, whatever the number of jobs asking (default 1500 ms). */
	minIntervalMs?: number;
	/** How often a rate-limited request is tried again, after the wait Aikido names or a growing one (default 3). */
	maxRetries?: number;
	/** How long a resolved issue is kept and shared between jobs (default 5 minutes; 0 keeps nothing). */
	cacheMs?: number;
	sleep?: (ms: number) => Promise<void>;
}

const MAX_WAIT_MS = 60_000;
const BASE_WAIT_MS = 2_000;

/** The wait a `Retry-After` header asks for (seconds or a date), cut at a minute; undefined when it names none. */
export function retryAfterMs(header: string | null | undefined, now: number): number | undefined {
	if (!header) return undefined;
	const seconds = Number(header);
	if (Number.isFinite(seconds) && seconds >= 0) return Math.min(MAX_WAIT_MS, Math.round(seconds * 1000));
	const date = Date.parse(header);
	return Number.isNaN(date) ? undefined : Math.min(MAX_WAIT_MS, Math.max(0, date - now));
}

interface Resolved {
	group: Record<string, any>;
	issue?: Record<string, any>;
	issues?: Record<string, any>[];
}

type Json = Record<string, any>;

/**
 * A read-only client of Aikido's public API: OAuth2 client credentials (the token is kept in memory only), `GET` requests only, the
 * API's own host and nothing else, a size cap and a timeout on every call. Errors never contain the secret, the token or a response body.
 */
export class AikidoClient {
	readonly #apiBase: string;
	readonly #oauthUrl: string;
	readonly #hosts: Set<string>;
	readonly #credentials: () => AikidoCredentials;
	readonly #fetch: typeof fetch;
	readonly #now: () => number;
	readonly #timeoutMs: number;
	readonly #minIntervalMs: number;
	readonly #maxRetries: number;
	readonly #cacheMs: number;
	readonly #sleep: (ms: number) => Promise<void>;
	#token?: { value: string; expiresAt: number };
	#pending?: Promise<string>;
	#lastSend = 0;
	#turn: Promise<unknown> = Promise.resolve();
	readonly #groups = new Map<string, { at: number; value: Promise<{ found: Resolved; direct: boolean }> }>();
	readonly #exports = new Map<string, { at: number; value: Promise<Json[]> }>();

	constructor(options: AikidoClientOptions) {
		const region = (options.region ?? "eu").toLowerCase();
		const base = options.apiBase ?? API_BASES[region];
		if (!base) throw new Error(`unknown Aikido region ${region}`);
		this.#apiBase = base.replace(/\/$/, "");
		this.#oauthUrl = options.oauthUrl ?? OAUTH_URL;
		this.#hosts = new Set([new URL(this.#apiBase).host, new URL(this.#oauthUrl).host]);
		const credentials = options.credentials;
		if (!credentials) throw new Error("Aikido credentials are required");
		this.#credentials = typeof credentials === "function" ? credentials : () => credentials;
		this.#fetch = options.fetch ?? fetch;
		this.#now = options.now ?? Date.now;
		this.#timeoutMs = options.timeoutMs ?? 15_000;
		this.#minIntervalMs = options.minIntervalMs ?? 1500;
		this.#maxRetries = options.maxRetries ?? 3;
		this.#cacheMs = options.cacheMs ?? 300_000;
		this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
	}

	/** One request at a time leaves, at least `minIntervalMs` after the previous one: a burst of jobs is spread out instead of sent at once. */
	#paced(): Promise<void> {
		const mine = this.#turn.then(async () => {
			const wait = this.#lastSend + this.#minIntervalMs - this.#now();
			if (wait > 0) await this.#sleep(wait);
			this.#lastSend = this.#now();
		});
		this.#turn = mine.catch(() => undefined);
		return mine;
	}

	/** A paced request that is tried again when Aikido says it is going too fast (429), after the wait it names or a growing one. */
	async #request(url: string, init: RequestInit): Promise<{ status: number; text: string }> {
		for (let attempt = 0; ; attempt++) {
			await this.#paced();
			const answer = await this.#send(url, init);
			if (answer.status !== 429 || attempt >= this.#maxRetries) return answer;
			const wait = answer.retryAfter ?? Math.min(MAX_WAIT_MS, BASE_WAIT_MS * 2 ** attempt) + Math.floor(Math.random() * 500);
			await this.#sleep(wait);
		}
	}

	#remember<T>(cache: Map<string, { at: number; value: Promise<T> }>, key: string, load: () => Promise<T>): Promise<T> {
		const hit = cache.get(key);
		if (hit && this.#now() - hit.at < this.#cacheMs) return hit.value;
		const value = load();
		cache.set(key, { at: this.#now(), value });
		// a failure is not kept: the next job asks again
		value.catch(() => {
			if (cache.get(key)?.value === value) cache.delete(key);
		});
		if (cache.size > 200) for (const [old, entry] of cache) if (this.#now() - entry.at >= this.#cacheMs) cache.delete(old);
		return value;
	}

	#guard(url: string): void {
		const target = new URL(url);
		if (target.protocol !== "https:" && !(target.hostname === "127.0.0.1" || target.hostname === "localhost")) throw new AikidoError("bad_response", "Aikido is only reached over https");
		if (!this.#hosts.has(target.host)) throw new AikidoError("bad_response", `refusing to call ${target.host}`);
	}

	async #read(response: Response): Promise<string> {
		const reader = response.body?.getReader();
		const chunks: Uint8Array[] = [];
		let size = 0;
		while (reader) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > MAX_RESPONSE_BYTES) {
				await reader.cancel();
				throw new AikidoError("bad_response", `Aikido answered with more than ${MAX_RESPONSE_BYTES} bytes`);
			}
			chunks.push(value);
		}
		return Buffer.concat(chunks).toString("utf8");
	}

	async #send(url: string, init: RequestInit): Promise<{ status: number; text: string; retryAfter?: number }> {
		this.#guard(url);
		try {
			const response = await this.#fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(this.#timeoutMs) });
			const retryAfter = retryAfterMs(response.headers?.get?.("retry-after"), this.#now());
			return { status: response.status, text: await this.#read(response), ...(retryAfter !== undefined ? { retryAfter } : {}) };
		} catch (error) {
			if (error instanceof AikidoError) throw error;
			throw new AikidoError("unavailable", `Aikido could not be reached: ${error instanceof Error ? error.name : "error"}`);
		}
	}

	async #accessToken(force = false): Promise<string> {
		if (!force && this.#token && this.#token.expiresAt - TOKEN_MARGIN_MS > this.#now()) return this.#token.value;
		this.#pending ??= (async () => {
			try {
				const { clientId, clientSecret } = this.#credentials();
				const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
				const { status, text } = await this.#request(this.#oauthUrl, { method: "POST", headers: { authorization: `Basic ${basic}`, "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ grant_type: "client_credentials" }) });
				if (status === 400 || status === 401 || status === 403) throw new AikidoError("unauthorized", `Aikido refused the client credentials (${status})`, status);
				if (status >= 400) throw new AikidoError(status === 429 ? "rate_limited" : "unavailable", `Aikido's token endpoint answered ${status}`, status);
				let parsed: Json;
				try {
					parsed = JSON.parse(text);
				} catch {
					throw new AikidoError("bad_response", "Aikido's token endpoint did not answer with JSON");
				}
				if (typeof parsed.access_token !== "string" || parsed.access_token === "") throw new AikidoError("bad_response", "Aikido's token answer has no access_token");
				const seconds = Number(parsed.expires_in);
				this.#token = { value: parsed.access_token, expiresAt: this.#now() + (Number.isFinite(seconds) && seconds > 0 ? seconds : 300) * 1000 };
				return parsed.access_token;
			} finally {
				this.#pending = undefined;
			}
		})();
		return this.#pending;
	}

	async #get(path: string, retried = false): Promise<Json> {
		const token = await this.#accessToken(retried);
		const { status, text } = await this.#request(`${this.#apiBase}${path}`, { method: "GET", headers: { authorization: `Bearer ${token}`, accept: "application/json" } });
		if (status === 401 && !retried) return this.#get(path, true);
		if (status === 401 || status === 403) throw new AikidoError("unauthorized", `Aikido refused the request for ${path.split("/").slice(0, 3).join("/")} (${status}): the client lacks read access to issues`, status);
		if (status === 404) throw new AikidoError("not_found", `Aikido has nothing at ${path.split("/").slice(0, 3).join("/")}`, 404);
		if (status === 429) throw new AikidoError("rate_limited", "Aikido is rate limiting this client", 429);
		if (status >= 500) throw new AikidoError("unavailable", `Aikido answered ${status}`, status);
		if (status >= 400) throw new AikidoError("bad_response", `Aikido answered ${status}`, status);
		try {
			const parsed = JSON.parse(text);
			if (typeof parsed !== "object" || parsed === null) throw new Error("not an object");
			return parsed as Json;
		} catch {
			throw new AikidoError("bad_response", "Aikido did not answer with a JSON object");
		}
	}

	async #groupIssues(groupId: string): Promise<Json[]> {
		try {
			const exported = (await this.#get(`/issues/export?format=json&filter_status=open&filter_issue_group_id=${groupId}`)) as unknown;
			return Array.isArray(exported) ? exported.filter((item): item is Json => typeof item === "object" && item !== null && !Array.isArray(item)).slice(0, 50) : [];
		} catch (error) {
			if (error instanceof AikidoError && error.kind === "unauthorized") throw error;
			return [];
		}
	}

	/** The group (or the issue and its group) an id names: one to three requests, shared between jobs for a few minutes. */
	#lookup(key: string): Promise<{ found: Resolved; direct: boolean }> {
		return this.#remember(this.#groups, key, async () => {
			try {
				return { found: { group: await this.#get(`/issues/groups/${key}`) }, direct: true };
			} catch (error) {
				if (!(error instanceof AikidoError) || error.kind !== "not_found") throw error;
			}
			const issue = await this.#get(`/issues/${key}`);
			const groupId = issue.group_id ?? issue.groupId;
			if (!Number.isInteger(groupId)) return { found: { group: { id: issue.id, title: issue.rule ?? "", severity: issue.severity, type: issue.type }, issue }, direct: false };
			return { found: { group: await this.#get(`/issues/groups/${groupId}`), issue }, direct: false };
		});
	}

	/**
	 * The issue group with that id and the open issues in it (file, package, versions: the group alone has none of that); when there is no
	 * group, the issue with that id and its group. The issues are best effort: a group is still returned when they cannot be read.
	 * `details: false` leaves the issues out, which saves the heaviest request: enough to decide whether the issue is worth working on.
	 * Ids are integers: anything else is refused before a request is made.
	 */
	async resolveIssue(id: string | number, options: { details?: boolean } = {}): Promise<Resolved> {
		const key = String(id);
		if (!/^[0-9]{1,12}$/.test(key)) throw new AikidoError("not_found", "an Aikido issue id is a whole number");
		const { found, direct } = await this.#lookup(key);
		if (!direct || options.details === false) return found;
		const issues = await this.#remember(this.#exports, key, () => this.#groupIssues(key));
		return { group: found.group, ...(issues.length ? { issue: issues[0], issues } : {}) };
	}
}

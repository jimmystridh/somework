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
	#token?: { value: string; expiresAt: number };
	#pending?: Promise<string>;

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

	async #send(url: string, init: RequestInit): Promise<{ status: number; text: string }> {
		this.#guard(url);
		try {
			const response = await this.#fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(this.#timeoutMs) });
			return { status: response.status, text: await this.#read(response) };
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
				const { status, text } = await this.#send(this.#oauthUrl, { method: "POST", headers: { authorization: `Basic ${basic}`, "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ grant_type: "client_credentials" }) });
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
		const { status, text } = await this.#send(`${this.#apiBase}${path}`, { method: "GET", headers: { authorization: `Bearer ${token}`, accept: "application/json" } });
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

	/**
	 * The issue group with that id and the open issues in it (file, package, versions: the group alone has none of that); when there is no
	 * group, the issue with that id and its group. The issues are best effort: a group is still returned when they cannot be read.
	 * Ids are integers: anything else is refused before a request is made.
	 */
	async resolveIssue(id: string | number): Promise<{ group: Json; issue?: Json; issues?: Json[] }> {
		const key = String(id);
		if (!/^[0-9]{1,12}$/.test(key)) throw new AikidoError("not_found", "an Aikido issue id is a whole number");
		try {
			const group = await this.#get(`/issues/groups/${key}`);
			const issues = await this.#groupIssues(key);
			return { group, ...(issues.length ? { issue: issues[0], issues } : {}) };
		} catch (error) {
			if (!(error instanceof AikidoError) || error.kind !== "not_found") throw error;
		}
		const issue = await this.#get(`/issues/${key}`);
		const groupId = issue.group_id ?? issue.groupId;
		if (!Number.isInteger(groupId)) return { group: { id: issue.id, title: issue.rule ?? "", severity: issue.severity, type: issue.type }, issue };
		return { group: await this.#get(`/issues/groups/${groupId}`), issue };
	}
}

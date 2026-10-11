import { request as httpsRequest, Agent } from "node:https";

export class JiraError extends Error {
	override readonly name = "JiraError";
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

/** The ticket system did not answer (a network error or a timeout) or failed on its side: an outage, as opposed to an answer that says no. */
export const isUnreachable = (error: unknown): boolean => error instanceof JiraError && ((error.status === 0 && error.message.startsWith("cannot reach the ticket system")) || error.status >= 500);

export interface JiraClientOptions {
	/** `https://jira.example.com`, no trailing slash. */
	baseUrl: string;
	/** Personal access token, sent as a bearer token. */
	token: string;
	/** Client certificate (PKCS#12) for hosts that demand mutual TLS. */
	pfx?: Buffer;
	passphrase?: string;
	/** PEM of a private CA that signed the host's certificate. */
	ca?: string;
	/** How long a write that is not repeated may take (default 30 s). */
	timeoutMs?: number;
	/** How long one try of a read may take before it is given up and tried again (default 10 s): the ticket system has been seen to answer in 0.2 s or not at all. */
	readTimeoutMs?: number;
	/** How many times a read is tried when the ticket system does not answer or fails on its side (default 4). */
	readAttempts?: number;
	/** The pause before a repeated try is `retryPauseMs * attempt` (default 200 ms). */
	retryPauseMs?: number;
}

export interface JiraUser {
	name?: string;
	key?: string;
	displayName?: string;
	emailAddress?: string;
	active?: boolean;
}

export interface Comment {
	id: string;
	author?: JiraUser;
	body: string;
	created?: string;
}

export interface Attachment {
	id: string;
	filename: string;
	size?: number;
	mimeType?: string;
	created?: string;
}

export interface Issue {
	key: string;
	fields: {
		summary?: string;
		description?: string | null;
		environment?: string | null;
		status?: { name: string };
		issuetype?: { name: string };
		project?: { key?: string };
		labels?: string[];
		components?: { name: string }[];
		priority?: { name?: string } | null;
		reporter?: JiraUser | null;
		created?: string;
		attachment?: Attachment[];
		comment?: { comments?: Comment[] };
		[field: string]: unknown;
	};
}

export interface SearchHit {
	key: string;
	fields: { summary?: string; status?: { name: string }; issuetype?: { name: string }; created?: string; labels?: string[] };
}

const ISSUE_FIELDS = "summary,description,environment,status,issuetype,project,labels,components,priority,reporter,created,attachment,comment";
const SEARCH_FIELDS = "summary,status,issuetype,created,labels";

/**
 * What this role may write at all. The bot changes a ticket's text fields, labels, components and priority and adds comments, and nothing else:
 * the client has no method for the assignee, a transition or the reporter, and refuses a payload that names one of them. `changes.ts` holds the policy
 * the engine applies; this is the second lock.
 */
export const WRITABLE_FIELD_KEYS = ["description", "environment", "priority", "components", "labels"] as const;
const FIELD_PUT_KEYS: readonly string[] = ["description", "environment", "priority", "components"];

const refuse = (what: string): never => {
	throw new JiraError(0, `refused: ${what}`);
};

/**
 * The part of the ticket system's REST API (Jira Data Center / Server, v2) the triage role uses, over mutual TLS with a personal access token. The
 * token and the client certificate never leave this class: error messages are scrubbed of the token, and nothing here reaches a log or a model.
 */
export class JiraClient {
	readonly #base: URL;
	readonly #token: string;
	readonly #agent: Agent;
	readonly #timeout: number;
	readonly #readTimeout: number;
	readonly #readAttempts: number;
	readonly #pause: number;

	constructor(options: JiraClientOptions) {
		this.#base = new URL(options.baseUrl);
		this.#token = options.token;
		this.#timeout = options.timeoutMs ?? 30_000;
		this.#readTimeout = options.readTimeoutMs ?? 10_000;
		this.#readAttempts = options.readAttempts ?? 4;
		this.#pause = options.retryPauseMs ?? 200;
		this.#agent = new Agent({ pfx: options.pfx, passphrase: options.passphrase, ca: options.ca, keepAlive: true, maxSockets: 4 });
	}

	close(): void {
		this.#agent.destroy();
	}

	#scrub(text: string): string {
		return this.#token ? text.replaceAll(this.#token, "***") : text;
	}

	/**
	 * One call. A read (GET) or a write that gives the same result when repeated (PUT) is tried again when the ticket system does not answer in time
	 * or fails on its side; a comment or a new ticket is sent once, because a try that was lost after it was sent may have been applied.
	 */
	async #call(method: string, path: string, options: { json?: unknown; quick?: boolean } = {}): Promise<{ status: number; body: string }> {
		const repeatable = method === "GET" || method === "PUT";
		const attempts = repeatable && !options.quick ? this.#readAttempts : 1;
		for (let attempt = 1; ; attempt++) {
			try {
				const response = await this.#send(method, path, options.json, options.quick ? 4_000 : repeatable ? this.#readTimeout : this.#timeout);
				if (response.status >= 500 && attempt < attempts) {
					await new Promise((resolve) => setTimeout(resolve, this.#pause * attempt));
					continue;
				}
				return response;
			} catch (error) {
				if (attempt >= attempts || !isUnreachable(error)) throw error;
				await new Promise((resolve) => setTimeout(resolve, this.#pause * attempt));
			}
		}
	}

	#send(method: string, path: string, json: unknown, timeoutMs: number): Promise<{ status: number; body: string }> {
		const payload = json === undefined ? undefined : Buffer.from(JSON.stringify(json));
		const url = new URL(path, `${this.#base.origin}/`);
		return new Promise((resolve, reject) => {
			const req = httpsRequest(
				url,
				{
					method,
					agent: this.#agent,
					headers: {
						authorization: `Bearer ${this.#token}`,
						accept: "application/json",
						...(payload ? { "content-type": "application/json", "content-length": String(payload.length) } : {}),
					},
				},
				(response) => {
					const chunks: Buffer[] = [];
					response.on("data", (chunk: Buffer) => chunks.push(chunk));
					response.on("error", (error) => reject(new JiraError(0, this.#scrub(`cannot reach the ticket system: ${error.message}`))));
					response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
				},
			);
			req.setTimeout(timeoutMs, () => req.destroy(new Error("request timed out")));
			req.on("error", (error) => reject(new JiraError(0, this.#scrub(`cannot reach the ticket system: ${error.message}`))));
			if (payload) req.write(payload);
			req.end();
		});
	}

	async #json<T>(method: string, path: string, options?: { json?: unknown; quick?: boolean }): Promise<T> {
		const response = await this.#call(method, path, options);
		if (response.status < 200 || response.status >= 300) {
			let detail = "";
			try {
				const parsed = JSON.parse(response.body) as { errorMessages?: string[]; errors?: Record<string, string> };
				detail = [...(parsed.errorMessages ?? []), ...Object.values(parsed.errors ?? {})].join("; ");
			} catch {
				detail = response.body.slice(0, 200);
			}
			throw new JiraError(response.status, this.#scrub(`${method} ${path.split("?")[0]} answered ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`));
		}
		return (response.body ? JSON.parse(response.body) : undefined) as T;
	}

	/** Who the token belongs to: the cheapest call that proves the certificate and the token work. One short try. */
	myself(): Promise<JiraUser> {
		return this.#json("GET", "/rest/api/2/myself", { quick: true });
	}

	getIssue(key: string): Promise<Issue> {
		return this.#json("GET", `/rest/api/2/issue/${encodeURIComponent(key)}?fields=${ISSUE_FIELDS}`);
	}

	async search(jql: string, maxResults = 10): Promise<{ total: number; issues: SearchHit[] }> {
		return this.#json("GET", `/rest/api/2/search?jql=${encodeURIComponent(jql)}&maxResults=${Math.min(maxResults, 50)}&fields=${SEARCH_FIELDS}`);
	}

	async comments(key: string): Promise<Comment[]> {
		const body = await this.#json<{ comments: Comment[] }>("GET", `/rest/api/2/issue/${encodeURIComponent(key)}/comment?maxResults=200`);
		return body.comments ?? [];
	}

	addComment(key: string, body: string): Promise<{ id: string }> {
		return this.#json("POST", `/rest/api/2/issue/${encodeURIComponent(key)}/comment`, { json: { body } });
	}

	/** Sets text fields, priority and components. Anything else (the assignee, the status, the reporter, any other field) is refused here, whoever asks. */
	async updateFields(key: string, fields: Partial<Record<"description" | "environment" | "priority" | "components", unknown>>): Promise<void> {
		for (const name of Object.keys(fields)) if (!FIELD_PUT_KEYS.includes(name)) refuse(`the field ${name} is not one this role writes`);
		if (Object.keys(fields).length === 0) return;
		await this.#json("PUT", `/rest/api/2/issue/${encodeURIComponent(key)}`, { json: { fields } });
	}

	/** Adds and removes single labels, so a label another person set meanwhile is kept. */
	async updateLabels(key: string, change: { add?: readonly string[]; remove?: readonly string[] }): Promise<void> {
		const operations = [...(change.add ?? []).map((label) => ({ add: label })), ...(change.remove ?? []).map((label) => ({ remove: label }))];
		if (operations.length === 0) return;
		await this.#json("PUT", `/rest/api/2/issue/${encodeURIComponent(key)}`, { json: { update: { labels: operations } } });
	}

	/** A user by name, with the address Jira holds: the hub strips addresses from events, so the reporter's is read here. */
	async user(name: string): Promise<JiraUser | undefined> {
		try {
			const user = await this.#json<JiraUser>("GET", `/rest/api/2/user?username=${encodeURIComponent(name)}`);
			return user?.name ? user : undefined;
		} catch (error) {
			if (error instanceof JiraError && (error.status === 404 || error.status === 400)) return undefined;
			throw error;
		}
	}

	createIssue(issue: { project: string; type: string; summary: string; description: string; environment?: string; labels?: readonly string[]; components?: readonly string[] }): Promise<{ id: string; key: string }> {
		const fields: Record<string, unknown> = {
			project: { key: issue.project },
			issuetype: { name: issue.type },
			summary: issue.summary,
			description: issue.description,
			...(issue.environment ? { environment: issue.environment } : {}),
			...(issue.labels && issue.labels.length > 0 ? { labels: [...issue.labels] } : {}),
			...(issue.components && issue.components.length > 0 ? { components: issue.components.map((name) => ({ name })) } : {}),
		};
		return this.#json("POST", "/rest/api/2/issue", { json: { fields } });
	}

	/** The address a person opens a ticket at. */
	browseUrl(key: string): string {
		return `${this.#base.origin}/browse/${encodeURIComponent(key)}`;
	}
}

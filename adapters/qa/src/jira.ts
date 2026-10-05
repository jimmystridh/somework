import { request as httpsRequest, Agent } from "node:https";

export class JiraError extends Error {
	override readonly name = "JiraError";
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

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
	timeoutMs?: number;
}

export interface Issue {
	key: string;
	fields: {
		summary?: string;
		description?: string | null;
		status?: { name: string; statusCategory?: { key?: string } };
		assignee?: { name?: string; key?: string; displayName?: string } | null;
		labels?: string[];
		components?: { name: string }[];
		issuetype?: { name: string };
		comment?: { comments?: Comment[] };
		attachment?: { id: string; filename: string; size?: number }[];
		issuelinks?: unknown[];
		[field: string]: unknown;
	};
	changelog?: { histories?: History[] };
}

export interface Comment {
	id: string;
	author?: { displayName?: string; name?: string };
	body: string;
	created?: string;
}

export interface History {
	created?: string;
	author?: { displayName?: string; name?: string };
	items: { field: string; fromString?: string | null; toString?: string | null; from?: string | null; to?: string | null }[];
}

export interface Transition {
	id: string;
	name: string;
	to: { name: string; statusCategory?: { key?: string } };
}

const ISSUE_FIELDS = "summary,description,status,assignee,labels,components,issuetype,comment,attachment,issuelinks,reporter,priority,created,updated";

/**
 * The part of the ticket system's REST API (Jira Data Center / Server, v2) the QA role uses. It lives in the harness: the token and the
 * client certificate never reach the sandbox, a log, an artifact or a result (error messages are scrubbed of the token).
 */
export class JiraClient {
	readonly #base: URL;
	readonly #token: string;
	readonly #agent: Agent;
	readonly #timeout: number;

	constructor(options: JiraClientOptions) {
		this.#base = new URL(options.baseUrl);
		this.#token = options.token;
		this.#timeout = options.timeoutMs ?? 30_000;
		this.#agent = new Agent({ pfx: options.pfx, passphrase: options.passphrase, ca: options.ca, keepAlive: true, maxSockets: 4 });
	}

	close(): void {
		this.#agent.destroy();
	}

	#scrub(text: string): string {
		return this.#token ? text.replaceAll(this.#token, "***") : text;
	}

	async #call(method: string, path: string, options: { json?: unknown; body?: Buffer; headers?: Record<string, string> } = {}): Promise<{ status: number; body: string }> {
		const payload = options.body ?? (options.json === undefined ? undefined : Buffer.from(JSON.stringify(options.json)));
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
						...(options.json !== undefined ? { "content-type": "application/json" } : {}),
						...(payload ? { "content-length": String(payload.length) } : {}),
						...options.headers,
					},
				},
				(response) => {
					const chunks: Buffer[] = [];
					response.on("data", (chunk: Buffer) => chunks.push(chunk));
					response.on("error", reject);
					response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
				},
			);
			req.setTimeout(this.#timeout, () => req.destroy(new Error("request timed out")));
			req.on("error", (error) => reject(new JiraError(0, this.#scrub(`cannot reach the ticket system: ${error.message}`))));
			if (payload) req.write(payload);
			req.end();
		});
	}

	async #json<T>(method: string, path: string, options?: Parameters<JiraClient["#call"]>[2]): Promise<T> {
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

	/** Who the token belongs to; the cheapest call that proves the certificate and the token work. */
	myself(): Promise<{ name?: string; displayName?: string }> {
		return this.#json("GET", "/rest/api/2/myself");
	}

	getIssue(key: string, expand?: "changelog"): Promise<Issue> {
		return this.#json("GET", `/rest/api/2/issue/${encodeURIComponent(key)}?fields=${ISSUE_FIELDS}${expand ? `&expand=${expand}` : ""}`);
	}

	async search(jql: string, maxResults = 20): Promise<{ total: number; issues: Issue[] }> {
		return this.#json("GET", `/rest/api/2/search?jql=${encodeURIComponent(jql)}&maxResults=${Math.min(maxResults, 50)}&fields=summary,status,assignee,labels,components,issuetype`);
	}

	async comments(key: string): Promise<Comment[]> {
		const body = await this.#json<{ comments: Comment[] }>("GET", `/rest/api/2/issue/${encodeURIComponent(key)}/comment?maxResults=100`);
		return body.comments ?? [];
	}

	addComment(key: string, body: string): Promise<{ id: string }> {
		return this.#json("POST", `/rest/api/2/issue/${encodeURIComponent(key)}/comment`, { json: { body } });
	}

	async addLabel(key: string, label: string): Promise<void> {
		await this.#json("PUT", `/rest/api/2/issue/${encodeURIComponent(key)}`, { json: { update: { labels: [{ add: label }] } } });
	}

	async removeLabel(key: string, label: string): Promise<void> {
		await this.#json("PUT", `/rest/api/2/issue/${encodeURIComponent(key)}`, { json: { update: { labels: [{ remove: label }] } } });
	}

	async transitions(key: string): Promise<Transition[]> {
		const body = await this.#json<{ transitions: Transition[] }>("GET", `/rest/api/2/issue/${encodeURIComponent(key)}/transitions`);
		return body.transitions ?? [];
	}

	async transition(key: string, id: string): Promise<void> {
		await this.#json("POST", `/rest/api/2/issue/${encodeURIComponent(key)}/transitions`, { json: { transition: { id } } });
	}

	/** `user` is what the changelog recorded: a user key (`JIRAUSER123`) or a user name. */
	async assign(key: string, user: string): Promise<void> {
		await this.#json("PUT", `/rest/api/2/issue/${encodeURIComponent(key)}/assignee`, { json: /^JIRAUSER[0-9]+$/.test(user) ? { key: user } : { name: user } });
	}

	async attach(key: string, filename: string, bytes: Buffer, contentType: string): Promise<{ id: string; filename: string }[]> {
		const boundary = `----qa${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
		const safeName = filename.replace(/[^A-Za-z0-9._-]/g, "_");
		const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safeName}"\r\nContent-Type: ${contentType}\r\n\r\n`);
		const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
		return this.#json("POST", `/rest/api/2/issue/${encodeURIComponent(key)}/attachments`, {
			body: Buffer.concat([head, bytes, tail]),
			headers: { "content-type": `multipart/form-data; boundary=${boundary}`, "x-atlassian-token": "no-check" },
		});
	}
}

const DONE_NAME = /^(done|closed|resolved|complete|completed|released|finished|accepted|cancell?ed|rejected|won'?t do|wontfix)$/i;

/** A status that ends the ticket's life. The QA role never moves a ticket into one, whatever the workflow calls it. */
export function isDoneStatus(status: { name: string; statusCategory?: { key?: string } } | undefined): boolean {
	if (!status) return false;
	return status.statusCategory?.key === "done" || DONE_NAME.test(status.name.trim());
}

/** The most recent assignee of the ticket before it became unassigned, from its changelog (newest history first). */
export function previousAssignee(histories: readonly History[] | undefined): { name: string; displayName?: string } | undefined {
	const ordered = [...(histories ?? [])].sort((a, b) => String(b.created ?? "").localeCompare(String(a.created ?? "")));
	for (const history of ordered) {
		for (const item of history.items) {
			if (item.field !== "assignee") continue;
			// `from` is the user key/name the ticket had before this change; empty when it had none
			if (item.from) return { name: item.from, ...(item.fromString ? { displayName: item.fromString } : {}) };
		}
	}
	return undefined;
}

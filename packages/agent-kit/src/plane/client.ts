import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";

/** What Plane said when it refused, or why it could not be asked; never carries the key. */
export class PlaneError extends Error {
	override readonly name = "PlaneError";
	readonly status?: number;
	/** The id of the ticket that already holds an external id, when Plane refused a duplicate. */
	readonly existingId?: string;
	constructor(message: string, status?: number, existingId?: string) {
		super(message);
		this.status = status;
		this.existingId = existingId;
	}
}

export const EXTERNAL_SOURCE = "somework-product-manager";
const MAX_ANSWER_BYTES = 256 * 1024;
const KEY = /^[A-Za-z][A-Za-z0-9]{0,19}-\d{1,9}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PlaneClientOptions {
	baseUrl: string;
	workspace: string;
	projectId: string;
	apiKey: () => string;
	caPem?: string;
	/** The label names a ticket may carry; each must exist in the project. */
	labels: readonly string[];
	timeoutMs?: number;
}

export interface Ticket {
	id: string;
	/** `PROJ-123`, when Plane said which project and number. */
	key?: string;
	title: string;
	state?: string;
	priority?: string;
	labels?: string[];
	description?: string;
	url?: string;
}

export interface NewTicket {
	title: string;
	/** Plain text: paragraphs, and lines that start with "- " as a list. */
	description: string;
	label: string;
	/** Makes filing again idempotent: the same key never makes a second ticket. */
	externalId: string;
	/** A ticket of this project (key or id) the new one belongs under. */
	parent?: string;
}

export const readPlaneKey = (path: string): (() => string) => () => {
	const key = readFileSync(path, "utf8").trim();
	if (key.length < 8) throw new PlaneError("the Plane key file is empty");
	return key;
};

const escapeHtml = (value: string): string => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Plain text as the HTML Plane stores: blank lines separate paragraphs, lines with "- " are a list; nothing in the text is ever markup. */
export function htmlOf(text: string): string {
	return text
		.replace(/\r\n?/g, "\n")
		.trim()
		.split(/\n{2,}/)
		.map((block) => {
			const lines = block.split("\n").map((line) => line.trimEnd());
			return lines.every((line) => /^\s*[-*] /.test(line)) ? `<ul>${lines.map((line) => `<li>${escapeHtml(line.replace(/^\s*[-*] /, ""))}</li>`).join("")}</ul>` : `<p>${lines.map(escapeHtml).join("<br>")}</p>`;
		})
		.join("");
}

const plainOf = (html: string): string =>
	html
		.replace(/<\/(p|li|h[1-6])>/gi, "\n")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<[^>]*>/g, "")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&amp;/g, "&")
		.replace(/\n{3,}/g, "\n\n")
		.trim();

/**
 * Plane, as far as one product-management agent needs it: look tickets up, read one, file one and comment on one, all in a single project.
 * There is no way to change, move, assign, prioritise or delete a ticket: what is not here cannot be asked of Plane through this client.
 */
export class PlaneClient {
	readonly #base: URL;
	readonly #options: PlaneClientOptions;
	#labelIds: Map<string, string> | undefined;

	constructor(options: PlaneClientOptions) {
		this.#base = new URL(options.baseUrl.endsWith("/") ? options.baseUrl : `${options.baseUrl}/`);
		if (this.#base.protocol !== "https:" && this.#base.protocol !== "http:") throw new Error("the Plane address must be http or https");
		this.#options = options;
	}

	get labels(): readonly string[] {
		return this.#options.labels;
	}

	#path(rest: string): string {
		return `api/v1/workspaces/${encodeURIComponent(this.#options.workspace)}/${rest}`;
	}

	#projectPath(rest: string): string {
		return this.#path(`projects/${this.#options.projectId}/${rest}`);
	}

	async #call(method: string, path: string, body?: unknown, query?: Record<string, string>): Promise<{ status: number; json: any }> {
		const url = new URL(path, this.#base);
		for (const [name, value] of Object.entries(query ?? {})) url.searchParams.set(name, value);
		const payload = body === undefined ? undefined : JSON.stringify(body);
		const transport = url.protocol === "https:" ? https : http;
		return await new Promise((resolve, reject) => {
			const request = transport.request(
				url,
				{
					method,
					timeout: this.#options.timeoutMs ?? 15_000,
					...(this.#options.caPem ? { ca: this.#options.caPem } : {}),
					headers: { "x-api-key": this.#options.apiKey(), accept: "application/json", ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}) },
				},
				(response) => {
					const chunks: Buffer[] = [];
					let size = 0;
					response.on("data", (chunk: Buffer) => {
						size += chunk.length;
						if (size > MAX_ANSWER_BYTES) return void request.destroy(new PlaneError("Plane's answer was too large"));
						chunks.push(chunk);
					});
					response.on("end", () => {
						const text = Buffer.concat(chunks).toString("utf8");
						try {
							resolve({ status: response.statusCode ?? 0, json: text ? JSON.parse(text) : {} });
						} catch {
							reject(new PlaneError("Plane answered something that is not JSON", response.statusCode));
						}
					});
				},
			);
			request.on("timeout", () => request.destroy(new PlaneError("Plane did not answer in time")));
			request.on("error", (error) => reject(error instanceof PlaneError ? error : new PlaneError(`Plane could not be reached (${(error as NodeJS.ErrnoException).code ?? "error"})`)));
			request.end(payload);
		});
	}

	#refused(answer: { status: number; json: any }): never {
		const reason = typeof answer.json?.error === "string" ? answer.json.error : typeof answer.json?.detail === "string" ? answer.json.detail : `Plane answered ${answer.status}`;
		throw new PlaneError(reason.slice(0, 300), answer.status, answer.status === 409 && typeof answer.json?.id === "string" ? answer.json.id : undefined);
	}

	#ticket(raw: any): Ticket {
		const identifier = raw.project_detail?.identifier ?? raw.project__identifier;
		const description = typeof raw.description_stripped === "string" && raw.description_stripped !== "" ? raw.description_stripped : typeof raw.description_html === "string" ? plainOf(raw.description_html) : undefined;
		const labels = Array.isArray(raw.labels) ? raw.labels.map((label: any) => (typeof label === "string" ? this.#labelNameOf(label) : label?.name)).filter((name: unknown): name is string => typeof name === "string") : undefined;
		return {
			id: String(raw.id),
			...(identifier && raw.sequence_id ? { key: `${identifier}-${raw.sequence_id}` } : {}),
			title: String(raw.name ?? ""),
			...(typeof raw.state === "string" ? { state: raw.state } : typeof raw.state?.name === "string" ? { state: raw.state.name } : {}),
			...(typeof raw.priority === "string" ? { priority: raw.priority } : {}),
			...(labels ? { labels } : {}),
			...(description ? { description } : {}),
		};
	}

	#labelNameOf(id: string): string {
		for (const [name, known] of this.#labelIds ?? []) if (known === id) return name;
		return id;
	}

	async #labelIdOf(name: string): Promise<string> {
		if (!this.#labelIds) {
			const answer = await this.#call("GET", this.#projectPath("labels/"));
			if (answer.status !== 200) this.#refused(answer);
			const list: any[] = Array.isArray(answer.json) ? answer.json : Array.isArray(answer.json?.results) ? answer.json.results : [];
			this.#labelIds = new Map(list.filter((label) => typeof label?.name === "string" && typeof label?.id === "string").map((label) => [String(label.name).toLowerCase(), String(label.id)]));
		}
		const id = this.#labelIds.get(name);
		if (!id) throw new PlaneError(`the project has no label "${name}": ask the owner to add it in Plane`);
		return id;
	}

	/** Tickets of the project whose title, description or key match. */
	async search(query: string, limit = 10): Promise<Ticket[]> {
		const answer = await this.#call("GET", this.#path("work-items/search/"), undefined, { search: query, limit: String(Math.min(Math.max(limit, 1), 25)), project_id: this.#options.projectId });
		if (answer.status !== 200) this.#refused(answer);
		const found: any[] = Array.isArray(answer.json?.issues) ? answer.json.issues : [];
		return found.filter((item) => item.project_id === undefined || String(item.project_id).toLowerCase() === this.#options.projectId).map((item) => this.#ticket(item));
	}

	/** One ticket of the project, by its key (`PROJ-123`) or its id; a ticket of another project is refused. */
	async get(ref: string): Promise<Ticket> {
		const trimmed = ref.trim();
		if (!KEY.test(trimmed) && !UUID.test(trimmed)) throw new PlaneError("a ticket is named by its key (PROJ-123) or its id");
		const answer = await this.#call("GET", KEY.test(trimmed) ? this.#path(`work-items/${trimmed}/`) : this.#projectPath(`work-items/${trimmed.toLowerCase()}/`));
		if (answer.status === 404) throw new PlaneError(`there is no ticket ${trimmed}`, 404);
		if (answer.status !== 200) this.#refused(answer);
		const project = answer.json?.project ?? answer.json?.project_id;
		if (typeof project === "string" && project.toLowerCase() !== this.#options.projectId) throw new PlaneError(`there is no ticket ${trimmed} in this project`, 404);
		return this.#ticket(answer.json);
	}

	/** Files a ticket with no priority and the project's default state. Filing the same external id again returns the first ticket and changes nothing. */
	async create(ticket: NewTicket): Promise<Ticket & { created: boolean }> {
		const label = ticket.label.toLowerCase();
		if (!this.#options.labels.includes(label)) throw new PlaneError(`the label must be one of: ${this.#options.labels.join(", ")}`);
		const parent = ticket.parent ? (await this.get(ticket.parent)).id : undefined;
		const body = {
			name: ticket.title,
			description_html: htmlOf(ticket.description),
			priority: "none",
			labels: [await this.#labelIdOf(label)],
			external_id: ticket.externalId,
			external_source: EXTERNAL_SOURCE,
			...(parent ? { parent } : {}),
		};
		const answer = await this.#call("POST", this.#projectPath("work-items/"), body);
		if (answer.status === 201 || answer.status === 200) return { ...this.#ticket(answer.json), created: true };
		if (answer.status === 409) {
			const existing = typeof answer.json?.id === "string" ? answer.json.id : undefined;
			if (!existing) this.#refused(answer);
			return { ...(await this.get(existing)), created: false };
		}
		return this.#refused(answer);
	}

	/** Adds a comment to a ticket of the project, in the name of the agent's own Plane user. */
	async comment(ref: string, text: string): Promise<Ticket> {
		const ticket = await this.get(ref);
		const answer = await this.#call("POST", this.#projectPath(`work-items/${ticket.id}/comments/`), { comment_html: htmlOf(text), external_source: EXTERNAL_SOURCE });
		if (answer.status !== 201 && answer.status !== 200) this.#refused(answer);
		return ticket;
	}
}

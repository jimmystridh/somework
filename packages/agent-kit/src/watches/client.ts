import { readFileSync } from "node:fs";
import { callHub, type HubCallOptions } from "../hub-http.ts";

export interface WatchView {
	id: string;
	repository: string;
	number: number;
	/** The topic the events arrive on. */
	topic: string;
	status: "active" | "closed" | "ended";
	endReason?: string;
	createdAt: string;
	lastActivityAt: string;
	closedAt?: string;
	endedAt?: string;
	expiresAt?: string;
}

export interface WatchAsk {
	/** `owner/name`, with `number`; or give `url`. */
	repository?: string;
	number?: number;
	url?: string;
}

export interface WatchCreated extends WatchView {
	created: boolean;
	note: string;
}

/** What the hub said when it refused, or why it could not be asked; never carries the token. */
export class WatchesError extends Error {
	override readonly name = "WatchesError";
	readonly status?: number;
	constructor(message: string, status?: number) {
		super(message);
		this.status = status;
	}
}

export function readWatchToken(path: string): () => string {
	return () => {
		const token = readFileSync(path, "utf8").trim();
		if (token.length < 8) throw new WatchesError("the watch token file is empty");
		return token;
	};
}

/** Asks the event hub to watch pull requests for this agent ("tell me about PR 1234"). Only this agent's own watches can be listed or cancelled. */
export class WatchesClient {
	readonly #base: URL;
	readonly #options: HubCallOptions;

	constructor(options: HubCallOptions) {
		this.#base = new URL(options.url);
		if (this.#base.protocol !== "https:" && this.#base.protocol !== "http:") throw new Error("the watches address must be http or https");
		this.#options = options;
	}

	#call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
		return callHub(this.#options, this.#base, method, path, body, (message, status) => new WatchesError(message, status));
	}

	#refused(answer: { status: number; json: any }): never {
		throw new WatchesError(typeof answer.json?.error === "string" ? answer.json.error.slice(0, 300) : `the hub answered ${answer.status}`, answer.status);
	}

	/** Starts watching, or renews the watch of the same pull request (`created` is false then). */
	async watch(ask: WatchAsk): Promise<WatchCreated> {
		const answer = await this.#call("POST", "/v1/watches", ask);
		if (answer.status !== 201 && answer.status !== 200) this.#refused(answer);
		return answer.json as WatchCreated;
	}

	async list(): Promise<WatchView[]> {
		const answer = await this.#call("GET", "/v1/watches");
		if (answer.status !== 200) this.#refused(answer);
		return answer.json.watches as WatchView[];
	}

	/** True when an active watch was ended, false when there was none by that id or `owner/name#number`. */
	async cancel(idOrRef: string): Promise<boolean> {
		const answer = await this.#call("DELETE", `/v1/watches/${encodeURIComponent(idOrRef)}`);
		if (answer.status === 404) return false;
		if (answer.status !== 200) this.#refused(answer);
		return true;
	}
}

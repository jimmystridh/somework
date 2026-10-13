import { readFileSync } from "node:fs";
import { callHub } from "../hub-http.ts";

export interface TimerView {
	id: string;
	key: string;
	dueAt: string;
	note: string;
	payload?: unknown;
}

export interface TimerAsk {
	delaySeconds?: number;
	at?: string;
	key?: string;
	note: string;
	payload?: unknown;
}

/** What the hub said when it refused, or why it could not be asked; never carries the token. */
export class TimersError extends Error {
	override readonly name = "TimersError";
	readonly status?: number;
	constructor(message: string, status?: number) {
		super(message);
		this.status = status;
	}
}

export interface TimersClientOptions {
	/** Base address of the hub's listener, for example https://10.10.10.11:8091. */
	url: string;
	/** The agent's id, as listed in the hub's `timers.agents`. */
	agentId: string;
	token: () => string;
	caPem?: string;
	timeoutMs?: number;
}

export function readTimersToken(path: string): () => string {
	return () => {
		const token = readFileSync(path, "utf8").trim();
		if (token.length < 8) throw new TimersError("the timers token file is empty");
		return token;
	};
}

/** Asks the event hub for one-shot timers: "wake me with this note in 15 minutes". Only this agent's own timers can be listed or cancelled. */
export class TimersClient {
	readonly #base: URL;
	readonly #options: TimersClientOptions;

	constructor(options: TimersClientOptions) {
		this.#base = new URL(options.url);
		if (this.#base.protocol !== "https:" && this.#base.protocol !== "http:") throw new Error("the timers address must be http or https");
		this.#options = options;
	}

	#call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
		return callHub(this.#options, this.#base, method, path, body, (message, status) => new TimersError(message, status));
	}

	#refused(answer: { status: number; json: any }): never {
		throw new TimersError(typeof answer.json?.error === "string" ? answer.json.error.slice(0, 300) : `the hub answered ${answer.status}`, answer.status);
	}

	async request(ask: TimerAsk): Promise<TimerView> {
		const answer = await this.#call("POST", "/v1/timers", ask);
		if (answer.status !== 201) this.#refused(answer);
		return answer.json as TimerView;
	}

	async list(): Promise<TimerView[]> {
		const answer = await this.#call("GET", "/v1/timers");
		if (answer.status !== 200) this.#refused(answer);
		return answer.json.timers as TimerView[];
	}

	/** True when a pending timer was cancelled, false when there was none by that id or key. */
	async cancel(idOrKey: string): Promise<boolean> {
		const answer = await this.#call("DELETE", `/v1/timers/${encodeURIComponent(idOrKey)}`);
		if (answer.status === 404) return false;
		if (answer.status !== 200) this.#refused(answer);
		return true;
	}
}

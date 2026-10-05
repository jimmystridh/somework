import { pullToken } from "./derive.ts";
import { send, type HttpTarget } from "./http.ts";
import type { RawItem } from "./types.ts";

export interface PulledItem extends RawItem {
	seq: number;
}

export interface ReceiverStats {
	queued: number;
	lastSeq: number;
	oldestAgeSeconds: number;
}

export interface ReceiverApi {
	pull(after: number, limit: number, waitSeconds: number, signal?: AbortSignal): Promise<PulledItem[]>;
	ack(upTo: number): Promise<void>;
	stats(): Promise<ReceiverStats>;
	setPaused(source: string, paused: boolean): Promise<void>;
}

export class ReceiverClient implements ReceiverApi {
	readonly #target: HttpTarget;
	readonly #bearer: string;

	constructor(target: HttpTarget, secret: string) {
		this.#target = target;
		this.#bearer = `Bearer ${pullToken(secret)}`;
	}

	async #json(method: string, path: string, options: { body?: unknown; waitSeconds?: number; signal?: AbortSignal } = {}): Promise<any> {
		const response = await send(this.#target, {
			method,
			path,
			headers: { authorization: this.#bearer, ...(options.body === undefined ? {} : { "content-type": "application/json" }) },
			body: options.body === undefined ? undefined : JSON.stringify(options.body),
			timeoutMs: ((options.waitSeconds ?? 0) + 15) * 1000,
			signal: options.signal,
		});
		if (response.status !== 200) throw new Error(`receiver ${method} ${path.split("?")[0]} answered ${response.status}`);
		return JSON.parse(response.body.toString("utf8"));
	}

	async pull(after: number, limit: number, waitSeconds: number, signal?: AbortSignal): Promise<PulledItem[]> {
		const answer = await this.#json("GET", `v1/pull?after=${after}&limit=${limit}&wait=${waitSeconds}`, { waitSeconds, signal });
		return (answer.items as any[]).map((item) => ({ seq: item.seq, id: item.id, source: item.source, receivedAt: item.receivedAt, headers: item.headers, body: Buffer.from(item.bodyBase64, "base64"), path: item.path ?? "", query: item.query ?? "" }));
	}

	async ack(upTo: number): Promise<void> {
		await this.#json("POST", "v1/ack", { body: { upTo } });
	}

	async stats(): Promise<ReceiverStats> {
		return this.#json("GET", "v1/stats");
	}

	async setPaused(source: string, paused: boolean): Promise<void> {
		await this.#json("POST", `v1/sources/${encodeURIComponent(source)}/${paused ? "pause" : "resume"}`);
	}
}

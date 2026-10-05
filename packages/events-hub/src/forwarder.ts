import type { ForwardConfig } from "./config.ts";
import { send } from "./http.ts";
import { PermanentError, TransientError, type RawItem } from "./types.ts";

export interface Forwarder {
	forward(target: ForwardConfig, item: RawItem): Promise<void>;
}

/** Headers that describe the original delivery (and its signature) are replayed as received; the transport headers are not ours to copy. */
const REPLAY = /^(content-type|user-agent|x-hub-signature-256|x-github-.+|x-event-key|x-hook-.+)$/;

/** The replay target: the configured base, the path suffix the sender used, and the sender's own query string, byte for byte. */
export const forwardUrl = (target: ForwardConfig, item: Pick<RawItem, "path" | "query">): string => `${target.baseUrl}${item.path}${item.query ? `?${item.query}` : ""}`;

/** Replays a webhook byte for byte to a private URL (used so a code host can reach CI through the one public door). */
export class HttpForwarder implements Forwarder {
	async forward(target: ForwardConfig, item: RawItem): Promise<void> {
		const headers = Object.fromEntries(Object.entries(item.headers).filter(([name]) => REPLAY.test(name)));
		let status: number;
		try {
			status = (await send({ url: forwardUrl(target, item), ...(target.caFile ? { caFile: target.caFile } : {}) }, { method: "POST", headers, body: item.body, timeoutMs: 30_000 })).status;
		} catch (error) {
			throw new TransientError(`forward target unreachable: ${(error as Error).message.replace(item.query, "[query]")}`);
		}
		if (status >= 200 && status < 300) return;
		if (status === 408 || status === 429 || status >= 500) throw new TransientError(`forward target answered ${status}`);
		throw new PermanentError("forward", `forward target refused the webhook with ${status}`);
	}
}

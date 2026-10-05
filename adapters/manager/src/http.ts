import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

export interface CallOptions {
	method?: string;
	headers?: Record<string, string>;
	body?: unknown;
	caFile?: string;
	timeoutMs?: number;
	maxBytes?: number;
}

export interface CallResult {
	status: number;
	text: string;
}

const caCache = new Map<string, Buffer>();
const caOf = (file: string): Buffer => {
	let ca = caCache.get(file);
	if (!ca) {
		ca = readFileSync(file);
		caCache.set(file, ca);
	}
	return ca;
};

/** One small HTTP(S) call with an optional private CA, for the hub and the agents' health endpoints. Errors never carry headers or bodies. */
export function call(url: string, options: CallOptions = {}): Promise<CallResult> {
	const target = new URL(url);
	const secure = target.protocol === "https:";
	const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
	const maxBytes = options.maxBytes ?? 1_000_000;
	return new Promise((resolve, reject) => {
		const request = (secure ? httpsRequest : httpRequest)(
			target,
			{
				method: options.method ?? "GET",
				headers: { ...(payload === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }), ...options.headers },
				timeout: options.timeoutMs ?? 10_000,
				...(secure && options.caFile ? { ca: caOf(options.caFile) } : {}),
			},
			(response) => {
				const chunks: Buffer[] = [];
				let size = 0;
				response.on("data", (chunk: Buffer) => {
					size += chunk.length;
					if (size > maxBytes) return void request.destroy(new Error("response too large"));
					chunks.push(chunk);
				});
				response.on("end", () => resolve({ status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
			},
		);
		request.on("timeout", () => request.destroy(new Error("timed out")));
		request.on("error", (error) => reject(new Error(`request to ${target.host} failed: ${error.message}`)));
		if (payload !== undefined) request.write(payload);
		request.end();
	});
}

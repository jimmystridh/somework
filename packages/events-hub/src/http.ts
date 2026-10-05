import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

export interface HttpResult {
	status: number;
	headers: Record<string, string | string[] | undefined>;
	body: Buffer;
}

export interface HttpTarget {
	url: string;
	caFile?: string;
}

export function send(target: HttpTarget, options: { method: string; path?: string; headers?: Record<string, string>; body?: Uint8Array | string; timeoutMs: number; signal?: AbortSignal }): Promise<HttpResult> {
	return new Promise((resolve, reject) => {
		const url = options.path === undefined ? new URL(target.url) : new URL(options.path, target.url.endsWith("/") ? target.url : `${target.url}/`);
		const secure = url.protocol === "https:";
		const body = options.body === undefined ? undefined : Buffer.from(options.body);
		const req = (secure ? httpsRequest : httpRequest)(
			url,
			{
				method: options.method,
				headers: { ...(body ? { "content-length": String(body.length) } : {}), ...options.headers },
				...(secure && target.caFile ? { ca: readFileSync(target.caFile) } : {}),
				signal: options.signal,
			},
			(res) => {
				const chunks: Buffer[] = [];
				res.on("data", (chunk: Buffer) => chunks.push(chunk));
				res.on("error", reject);
				res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
			},
		);
		req.setTimeout(options.timeoutMs, () => req.destroy(new Error("request timed out")));
		req.on("error", reject);
		if (body) req.write(body);
		req.end();
	});
}

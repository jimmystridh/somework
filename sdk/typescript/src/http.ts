import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";

export interface HttpOptions {
	baseUrl: string;
	/** PEM bundle. When set, only this CA is trusted (a private CA), instead of the platform trust store. */
	caPem?: string;
	/** Refuse plain http. */
	requireTls?: boolean;
	timeoutMs?: number;
}

export interface HttpResponse {
	status: number;
	headers: IncomingHttpHeaders;
	body: string;
}

export interface HttpCall {
	method: string;
	path: string;
	headers?: Record<string, string>;
	body?: string | Uint8Array;
	signal?: AbortSignal;
	timeoutMs?: number;
}

/** A transport failure: connection refused, TLS verification failed, timeout, aborted. */
export class TransportError extends Error {
	override readonly name = "TransportError";
}

export function checkOptions(options: HttpOptions): void {
	const url = new URL(options.baseUrl);
	if (options.requireTls && url.protocol !== "https:") throw new Error(`TLS is required but ${options.baseUrl} is not https`);
}

export function httpCall(options: HttpOptions, call: HttpCall): Promise<HttpResponse> {
	return new Promise((resolve, reject) => {
		const url = new URL(call.path, options.baseUrl.endsWith("/") ? options.baseUrl : `${options.baseUrl}/`);
		const secure = url.protocol === "https:";
		const send = secure ? httpsRequest : httpRequest;
		const req = send(
			url,
			{
				method: call.method,
				headers: { ...(call.body === undefined ? {} : { "content-type": typeof call.body === "string" ? "application/json" : "application/octet-stream", "content-length": String(Buffer.byteLength(call.body)) }), ...call.headers },
				...(secure && options.caPem ? { ca: options.caPem } : {}),
				signal: call.signal,
			},
			(res) => {
				const chunks: Buffer[] = [];
				res.on("data", (chunk: Buffer) => chunks.push(chunk));
				res.on("error", (error) => reject(new TransportError(error.message)));
				res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
			},
		);
		req.setTimeout(call.timeoutMs ?? options.timeoutMs ?? 60_000, () => req.destroy(new Error("request timed out")));
		req.on("error", (error) => reject(new TransportError(error.message)));
		if (call.body !== undefined) req.write(call.body);
		req.end();
	});
}

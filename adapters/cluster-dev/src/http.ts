import { readFileSync } from "node:fs";
import https from "node:https";

export type Fetch = typeof fetch;

const NO_BODY = new Set([101, 204, 205, 304]);

/**
 * The `fetch` the host-side tools use: one request, no redirects followed, a time limit, and the private CA of the cluster when there is one
 * (`fetch` itself cannot take a CA). Tests inject their own `fetch` instead.
 */
export function createFetch(options: { caFile?: string; timeoutMs?: number } = {}): Fetch {
	const ca = options.caFile ? readFileSync(options.caFile, "utf8") : undefined;
	const timeoutMs = options.timeoutMs ?? 15_000;
	return (async (input: Parameters<Fetch>[0], init?: Parameters<Fetch>[1]) => {
		const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url);
		if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("only http and https addresses are read");
		if (!ca || url.protocol === "http:") return fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
		return await new Promise<Response>((resolve, reject) => {
			const headers = Object.fromEntries(new Headers(init?.headers).entries());
			const request = https.request(url, { method: init?.method ?? "GET", headers, ca }, (response) => {
				const chunks: Buffer[] = [];
				response.on("data", (chunk: Buffer) => chunks.push(chunk));
				response.on("error", reject);
				response.on("end", () => {
					const status = response.statusCode ?? 0;
					const responseHeaders = new Headers();
					for (const [name, value] of Object.entries(response.headers)) if (value !== undefined) responseHeaders.set(name, Array.isArray(value) ? value.join(", ") : value);
					resolve(new Response(NO_BODY.has(status) ? null : Buffer.concat(chunks), { status, headers: responseHeaders }));
				});
			});
			request.setTimeout(timeoutMs, () => {
				request.destroy(new Error("the server did not answer in time"));
			});
			request.on("error", reject);
			request.end();
		});
	}) as Fetch;
}

/** The body of a response as text, cut at `maxBytes` (so a huge answer costs no memory). */
export async function readText(response: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
	const reader = response.body?.getReader();
	if (!reader) return { text: "", truncated: false };
	const chunks: Uint8Array[] = [];
	let size = 0;
	let truncated = false;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.length;
		if (size > maxBytes) {
			chunks.push(value.slice(0, Math.max(0, value.length - (size - maxBytes))));
			truncated = true;
			await reader.cancel().catch(() => undefined);
			break;
		}
		chunks.push(value);
	}
	return { text: Buffer.concat(chunks).toString("utf8"), truncated };
}


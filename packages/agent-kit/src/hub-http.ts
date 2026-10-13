import http from "node:http";
import https from "node:https";

export interface HubCallOptions {
	/** Base address of the hub's listener, for example https://10.10.10.11:8091. */
	url: string;
	/** The agent's id; the hub checks the token against it. */
	agentId: string;
	token: () => string;
	caPem?: string;
	timeoutMs?: number;
}

/** One authenticated JSON call to the event hub's agent-facing API. `fail` builds the error of the caller's own kind (timers, watches), so no message carries the token. */
export async function callHub(options: HubCallOptions, base: URL, method: string, path: string, body: unknown, fail: (message: string, status?: number) => Error): Promise<{ status: number; json: any }> {
	const url = new URL(path, base);
	const payload = body === undefined ? undefined : JSON.stringify(body);
	const transport = url.protocol === "https:" ? https : http;
	return await new Promise((resolve, reject) => {
		const request = transport.request(
			url,
			{
				method,
				timeout: options.timeoutMs ?? 10_000,
				...(options.caPem ? { ca: options.caPem } : {}),
				headers: { authorization: `Bearer ${options.token()}`, "x-somework-agent": options.agentId, ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}) },
			},
			(response) => {
				const chunks: Buffer[] = [];
				let size = 0;
				response.on("data", (chunk: Buffer) => {
					size += chunk.length;
					if (size > 64 * 1024) return void request.destroy(fail("the hub's answer was too large"));
					chunks.push(chunk);
				});
				response.on("end", () => {
					try {
						resolve({ status: response.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") });
					} catch {
						reject(fail("the hub answered something that is not JSON", response.statusCode));
					}
				});
			},
		);
		request.on("timeout", () => request.destroy(fail("the hub did not answer in time")));
		request.on("error", (error) => reject(error instanceof (fail("").constructor as ErrorConstructor) ? error : fail(`the hub could not be reached (${(error as NodeJS.ErrnoException).code ?? "error"})`)));
		request.end(payload);
	});
}

import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { sleep } from "./backoff.ts";
import { checkOptions, httpCall, TransportError, type HttpOptions } from "./http.ts";
import { Identity, newRuntimeInstanceId } from "./identity.ts";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** An error answer from the domain (`code` is the platform problem code, e.g. `stale_fencing_token`) or a transport failure (status 0). */
export class SomeWorkError extends Error {
	override readonly name = "SomeWorkError";
	readonly status: number;
	readonly code: string;
	readonly details?: unknown;
	readonly traceId?: string;

	constructor(status: number, code: string, message: string, details?: unknown, traceId?: string) {
		super(`${status} ${code}: ${message}`);
		this.status = status;
		this.code = code;
		this.details = details;
		this.traceId = traceId;
	}

	/** Worth retrying: a transport failure, 429, or a gateway/availability error. */
	get retryable(): boolean {
		return this.status === 0 || [429, 502, 503, 504].includes(this.status);
	}
}

export interface Failure {
	code: string;
	message: string;
	retryable: boolean;
	details?: unknown;
}

export interface ClientOptions {
	baseUrl: string;
	identity: Identity;
	runtimeInstanceId?: string;
	/** PEM file of the private CA that signs the domain's certificate; only it is trusted. */
	caFile?: string;
	requireTls?: boolean;
	/** Retries of transport errors and 429/502/503/504 (mutations only with an idempotency key). */
	retries?: number;
	timeoutMs?: number;
}

const traceparent = (): string => `00-${randomBytes(16).toString("hex")}-${randomBytes(8).toString("hex")}-01`;
const segment = (value: string): string => encodeURIComponent(value);

/** Plain REST client of the domain. It holds the principal's identity and signs a fresh assertion per request. */
export class SomeWorkClient {
	readonly identity: Identity;
	readonly runtimeInstanceId: string;
	/** The TLS policy this client was configured with. The NATS wake transport applies the same one: the domain never dictates it. */
	readonly tls: { caPem?: string; requireTls: boolean };
	readonly #http: HttpOptions;
	readonly #retries: number;

	constructor(options: ClientOptions) {
		this.identity = options.identity;
		this.runtimeInstanceId = options.runtimeInstanceId ?? newRuntimeInstanceId();
		this.#http = {
			baseUrl: options.baseUrl,
			caPem: options.caFile ? readFileSync(options.caFile, "utf8") : undefined,
			requireTls: options.requireTls,
			timeoutMs: options.timeoutMs,
		};
		checkOptions(this.#http);
		this.tls = { caPem: this.#http.caPem, requireTls: options.requireTls === true };
		this.#retries = options.retries ?? 3;
	}

	async raw(method: string, path: string, options: { body?: unknown; idempotencyKey?: string; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<any> {
		const body = options.body === undefined ? undefined : JSON.stringify(options.body);
		for (let attempt = 0; ; attempt++) {
			const headers: Record<string, string> = {
				authorization: `Bearer ${this.identity.mintAssertion(this.runtimeInstanceId)}`,
				traceparent: traceparent(),
			};
			if (options.idempotencyKey) headers["idempotency-key"] = options.idempotencyKey;
			let outcome: { value: any } | { error: SomeWorkError };
			try {
				const response = await httpCall(this.#http, { method, path, headers, body, signal: options.signal, timeoutMs: options.timeoutMs });
				outcome = decode(response.status, response.body, response.headers["x-trace-id"]);
			} catch (error) {
				if (options.signal?.aborted) throw error;
				outcome = { error: new SomeWorkError(0, "unavailable", error instanceof TransportError ? error.message : String(error)) };
			}
			if ("value" in outcome) return outcome.value;
			const mayRetry = outcome.error.retryable && attempt < this.#retries && (options.idempotencyKey !== undefined || method === "GET" || outcome.error.status === 0);
			if (!mayRetry) throw outcome.error;
			await sleep(100 * 2 ** (attempt + 1), options.signal);
		}
	}

	get(path: string, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<any> {
		return this.raw("GET", path, options);
	}

	post(path: string, body: unknown, options?: { idempotencyKey?: string; signal?: AbortSignal }): Promise<any> {
		return this.raw("POST", path, { body, ...options });
	}

	// ---- runtimes ---------------------------------------------------------------------------------------------------
	registerRuntime(meta: Json = {}): Promise<any> {
		return this.post("/v1/runtimes", { runtimeInstanceId: this.runtimeInstanceId, meta });
	}

	runtimeHeartbeat(): Promise<any> {
		return this.post("/v1/runtimes/heartbeat", {});
	}

	endRuntime(): Promise<any> {
		return this.raw("DELETE", "/v1/runtimes/self");
	}

	// ---- artifacts --------------------------------------------------------------------------------------------------
	/** begin -> PUT the bytes with the grant -> complete (the domain verifies size and SHA-256). Returns the verified ArtifactRef. */
	async uploadArtifact(options: { filename: string; mediaType: string; classification?: string; bytes: Uint8Array | string; sourceTaskId?: string }): Promise<any> {
		const bytes = typeof options.bytes === "string" ? Buffer.from(options.bytes) : Buffer.from(options.bytes);
		const grant = await this.post("/v1/artifacts/uploads", {
			filename: options.filename,
			mediaType: options.mediaType,
			sizeBytes: bytes.length,
			sha256: createHash("sha256").update(bytes).digest("hex"),
			classification: options.classification ?? "internal",
			sourceTaskId: options.sourceTaskId,
		});
		const parts: { partNumber: number; etag: string }[] = [];
		const put = async (url: string, body: Buffer, headers: Record<string, string> = {}) => {
			const response = await httpCall(this.#http, { method: "PUT", path: url, headers, body });
			if (response.status < 200 || response.status >= 300) throw new SomeWorkError(response.status, "unavailable", `object upload failed: ${response.status}`);
			return String(response.headers.etag ?? "").replaceAll('"', "");
		};
		if (grant.multipart) {
			const partSize: number = grant.multipart.partSize ?? 5 * 1024 * 1024;
			for (const part of grant.multipart.parts ?? []) {
				const start = (part.partNumber - 1) * partSize;
				parts.push({ partNumber: part.partNumber, etag: await put(part.url, bytes.subarray(start, Math.min(start + partSize, bytes.length))) });
			}
		} else {
			await put(grant.url, bytes, grant.headers ?? {});
		}
		const done = await this.post(`/v1/artifacts/${segment(grant.artifactId)}/complete`, { version: grant.version ?? 1, parts });
		const { traceId: _trace, ...ref } = done;
		return ref;
	}

	// ---- tasks (requester side) -------------------------------------------------------------------------------------
	/** Answer a task that is waiting in `input_required`. */
	provideInput(taskId: string, data: unknown): Promise<any> {
		return this.post(`/v1/tasks/${segment(taskId)}/input`, { data });
	}

	conversationMessages(conversationId: string, limit = 200): Promise<any> {
		return this.get(`/v1/conversations/${segment(conversationId)}/messages?limit=${limit}`);
	}

	submitTask(request: unknown, idempotencyKey?: string): Promise<any> {
		return this.raw("POST", "/v1/tasks", { body: request, idempotencyKey });
	}

	getTask(taskId: string): Promise<any> {
		return this.get(`/v1/tasks/${segment(taskId)}`);
	}

	cancelTask(taskId: string, reason?: string): Promise<any> {
		return this.post(`/v1/tasks/${segment(taskId)}/cancel`, { reason });
	}

	/** Polls until the task is terminal or the timeout elapses. */
	async waitTerminal(taskId: string, timeoutMs: number): Promise<any> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const task = await this.getTask(taskId);
			if (TERMINAL_STATES.has(task.state) || Date.now() >= deadline) return task;
			await sleep(100);
		}
	}

	// ---- tasks (worker side) ----------------------------------------------------------------------------------------
	/** What the domain offers this principal for push wake-ups (`nats` block, absent when only HTTP is available). */
	connection(): Promise<any> {
		return this.get("/v1/connection");
	}

	/** Event feed after `cursor`. The SDK never holds it open (`waitSeconds` stays 0): push wake-ups come from NATS. */
	async events(after: number | undefined, waitSeconds = 0): Promise<{ events: any[]; cursor: number }> {
		const response = await this.get(after === undefined ? `/v1/events?wait=${waitSeconds}` : `/v1/events?after=${after}&wait=${waitSeconds}`, { timeoutMs: (waitSeconds + 30) * 1000 });
		return { events: response.events ?? [], cursor: response.cursor ?? after ?? 0 };
	}

	ackEvents(cursor: number): Promise<any> {
		return this.post("/v1/events/ack", { cursor });
	}

	/** Queued tasks this agent may claim. `waitSeconds` holds an empty lookup open on the server; the SDK's own loops always pass 0. */
	async nextTasks(waitSeconds = 0, signal?: AbortSignal): Promise<{ taskId: string; revision: number; capabilityId: string; capabilityVersion: string; attempt: number }[]> {
		const response = await this.get(`/v1/tasks/next?wait=${waitSeconds}`, { signal, timeoutMs: (waitSeconds + 30) * 1000 });
		return response.tasks ?? [];
	}

	claimTask(taskId: string, leaseSeconds?: number): Promise<any> {
		return this.post(`/v1/tasks/${segment(taskId)}/claim`, { leaseSeconds });
	}

	heartbeatTask(taskId: string, fencingToken: number, leaseSeconds?: number): Promise<any> {
		return this.post(`/v1/tasks/${segment(taskId)}/heartbeat`, { fencingToken, leaseSeconds });
	}

	progressTask(taskId: string, body: Record<string, unknown>): Promise<any> {
		return this.post(`/v1/tasks/${segment(taskId)}/progress`, body);
	}

	completeTask(taskId: string, fencingToken: number, result: unknown, artifacts: unknown[] = []): Promise<any> {
		return this.post(`/v1/tasks/${segment(taskId)}/complete`, { fencingToken, result, artifacts });
	}

	failTask(taskId: string, fencingToken: number, failure: Failure): Promise<any> {
		return this.post(`/v1/tasks/${segment(taskId)}/fail`, { fencingToken, failure });
	}

	ackCancel(taskId: string, fencingToken: number): Promise<any> {
		return this.post(`/v1/tasks/${segment(taskId)}/cancel`, { acknowledge: true, fencingToken });
	}
}

export const TERMINAL_STATES = new Set(["succeeded", "failed", "canceled", "rejected", "expired"]);

function decode(status: number, body: string, traceHeader: string | string[] | undefined): { value: any } | { error: SomeWorkError } {
	let value: any = null;
	if (body !== "") {
		try {
			value = JSON.parse(body);
		} catch {
			value = { raw: body };
		}
	}
	if (status >= 200 && status < 300) return { value };
	const traceId = (typeof traceHeader === "string" ? traceHeader : undefined) ?? value?.traceId;
	const code = typeof value?.code === "string" ? value.code : status === 401 ? "unauthenticated" : "internal";
	return { error: new SomeWorkError(status, code, value?.detail ?? "request failed", value?.details, traceId) };
}

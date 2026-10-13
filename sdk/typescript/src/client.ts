import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { sleep } from "./backoff.ts";
import { checkOptions, httpCall, TransportError, type HttpOptions } from "./http.ts";
import { parsePublishResult, parseRuleList, parseRuleView, validatePublish, validateRuleName, validateRuleSpec, type PublishEvent, type PublishResult, type RuleSpec, type RuleView } from "./events.ts";
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

	// ---- events and rules -------------------------------------------------------------------------------------------
	/** Publishes an event under a topic the caller's `events.publish:<prefix>` permission covers. A repeat of `key` answers `duplicate: true`. */
	async publishEvent(event: PublishEvent, options: { signal?: AbortSignal } = {}): Promise<PublishResult> {
		validatePublish(event);
		return parsePublishResult(await this.raw("POST", "/v1/events/publish", { body: event, idempotencyKey: `event:${event.topic}:${event.key}`.slice(0, 256), signal: options.signal }));
	}

	async listRules(): Promise<RuleView[]> {
		return parseRuleList(await this.get("/v1/rules"));
	}

	async getRule(name: string): Promise<RuleView> {
		return parseRuleView(await this.get(`/v1/rules/${segment(validateRuleName(name))}`));
	}

	/** Create or replace; idempotent. The rule's `owner` must be a principal the caller may define rules for (`rules.manage`). */
	async putRule(name: string, spec: RuleSpec): Promise<RuleView> {
		return parseRuleView(await this.raw("PUT", `/v1/rules/${segment(validateRuleName(name))}`, { body: validateRuleSpec(spec) }));
	}

	async deleteRule(name: string): Promise<void> {
		await this.raw("DELETE", `/v1/rules/${segment(validateRuleName(name))}`);
	}

	async pauseRule(name: string): Promise<RuleView> {
		return parseRuleView(await this.post(`/v1/rules/${segment(validateRuleName(name))}/pause`, {}));
	}

	async resumeRule(name: string): Promise<RuleView> {
		return parseRuleView(await this.post(`/v1/rules/${segment(validateRuleName(name))}/resume`, {}));
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
		});
		const parts: { partNumber: number; etag: string }[] = [];
		// putting the same bytes to the same grant again is harmless, so a connection that resets or an object store that answers 5xx is tried again before the upload fails
		const put = async (url: string, body: Buffer, headers: Record<string, string> = {}) => {
			for (let attempt = 0; ; attempt++) {
				let failure: unknown;
				let tryAgain = true;
				try {
					const response = await httpCall(this.#http, { method: "PUT", path: url, headers, body });
					if (response.status >= 200 && response.status < 300) return String(response.headers.etag ?? "").replaceAll('"', "");
					failure = new SomeWorkError(response.status, "unavailable", `object upload failed: ${response.status}`);
					tryAgain = response.status >= 500 || response.status === 429;
				} catch (error) {
					failure = error;
				}
				if (!tryAgain || attempt >= this.#retries) throw failure;
				await sleep(500 * 2 ** attempt);
			}
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

	/** The bytes of an artifact (the domain issues a short-lived grant first). */
	async downloadArtifact(ref: { artifactId: string; version?: number }, options: { maxBytes?: number } = {}): Promise<Buffer> {
		const grant = await this.post(`/v1/artifacts/${segment(ref.artifactId)}/${ref.version ?? 1}/download-grants`, {});
		const response = await httpCall(this.#http, { method: "GET", path: grant.url });
		if (response.status < 200 || response.status >= 300) throw new SomeWorkError(response.status, "unavailable", `object download failed: ${response.status}`);
		if (options.maxBytes !== undefined && response.bytes.length > options.maxBytes) throw new SomeWorkError(413, "validation_failed", `the artifact is larger than ${options.maxBytes} bytes`);
		return response.bytes;
	}

	// ---- conversations ----------------------------------------------------------------------------------------------
	conversationMessages(conversationId: string, limit = 200): Promise<any> {
		return this.get(`/v1/conversations/${segment(conversationId)}/messages?limit=${limit}`);
	}

	// ---- wakes ------------------------------------------------------------------------------------------------------
	/** What the domain offers this principal for push wake-ups (`nats` block, absent when only HTTP is available). */
	connection(): Promise<any> {
		return this.get("/v1/connection");
	}

	/** Event feed after `cursor`. The SDK never holds it open (`waitSeconds` stays 0): push wake-ups come from NATS. */
	async events(after: number | undefined, waitSeconds = 0, limit?: number): Promise<{ events: any[]; cursor: number }> {
		const page = limit === undefined ? "" : `&limit=${limit}`;
		const response = await this.get(after === undefined ? `/v1/events?wait=${waitSeconds}${page}` : `/v1/events?after=${after}&wait=${waitSeconds}${page}`, { timeoutMs: (waitSeconds + 30) * 1000 });
		return { events: response.events ?? [], cursor: response.cursor ?? after ?? 0 };
	}

	ackEvents(cursor: number): Promise<any> {
		return this.post("/v1/events/ack", { cursor });
	}
}

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

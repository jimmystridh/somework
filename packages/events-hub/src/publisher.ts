import { Identity, SomeWorkClient, SomeWorkError } from "@somework/sdk";
import type { MappedEvent, PublishResult } from "./types.ts";
import { PermanentError, TransientError } from "./types.ts";

export interface Publisher {
	publish(producer: string, event: MappedEvent, occurredAt: string): Promise<PublishResult>;
}

export interface PublisherOptions {
	domainUrl: string;
	caFile?: string;
	requireTls: boolean;
	/** producer name (a source name, or `clock`) -> its own key file */
	keyFiles: Record<string, string>;
}

/** Credentials being fixed (401) and an unavailable domain are worth waiting for; a refused event (400, 403, 409, 422) is not. */
export function classify(error: unknown): TransientError | PermanentError {
	if (error instanceof SomeWorkError) {
		const transient = error.status === 0 || error.status === 401 || error.status === 408 || error.status === 429 || error.status >= 500;
		return transient ? new TransientError(error.message) : new PermanentError("publish", error.message);
	}
	return new TransientError(String((error as Error)?.message ?? error));
}

/** Publishes through the domain as one principal per producer: a leaked source key can publish under its own prefix only. */
export class DomainPublisher implements Publisher {
	readonly #options: PublisherOptions;
	readonly #clients = new Map<string, SomeWorkClient>();

	constructor(options: PublisherOptions) {
		this.#options = options;
	}

	#client(producer: string): SomeWorkClient {
		let client = this.#clients.get(producer);
		if (!client) {
			const keyFile = this.#options.keyFiles[producer];
			if (!keyFile) throw new PermanentError("publish", `no producer key configured for ${producer}`);
			client = new SomeWorkClient({ baseUrl: this.#options.domainUrl, identity: Identity.fromFile(keyFile), caFile: this.#options.caFile, requireTls: this.#options.requireTls, retries: 0, timeoutMs: 30_000 });
			this.#clients.set(producer, client);
		}
		return client;
	}

	async publish(producer: string, event: MappedEvent, occurredAt: string): Promise<PublishResult> {
		const body = {
			topic: event.topic,
			key: event.key,
			source: producer,
			data: event.data,
			classification: event.classification,
			verified: true,
			occurredAt,
			...(event.causedByTask ? { causedByTask: event.causedByTask } : {}),
		};
		try {
			const answer = await this.#client(producer).post("/v1/events/publish", body);
			if (typeof answer?.seq !== "number" || typeof answer?.eventId !== "string") throw new PermanentError("publish", "the domain answered without seq and eventId");
			return { seq: answer.seq, eventId: answer.eventId, duplicate: answer.duplicate === true };
		} catch (error) {
			if (error instanceof PermanentError) throw error;
			throw classify(error);
		}
	}
}

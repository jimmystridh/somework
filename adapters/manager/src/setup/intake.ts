import type { DomainApi, InboundMessage } from "../domain.ts";
import { clip, scrub } from "../redact.ts";
import type { SetupApplier } from "./apply.ts";
import { isOperations, MAX_DOCUMENT_BYTES, parseLimits, parseOverride, SETUP_LABELS, SetupRejected, sha256Hex, type SetupKind } from "./contract.ts";
import type { SetupStore } from "./store.ts";

export interface SetupIntakeDeps {
	domain: DomainApi;
	applier: SetupApplier;
	store: SetupStore;
	log?: (event: string, fields?: Record<string, unknown>) => void;
}

/** True for every message that carries a setup label, whoever sent it: such a message is never a conversation and never reaches the owner or the model. */
export const isSetupMessage = (message: InboundMessage): boolean => message.labels?.[SETUP_LABELS.kind] !== undefined;

/**
 * Takes setup documents from the one principal that may send them (ADR 0004): checks the sender, downloads the artifact, verifies its SHA-256,
 * parses it, ignores a revision that is not newer than the applied one, applies it and acknowledges the outcome to the sender. A rejected
 * document leaves the earlier setup in place and is reported with its reason.
 */
export class SetupIntake {
	readonly #deps: SetupIntakeDeps;
	#queue: Promise<void> = Promise.resolve();

	constructor(deps: SetupIntakeDeps) {
		this.#deps = deps;
	}

	/** One message at a time, so a message the feed delivers twice meets the revision it just applied. */
	handle(message: InboundMessage): Promise<void> {
		const run = this.#queue.then(() => this.#handle(message));
		this.#queue = run.catch(() => {});
		return run;
	}

	async #handle(message: InboundMessage): Promise<void> {
		const log = this.#deps.log ?? (() => {});
		const sender = { kind: message.senderKind ?? "unknown", id: message.from };
		const domainId = this.#deps.domain.domainId;
		const foreign = domainId !== undefined && message.senderDomain !== undefined && message.senderDomain !== domainId;
		if (!isOperations(sender) || foreign) return log("setup_ignored", { reason: "sender is not operations of this domain", from: clip(message.from, 80), senderKind: clip(sender.kind, 20) });
		const kind = message.labels[SETUP_LABELS.kind];
		const revision = Number(message.labels[SETUP_LABELS.revision]);
		if (kind !== "override" && kind !== "limits") return log("setup_ignored", { reason: "unknown setup.kind", kind: clip(String(kind), 40) });
		if (!Number.isInteger(revision) || revision < 1) return log("setup_ignored", { reason: "setup.revision is not a revision number", kind });
		const { store } = this.#deps;
		const current = (kind === "override" ? store.status.override : store.status.limits)?.revision;
		if (current !== undefined && revision <= current) {
			const same = revision === current;
			return this.#acknowledge(message, kind, revision, same ? "applied" : "rejected", same ? `The ${kind} revision ${revision} is already applied.` : `The ${kind} revision ${revision} was not applied: revision ${current} is already applied.`);
		}
		try {
			await this.#applyDocument(message, kind, revision);
			log("setup_applied", { kind, revision });
			await this.#acknowledge(message, kind, revision, "applied", `Applied ${kind} revision ${revision}; it takes effect when Pi restarts, as soon as the current run is done.`);
		} catch (error) {
			const reason = error instanceof SetupRejected ? error.message : `could not apply the document: ${clip(scrub(error instanceof Error ? error.message : "error"), 300)}`;
			log("setup_rejected", { kind, revision, reason: clip(reason, 200) });
			await store.reject(kind, revision, reason).catch(() => {});
			await this.#acknowledge(message, kind, revision, "rejected", `Rejected ${kind} revision ${revision}: ${reason}`);
		}
	}

	async #applyDocument(message: InboundMessage, kind: SetupKind, revision: number): Promise<void> {
		const bytes = await this.#download(message);
		const expected = message.labels[SETUP_LABELS.sha256];
		if (!expected || !/^[0-9a-f]{64}$/.test(expected)) throw new SetupRejected("the message has no valid setup.sha256");
		if (sha256Hex(bytes) !== expected) throw new SetupRejected("the document does not match setup.sha256");
		let raw: any;
		try {
			raw = JSON.parse(bytes.toString("utf8"));
		} catch {
			throw new SetupRejected("the document is not valid JSON");
		}
		if (kind === "limits") {
			const limits = parseLimits(raw);
			if (limits.revision !== revision) throw new SetupRejected(`the document is revision ${limits.revision}, the message says ${revision}`);
			return this.#deps.applier.applyLimits(limits);
		}
		const override = parseOverride(raw, this.#agentNamed(raw?.agent));
		if (override.revision !== revision) throw new SetupRejected(`the document is revision ${override.revision}, the message says ${revision}`);
		await this.#deps.applier.apply(override);
	}

	/** The document may name the Manager by its domain id (`agent/manager`) or by its short name; anything else is parsed against the id and refused. */
	#agentNamed(named: unknown): string {
		const id = this.#deps.domain.selfId;
		return named === id || named === id.split("/").at(-1) ? (named as string) : id;
	}

	async #download(message: InboundMessage): Promise<Buffer> {
		const ref = (message.artifacts ?? []).find((artifact: any) => typeof artifact?.artifactId === "string" && (artifact.mediaType === undefined || artifact.mediaType === "application/json")) as { artifactId: string; version?: number } | undefined;
		if (!ref) throw new SetupRejected("the message carries no application/json artifact");
		try {
			return await this.#deps.domain.downloadArtifact({ artifactId: ref.artifactId, ...(typeof ref.version === "number" ? { version: ref.version } : {}) }, MAX_DOCUMENT_BYTES);
		} catch (error) {
			throw new SetupRejected(`the document could not be downloaded: ${clip(scrub(error instanceof Error ? error.message : "error"), 200)}`);
		}
	}

	async #acknowledge(message: InboundMessage, kind: SetupKind, revision: number, status: "applied" | "rejected", text: string): Promise<void> {
		try {
			await this.#deps.domain.sendMessage({
				to: message.from,
				recipientKind: message.senderKind ?? "service",
				type: "chat.notice",
				text: clip(text, 1000),
				...(message.conversationId ? { conversationId: message.conversationId } : {}),
				replyTo: message.messageId,
				triggerMode: "never",
				labels: { [SETUP_LABELS.ack]: String(revision), [SETUP_LABELS.status]: status, [SETUP_LABELS.kind]: kind },
				idempotencyKey: `setup-ack:${this.#deps.domain.selfId}:${kind}:${revision}:${status}`,
			});
		} catch (error) {
			this.#deps.log?.("setup_ack_failed", { kind, revision, error: clip(error instanceof Error ? error.message : "error", 160) });
		}
	}
}

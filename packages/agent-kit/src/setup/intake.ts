import type { SomeWorkClient } from "@somework/sdk";
import { redactText } from "../events/redact.ts";
import type { Log } from "../log.ts";
import type { InboundMessage } from "../threads/message.ts";
import { isOperations, MAX_DOCUMENT_BYTES, OPERATIONS_PRINCIPAL, parseLimits, parseOverride, SETUP_LABELS, SetupRejected, sha256Hex, type SetupKind } from "./contract.ts";
import type { Setup } from "./setup.ts";

export interface SetupIntakeOptions {
	agentId: string;
	/** The domain this agent belongs to: a sender record that names another domain is not Operations. */
	domainId?: string;
	client: Pick<SomeWorkClient, "downloadArtifact" | "post">;
	setup: Setup;
	log: Log;
}

interface ArtifactPointer {
	artifactId: string;
	version?: number;
	mediaType?: string;
	sizeBytes?: number;
}

function documentOf(message: InboundMessage): ArtifactPointer | undefined {
	for (const candidate of message.artifacts ?? []) {
		const ref = candidate as Record<string, unknown> | null;
		if (typeof ref?.artifactId !== "string") continue;
		return { artifactId: ref.artifactId, ...(typeof ref.version === "number" ? { version: ref.version } : {}), ...(typeof ref.mediaType === "string" ? { mediaType: ref.mediaType } : {}), ...(typeof ref.sizeBytes === "number" ? { sizeBytes: ref.sizeBytes } : {}) };
	}
	return undefined;
}

/**
 * Takes setup documents from the one principal that may send them (ADR 0004). A `setup.kind` message never becomes a conversation: from anyone but
 * `service:operations` it is ignored and logged; from Operations the document is downloaded, checked against its checksum and the contract, applied
 * (or refused, leaving the previous setup in place) and answered with an acknowledgement. A revision that is not newer than the applied one is acknowledged and ignored.
 * Returns true for every message that carries the label.
 */
export function createSetupIntercept(options: SetupIntakeOptions): (message: InboundMessage) => Promise<boolean> {
	const { setup, log } = options;

	const acknowledge = async (message: InboundMessage, kind: SetupKind, revision: number, status: "applied" | "rejected", text: string): Promise<void> => {
		try {
			await options.client.post(
				"/v1/messages",
				{
					type: "chat.notice",
					recipients: [{ kind: OPERATIONS_PRINCIPAL.kind, id: OPERATIONS_PRINCIPAL.id }],
					...(message.conversationId ? { conversationId: message.conversationId } : {}),
					replyTo: message.messageId,
					causationId: message.messageId,
					// the domain allows no other trigger mode for a notice: Operations reads the answer from its inbox and `/profile`
					triggerMode: "never",
					content: { mediaType: "text/plain", data: redactText(text).slice(0, 1000) },
					labels: { [SETUP_LABELS.kind]: kind, [SETUP_LABELS.ack]: String(revision), [SETUP_LABELS.status]: status },
				},
				{ idempotencyKey: `setup-ack:${options.agentId}:${kind}:${revision}` },
			);
		} catch (error) {
			log("warn", "setup_ack_failed", { kind, revision, error: error instanceof Error ? error.message : String(error) });
		}
	};

	const load = async (message: InboundMessage, kind: SetupKind, revision: number): Promise<void> => {
		const pointer = documentOf(message);
		if (!pointer) throw new SetupRejected("the message carries no document");
		if (pointer.mediaType && !pointer.mediaType.startsWith("application/json")) throw new SetupRejected("the document is not application/json");
		if (pointer.sizeBytes !== undefined && pointer.sizeBytes > MAX_DOCUMENT_BYTES) throw new SetupRejected(`the document is larger than ${MAX_DOCUMENT_BYTES} bytes`);
		let bytes: Buffer;
		try {
			bytes = await options.client.downloadArtifact({ artifactId: pointer.artifactId, ...(pointer.version ? { version: pointer.version } : {}) }, { maxBytes: MAX_DOCUMENT_BYTES });
		} catch (error) {
			throw new SetupRejected(`the document could not be downloaded: ${error instanceof Error ? error.message : "unknown error"}`);
		}
		const hash = sha256Hex(bytes);
		const announced = message.labels?.[SETUP_LABELS.sha256];
		if (!announced) throw new SetupRejected("the message names no checksum for the document");
		if (announced.toLowerCase() !== hash) throw new SetupRejected("the document does not match its checksum");
		let raw: unknown;
		try {
			raw = JSON.parse(bytes.toString("utf8"));
		} catch {
			throw new SetupRejected("the document is not valid JSON");
		}
		if (kind === "override") {
			const document = parseOverride(raw, options.agentId);
			if (document.revision !== revision) throw new SetupRejected("the document's revision is not the one the message names");
			await setup.applyOverride(document, hash);
		} else {
			const document = parseLimits(raw);
			if (document.revision !== revision) throw new SetupRejected("the document's revision is not the one the message names");
			await setup.applyLimits(document, hash);
		}
	};

	return async (message) => {
		const kind = message.labels?.[SETUP_LABELS.kind];
		if (kind === undefined) return false;
		const fromOperations = isOperations(message.sender) && (options.domainId === undefined || message.senderDomain === undefined || message.senderDomain === options.domainId);
		if (!fromOperations) {
			log("warn", "setup_ignored", { messageId: message.messageId, senderKind: message.sender.kind.slice(0, 20), sender: message.sender.id.slice(0, 80), reason: "setup comes only from the service operations" });
			return true;
		}
		const revision = Number(message.labels?.[SETUP_LABELS.revision]);
		if ((kind !== "override" && kind !== "limits") || !Number.isInteger(revision) || revision <= 0) {
			log("warn", "setup_ignored", { messageId: message.messageId, reason: "unknown kind or no valid revision" });
			return true;
		}
		const applied = setup.appliedRevision(kind);
		if (revision <= applied) {
			log("info", "setup_stale", { kind, revision, applied });
			await acknowledge(message, kind, revision, revision === applied ? "applied" : "rejected", revision === applied ? `The ${kind} revision ${revision} is already applied.` : `The ${kind} revision ${revision} was not applied: revision ${applied} is already applied.`);
			return true;
		}
		try {
			await load(message, kind, revision);
			log("info", "setup_applied", { kind, revision });
			await acknowledge(message, kind, revision, "applied", `Applied ${kind} revision ${revision}; it takes effect from the next model run.`);
		} catch (error) {
			const reason = error instanceof SetupRejected ? error.message : `the document could not be applied (${error instanceof Error ? error.message.slice(0, 160) : "unknown error"})`;
			setup.reject(kind, revision, reason);
			log("warn", "setup_rejected", { kind, revision, reason });
			await acknowledge(message, kind, revision, "rejected", `Rejected ${kind} revision ${revision}: ${reason}`);
		}
		return true;
	};
}

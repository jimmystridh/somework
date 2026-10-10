import { randomBytes } from "node:crypto";
import type { SomeWorkClient } from "@somework/sdk";
import type { Log } from "../log.ts";
import type { ApprovalDecision } from "../runtime.ts";
import { CHAT_APPROVAL_DECISION_LABEL, CHAT_APPROVAL_REQUEST_LABEL, CHAT_REPLY_LABEL, finishReply, type InboundMessage } from "./message.ts";
import type { Party } from "./jobs.ts";
import { senderMatches } from "./settings.ts";

interface Pending {
	id: string;
	senderId: string;
	conversationId?: string;
	resolve(decision: ApprovalDecision): void;
}

/** A chat channel outside the domain: a question to an approver who is on it goes there, and is answered there (`Approvals.decide`). */
export interface ApprovalChannel {
	/** True for a conversation the channel carries. */
	owns(conversationId: string | undefined): boolean;
	/** True for an approver the channel can reach (its principal ids). */
	reaches(approver: Party): boolean;
	say(conversationId: string, text: string): Promise<void>;
}

export interface ApprovalRequest {
	approver: Party;
	conversationId?: string;
	replyTo?: string;
	agent: string;
	tool: string;
	summary: string;
	signal: AbortSignal;
}

/**
 * Approval of a step, asked of one approver in the conversation. The question goes out as a message labelled `chatApprovalRequest=<id>`; only a
 * message from that same approver, labelled `chatApprovalDecision=<id>` and saying exactly `approve` or `deny`, decides. The id is random and only
 * ever sent to the approver. Text a model reads can never decide; silence is a denial.
 */
export class Approvals {
	readonly #pending = new Map<string, Pending>();
	readonly #client: Pick<SomeWorkClient, "post">;
	readonly #log: Log;
	readonly #timeoutMs: number;
	readonly #approvers: readonly string[];
	readonly #channel: ApprovalChannel | undefined;

	constructor(options: { client: Pick<SomeWorkClient, "post">; log: Log; timeoutMinutes: number; approvers: readonly string[]; channel?: ApprovalChannel }) {
		this.#channel = options.channel;
		this.#client = options.client;
		this.#log = options.log;
		this.#timeoutMs = options.timeoutMinutes * 60_000;
		this.#approvers = options.approvers;
	}

	get pending(): number {
		return this.#pending.size;
	}

	/** Who is asked about work that `requester` started: the requester when they may decide, else the first approver that names a principal. */
	approverFor(requester: Party): Party | undefined {
		if (senderMatches(this.#approvers, requester)) return requester;
		const named = this.#approvers.find((entry) => !entry.startsWith("kind:"));
		return named ? { kind: named.split("/")[0] ?? "agent", id: named } : undefined;
	}

	async ask(request: ApprovalRequest): Promise<ApprovalDecision> {
		const id = randomBytes(6).toString("hex");
		const local = request.conversationId !== undefined && this.#channel?.owns(request.conversationId) === true;
		const onChannel = local && this.#channel!.reaches(request.approver);
		const decided = new Promise<ApprovalDecision>((resolve) => {
			const done = (decision: ApprovalDecision): void => {
				clearTimeout(timer);
				this.#pending.delete(id);
				request.signal.removeEventListener("abort", stopped);
				resolve(decision);
			};
			const timer = setTimeout(() => done({ approved: false, reason: `nobody answered within ${Math.round(this.#timeoutMs / 60_000)} minutes` }), this.#timeoutMs);
			const stopped = (): void => done({ approved: false, reason: "the work was stopped" });
			request.signal.addEventListener("abort", stopped, { once: true });
			// an approver outside the channel answers in a conversation of its own: the domain does not know this one
			this.#pending.set(id, { id, senderId: request.approver.id, conversationId: local && !onChannel ? undefined : request.conversationId, resolve: done });
		});
		try {
			if (onChannel) {
				await this.#channel!.say(request.conversationId!, `Approval needed (${request.agent}): ${request.tool}: ${request.summary}\nAnswer /approve ${id} or /deny ${id}. Without an answer in ${Math.round(this.#timeoutMs / 60_000)} minutes it is denied.`);
				return await decided;
			}
			await this.#client.post(
				"/v1/messages",
				{
					type: "chat.message",
					recipients: [{ kind: request.approver.kind, id: request.approver.id }],
					...(request.conversationId && !local ? { conversationId: request.conversationId } : {}),
					...(request.replyTo ? { replyTo: request.replyTo } : {}),
					triggerMode: "directed",
					content: {
						mediaType: "text/plain",
						data: finishReply(`Approval needed (${request.agent}): ${request.tool}: ${request.summary}\nAnswer with label ${CHAT_APPROVAL_DECISION_LABEL}=${id} and the text "approve" or "deny". Without an answer in ${Math.round(this.#timeoutMs / 60_000)} minutes it is denied.`, 1500),
					},
					labels: { [CHAT_REPLY_LABEL]: "true", [CHAT_APPROVAL_REQUEST_LABEL]: id },
				},
				{ idempotencyKey: `chatapproval:${id}` },
			);
		} catch (error) {
			this.#pending.get(id)?.resolve({ approved: false, reason: "the approval question could not be sent" });
			this.#log("warn", "approval_send_failed", { error: String(error).slice(0, 160) });
		}
		return decided;
	}

	/** The answer of a person on a chat channel (`/approve <id>`, `/deny <id>`). Only the approver the question was asked of, in its conversation, decides. */
	decide(id: string, from: Party, conversationId: string, approved: boolean): "decided" | "unknown" | "rejected" {
		const pending = this.#pending.get(id);
		if (!pending) return "unknown";
		if (from.id !== pending.senderId || pending.conversationId !== conversationId) {
			this.#log("warn", "approval_rejected", { from: from.id, reason: "not the approver of this step" });
			return "rejected";
		}
		this.#log("info", "approval_decided", { from: from.id, approved });
		pending.resolve(approved ? { approved: true } : { approved: false, reason: "denied by the approver" });
		return "decided";
	}

	/** True when `message` was a decision for a pending request (valid or not for the question, it is consumed); false for anything else. */
	offer(message: InboundMessage): boolean {
		const id = message.labels?.[CHAT_APPROVAL_DECISION_LABEL];
		if (id === undefined) return false;
		const pending = this.#pending.get(id);
		if (!pending) {
			this.#log("info", "approval_unknown", { from: message.sender.id });
			return true;
		}
		const answer = (message.text ?? "").trim().toLowerCase();
		if (message.sender.id !== pending.senderId || !senderMatches(this.#approvers, message.sender) || (pending.conversationId && message.conversationId !== pending.conversationId)) {
			this.#log("warn", "approval_rejected", { from: message.sender.id, reason: "not the approver of this step" });
			return true;
		}
		if (answer !== "approve" && answer !== "deny") {
			this.#log("warn", "approval_unclear", { from: message.sender.id });
			return true;
		}
		this.#log("info", "approval_decided", { from: message.sender.id, approved: answer === "approve" });
		pending.resolve(answer === "approve" ? { approved: true } : { approved: false, reason: "denied by the approver" });
		return true;
	}
}

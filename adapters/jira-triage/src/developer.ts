import type { SomeWorkClient } from "@somework/sdk";

export interface DeveloperRequest {
	ticket: string;
	/** The same key is the same request: a retry never asks the developer twice. */
	key: string;
	text: string;
}

export interface DeveloperRequestSent {
	conversationId: string;
	/** The id of the request: the developer's answer names it in `replyTo`. Empty when the domain did not say. */
	messageId: string;
	sentAt: string;
}

/** What the agent remembers of a request, to find its answer: the conversation is shared by every ticket, so the request's own id and the ticket key tell the answers apart. */
export interface DeveloperAsked extends DeveloperRequestSent {
	ticket: string;
}

export interface DeveloperAnswer {
	text: string;
	at: string;
}

/** The developer agent as the triage sees it: a read-only question goes out as a message, the answer is read from the conversation. */
export interface DeveloperPort {
	ask(request: DeveloperRequest): Promise<DeveloperRequestSent>;
	answer(asked: DeveloperAsked): Promise<DeveloperAnswer | undefined>;
}

/** Labels the agents attach to messages that are not answers: a busy notice, an automatic reply. */
/** The domain's clock and this agent's need not agree: an answer that mentions the ticket within this much before the request still counts. */
const CLOCK_SKEW_MS = 5000;

const NOT_AN_ANSWER = ["chatNotice", "autoReply", "chatApprovalRequest", "chatApprovalDecision"];

/**
 * The developer agent over the domain's messages. The request is a plain `chat.message` (trigger mode `directed`) that states what it may not do;
 * this role holds no permission beyond what any agent of the domain has (`message.send`, `message.read`), and asks for no job and no write.
 */
export function developerOverDomain(client: Pick<SomeWorkClient, "post" | "conversationMessages">, developerId: string): DeveloperPort {
	return {
		async ask(request) {
			const sentAt = new Date().toISOString();
			const sent = await client.post(
				"/v1/messages",
				{
					type: "chat.message",
					recipients: [{ kind: "agent", id: developerId }],
					triggerMode: "directed",
					content: { mediaType: "text/plain", data: request.text },
					labels: { jiraTriage: request.ticket },
				},
				{ idempotencyKey: `jira-triage:developer:${request.key}` },
			);
			const conversationId = sent?.conversationId;
			if (typeof conversationId !== "string" || conversationId === "") throw new Error("the domain did not say which conversation the request went to");
			return { conversationId, messageId: typeof sent?.messageId === "string" ? sent.messageId : "", sentAt };
		},
		async answer(asked) {
			const body = await client.conversationMessages(asked.conversationId, 200);
			const records: any[] = Array.isArray(body?.messages) ? body.messages : [];
			const since = Date.parse(asked.sentAt) - CLOCK_SKEW_MS;
			const mentions = new RegExp(`\\b${asked.ticket.replace(/[^A-Za-z0-9_-]/g, "")}\\b`);
			const candidates = records
				.filter((record) => record?.type === "chat.message" && record?.sender?.id === developerId && typeof record?.content?.data === "string" && record.content.data.trim() !== "" && !NOT_AN_ANSWER.some((label) => record.labels?.[label] !== undefined))
				.filter((record) => {
					const answersUs = asked.messageId !== "" && (record.replyTo === asked.messageId || record.causationId === asked.messageId);
					return answersUs || (Date.parse(record.createdAt ?? "") >= since && mentions.test(record.content.data));
				})
				.sort((a, b) => Date.parse(a.createdAt ?? "") - Date.parse(b.createdAt ?? ""));
			const first = candidates[0];
			return first ? { text: String(first.content.data).slice(0, 8000), at: String(first.createdAt ?? "") } : undefined;
		},
	};
}

import type { SomeWorkClient } from "@somework/sdk";

export interface InboundMessage {
	messageId: string;
	from: string;
	text: string;
	type: string;
	conversationId?: string;
	taskId?: string;
}

/** What the Manager needs from the domain; implemented over the plain REST client so tests can run against a real domain. */
export interface DomainApi {
	readonly selfId: string;
	searchCatalog(query: string, limit: number): Promise<any>;
	listEntries(): Promise<any>;
	capability(id: string, version: string): Promise<any>;
	submitTask(request: Record<string, unknown>, idempotencyKey: string): Promise<any>;
	getTask(taskId: string): Promise<any>;
	cancelTask(taskId: string, reason: string): Promise<any>;
	provideInput(taskId: string, data: unknown): Promise<any>;
	sendMessage(message: { to: string; text: string; conversationId?: string }): Promise<any>;
	unreadMessages(limit: number): Promise<InboundMessage[]>;
	conversationMessages(conversationId: string, limit: number): Promise<InboundMessage[]>;
	markRead(messageIds: string[]): Promise<void>;
}

const segment = encodeURIComponent;

export function textOf(content: any): string {
	const data = content?.data;
	return typeof data === "string" ? data : JSON.stringify(data ?? "");
}

export function inbound(record: any): InboundMessage {
	return {
		messageId: record.messageId,
		from: record.sender?.id ?? "unknown",
		text: textOf(record.content),
		type: record.type ?? "chat.message",
		conversationId: record.conversationId,
		taskId: record.taskId,
	};
}

export class RestDomain implements DomainApi {
	readonly #client: SomeWorkClient;

	constructor(client: SomeWorkClient) {
		this.#client = client;
	}

	get selfId(): string {
		return this.#client.identity.agentId;
	}

	searchCatalog(query: string, limit: number): Promise<any> {
		return this.#client.post("/v1/catalog/search", { query, limit });
	}

	listEntries(): Promise<any> {
		return this.#client.get("/v1/catalog/entries");
	}

	capability(id: string, version: string): Promise<any> {
		return this.#client.get(`/v1/capabilities/${segment(id)}/${segment(version)}`);
	}

	submitTask(request: Record<string, unknown>, idempotencyKey: string): Promise<any> {
		return this.#client.submitTask(request, idempotencyKey);
	}

	getTask(taskId: string): Promise<any> {
		return this.#client.getTask(taskId);
	}

	cancelTask(taskId: string, reason: string): Promise<any> {
		return this.#client.cancelTask(taskId, reason);
	}

	provideInput(taskId: string, data: unknown): Promise<any> {
		return this.#client.provideInput(taskId, data);
	}

	sendMessage(message: { to: string; text: string; conversationId?: string }): Promise<any> {
		return this.#client.post("/v1/messages", {
			recipients: [{ kind: "agent", id: message.to }],
			content: { mediaType: "text/plain", data: message.text },
			conversationId: message.conversationId,
			triggerMode: "directed",
		});
	}

	async unreadMessages(limit: number): Promise<InboundMessage[]> {
		const response = await this.#client.get(`/v1/inbox?unread=true&limit=${limit}`);
		return (response.messages ?? []).map(inbound);
	}

	async conversationMessages(conversationId: string, limit: number): Promise<InboundMessage[]> {
		const response = await this.#client.conversationMessages(conversationId, limit);
		return (response.messages ?? []).map(inbound);
	}

	async markRead(messageIds: string[]): Promise<void> {
		if (messageIds.length > 0) await this.#client.post("/v1/messages/read", { messageIds });
	}
}

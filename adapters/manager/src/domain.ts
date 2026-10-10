import type { SomeWorkClient } from "@somework/sdk";

export interface InboundMessage {
	messageId: string;
	from: string;
	text: string;
	type: string;
	conversationId?: string;
	labels: Record<string, string>;
}

export interface RuleSummary {
	name: string;
	description: string;
	owner: string;
	selector: string;
	wake: boolean;
	status: string;
	lastFiredAt: string | null;
	counters: { fired: number; skipped: Record<string, number> };
}

export interface Subscription {
	kind: string;
	selector: string;
	wakeOnMatch?: boolean;
}

export interface FeedEvent {
	seq: number;
	eventId: string;
	type: string;
	payload: Record<string, any>;
	wake?: boolean;
}

/** What the Manager needs from the domain; implemented over the plain REST client so tests can run against a real domain. */
export interface DomainApi {
	readonly selfId: string;
	searchCatalog(query: string, limit: number): Promise<any>;
	listEntries(): Promise<any>;
	capability(id: string, version: string): Promise<any>;
	sendMessage(message: { to: string; text: string; conversationId?: string; labels?: Record<string, string> }): Promise<any>;
	unreadMessages(limit: number): Promise<InboundMessage[]>;
	conversationMessages(conversationId: string, limit: number): Promise<InboundMessage[]>;
	markRead(messageIds: string[]): Promise<void>;
	listRules(): Promise<RuleSummary[]>;
	pauseRule(name: string): Promise<RuleSummary>;
	resumeRule(name: string): Promise<RuleSummary>;
	events(after: number | undefined): Promise<{ events: FeedEvent[]; cursor: number }>;
	ackEvents(cursor: number): Promise<void>;
	listSubscriptions(): Promise<Subscription[]>;
	subscribeToTopic(selector: string, wakeOnMatch: boolean): Promise<void>;
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
		labels: record.labels && typeof record.labels === "object" ? record.labels : {},
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

	sendMessage(message: { to: string; text: string; conversationId?: string; labels?: Record<string, string> }): Promise<any> {
		return this.#client.post("/v1/messages", {
			recipients: [{ kind: "agent", id: message.to }],
			content: { mediaType: "text/plain", data: message.text },
			conversationId: message.conversationId,
			triggerMode: "directed",
			...(message.labels ? { labels: message.labels } : {}),
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

	async listRules(): Promise<RuleSummary[]> {
		return (await this.#client.listRules()) as unknown as RuleSummary[];
	}

	async pauseRule(name: string): Promise<RuleSummary> {
		return (await this.#client.pauseRule(name)) as unknown as RuleSummary;
	}

	async resumeRule(name: string): Promise<RuleSummary> {
		return (await this.#client.resumeRule(name)) as unknown as RuleSummary;
	}

	events(after: number | undefined): Promise<{ events: FeedEvent[]; cursor: number }> {
		return this.#client.events(after, 0);
	}

	async ackEvents(cursor: number): Promise<void> {
		await this.#client.ackEvents(cursor);
	}

	async listSubscriptions(): Promise<Subscription[]> {
		const response = await this.#client.get("/v1/subscriptions");
		return response.subscriptions ?? [];
	}

	async subscribeToTopic(selector: string, wakeOnMatch: boolean): Promise<void> {
		await this.#client.post("/v1/subscriptions", { kind: "topic", selector, wakeOnMatch });
	}
}

import type { SomeWorkClient } from "@somework/sdk";

export interface InboundMessage {
	messageId: string;
	from: string;
	/** `agent`, `service`, `human`: the kind of the sender's principal. */
	senderKind?: string;
	/** The domain the sender belongs to, when the record names one. */
	senderDomain?: string;
	text: string;
	type: string;
	conversationId?: string;
	labels: Record<string, string>;
	/** References to the artifacts attached to the message. */
	artifacts?: unknown[];
}

export interface OutgoingMessage {
	to: string;
	/** Kind of the recipient's principal; `agent` unless said otherwise. */
	recipientKind?: string;
	text: string;
	conversationId?: string;
	labels?: Record<string, string>;
	/** Default `chat.message`. */
	type?: string;
	triggerMode?: "directed" | "never";
	replyTo?: string;
	/** The same key sends the message once, however often it is tried. */
	idempotencyKey?: string;
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
	/** The id of the domain this Manager belongs to; a sender from another domain is not Operations. */
	readonly domainId?: string;
	searchCatalog(query: string, limit: number): Promise<any>;
	listEntries(): Promise<any>;
	capability(id: string, version: string): Promise<any>;
	sendMessage(message: OutgoingMessage): Promise<any>;
	downloadArtifact(ref: { artifactId: string; version?: number }, maxBytes: number): Promise<Buffer>;
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
		...(typeof record.sender?.kind === "string" ? { senderKind: record.sender.kind } : {}),
		...(typeof record.sender?.domainId === "string" ? { senderDomain: record.sender.domainId } : {}),
		text: textOf(record.content),
		type: record.type ?? "chat.message",
		conversationId: record.conversationId,
		labels: record.labels && typeof record.labels === "object" ? record.labels : {},
		...(Array.isArray(record.artifacts) && record.artifacts.length > 0 ? { artifacts: record.artifacts } : {}),
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

	get domainId(): string {
		return this.#client.identity.audience.replace(/^somework:/, "");
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

	sendMessage(message: OutgoingMessage): Promise<any> {
		return this.#client.post(
			"/v1/messages",
			{
				...(message.type ? { type: message.type } : {}),
				recipients: [{ kind: message.recipientKind ?? "agent", id: message.to }],
				content: { mediaType: "text/plain", data: message.text },
				conversationId: message.conversationId,
				...(message.replyTo ? { replyTo: message.replyTo, causationId: message.replyTo } : {}),
				triggerMode: message.triggerMode ?? "directed",
				...(message.labels ? { labels: message.labels } : {}),
			},
			message.idempotencyKey ? { idempotencyKey: message.idempotencyKey } : undefined,
		);
	}

	downloadArtifact(ref: { artifactId: string; version?: number }, maxBytes: number): Promise<Buffer> {
		return this.#client.downloadArtifact(ref, { maxBytes });
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

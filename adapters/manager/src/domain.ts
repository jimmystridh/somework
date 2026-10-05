import type { SomeWorkClient } from "@somework/sdk";

export interface InboundMessage {
	messageId: string;
	from: string;
	text: string;
	type: string;
	conversationId?: string;
	taskId?: string;
	labels: Record<string, string>;
}

export interface DomainApproval {
	approvalId: string;
	taskId: string;
	taskRevision: number;
	actionDigest: string;
	action: string;
	requestedBy: string;
	status: string;
	decision?: string | null;
	approvedBy?: string | null;
	expiresAt: string;
	createdAt?: string;
}

export interface ApprovalDecision {
	decision: "approved" | "denied";
	actionDigest: string;
	taskRevision: number;
	comment?: string;
}

export interface RuleSummary {
	name: string;
	description: string;
	owner: string;
	selector: string;
	wake: boolean;
	status: string;
	reaction?: { capability?: { id: string; version: string | number }; budget?: { maxTokens: number; maxMinutes: number }; input?: unknown } | null;
	lastFiredAt: string | null;
	counters: { fired: number; skipped: Record<string, number> };
}

export interface RuleFiring {
	rule: string;
	eventId: string;
	status: string;
	reason?: string | null;
	taskId?: string | null;
	approvalId?: string | null;
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
	submitTask(request: Record<string, unknown>, idempotencyKey: string): Promise<any>;
	getTask(taskId: string): Promise<any>;
	cancelTask(taskId: string, reason: string): Promise<any>;
	provideInput(taskId: string, data: unknown): Promise<any>;
	sendMessage(message: { to: string; text: string; conversationId?: string; labels?: Record<string, string> }): Promise<any>;
	unreadMessages(limit: number): Promise<InboundMessage[]>;
	conversationMessages(conversationId: string, limit: number): Promise<InboundMessage[]>;
	markRead(messageIds: string[]): Promise<void>;
	listApprovals(status?: string): Promise<DomainApproval[]>;
	getApproval(approvalId: string): Promise<DomainApproval>;
	decideApproval(approvalId: string, decision: ApprovalDecision): Promise<any>;
	listRules(): Promise<RuleSummary[]>;
	pauseRule(name: string): Promise<RuleSummary>;
	resumeRule(name: string): Promise<RuleSummary>;
	ruleFirings(name: string, limit: number): Promise<RuleFiring[]>;
	events(after: number | undefined): Promise<{ events: FeedEvent[]; cursor: number }>;
	ackEvents(cursor: number): Promise<void>;
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

	async listApprovals(status?: string): Promise<DomainApproval[]> {
		const response = await this.#client.get(`/v1/approvals${status ? `?status=${segment(status)}` : ""}`);
		return response.approvals ?? [];
	}

	getApproval(approvalId: string): Promise<DomainApproval> {
		return this.#client.get(`/v1/approvals/${segment(approvalId)}`);
	}

	decideApproval(approvalId: string, decision: ApprovalDecision): Promise<any> {
		return this.#client.post(`/v1/approvals/${segment(approvalId)}/decision`, decision);
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

	async ruleFirings(name: string, limit: number): Promise<RuleFiring[]> {
		const response = await this.#client.get(`/v1/rules/${segment(name)}/firings?limit=${limit}`);
		return response.firings ?? [];
	}

	events(after: number | undefined): Promise<{ events: FeedEvent[]; cursor: number }> {
		return this.#client.events(after, 0);
	}

	async ackEvents(cursor: number): Promise<void> {
		await this.#client.ackEvents(cursor);
	}
}

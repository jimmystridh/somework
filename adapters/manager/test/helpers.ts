import { createHash } from "node:crypto";
import { SomeWorkError } from "@somework/sdk";
import type { ApprovalDecision, DomainApi, DomainApproval, FeedEvent, InboundMessage, RuleFiring, RuleSummary } from "../src/domain.ts";
import type { PiRpc } from "../src/rpc.ts";

export const code = "a".repeat(32);
export const now = Date.now();

export const pairingState = () => ({
	pairingHash: createHash("sha256").update(code).digest("hex"),
	pairingCreatedAt: now,
	pairingExpiresAt: now + 60_000,
});

export const message = (text = "hello", id = 42, extra: Record<string, unknown> = {}) => ({
	from: { id, is_bot: false },
	chat: { id, type: "private" },
	text,
	date: Math.floor(now / 1000),
	...extra,
});

export interface Sent {
	method: string;
	data: any;
}

/** A Telegram API that records what the bridge sends and numbers the messages it "delivers". */
export function recordingApi() {
	const sent: Sent[] = [];
	let next = 100;
	const api = async (method: string, data: any = {}) => {
		sent.push({ method, data });
		return method === "sendMessage" ? { message_id: next++ } : {};
	};
	const texts = () => sent.filter((s) => s.method === "sendMessage").map((s) => s.data.text as string);
	return { api, sent, texts };
}

export function stubRpc(state: Record<string, unknown> = { isStreaming: false, model: { provider: "openai-codex", id: "gpt-5.5" }, thinkingLevel: "low" }) {
	const calls: { type: string; fields?: any }[] = [];
	const rpc: PiRpc = {
		onEvent: () => {},
		onTelemetryEvent: () => {},
		command: async (type, fields) => {
			calls.push({ type, fields });
			return state;
		},
	};
	return { rpc, calls };
}

export interface FakeCapability {
	sideEffects: string;
	description?: string;
}

/** A domain that remembers what was asked of it, so tests can assert that nothing reached it before an approval. */
export class FakeDomain implements DomainApi {
	selfId = "agent/manager";
	capabilities: Record<string, FakeCapability> = { "code.review@2": { sideEffects: "read" }, "code.agent@1": { sideEffects: "write" } };
	submitted: { request: any; key: string }[] = [];
	tasks: Record<string, any> = {};
	inputs: { taskId: string; data: unknown }[] = [];
	canceled: string[] = [];
	sentMessages: any[] = [];
	unread: InboundMessage[] = [];
	read: string[] = [];
	approvals: DomainApproval[] = [];
	decisions: { approvalId: string; decision: ApprovalDecision }[] = [];
	decideError: Error | undefined;
	rules: RuleSummary[] = [];
	firings: Record<string, RuleFiring[]> = {};
	rulesPaused: string[] = [];
	rulesResumed: string[] = [];
	feed: FeedEvent[] = [];
	acked: number[] = [];

	async searchCatalog(_query: string) {
		return { matches: [{ agentId: "agent/reviewer", availability: "online", matchedCapabilities: [{ id: "code.review", version: "2" }] }] };
	}

	async listEntries() {
		return { entries: [{ entryId: "e1", availability: { state: "online" }, agentCard: { agentId: "agent/reviewer", capabilities: [{ id: "code.review", version: "2" }] } }] };
	}

	async capability(id: string, version: string) {
		const found = this.capabilities[`${id}@${version}`];
		if (!found) throw new SomeWorkError(404, "not_found", "no such capability");
		return { id, version, ...found };
	}

	async submitTask(request: any, key: string) {
		const taskId = `task_${this.submitted.length + 1}`;
		this.submitted.push({ request, key });
		this.tasks[taskId] = { taskId, state: "queued" };
		return { taskId, state: "queued" };
	}

	async getTask(taskId: string) {
		return this.tasks[taskId];
	}

	async cancelTask(taskId: string) {
		this.canceled.push(taskId);
		return { taskId, state: "cancel_requested" };
	}

	async provideInput(taskId: string, data: unknown) {
		this.inputs.push({ taskId, data });
		return {};
	}

	async sendMessage(message: any) {
		this.sentMessages.push(message);
		return { messageId: "msg_1" };
	}

	async unreadMessages() {
		return this.unread;
	}

	async conversationMessages() {
		return this.unread;
	}

	async markRead(ids: string[]) {
		this.read.push(...ids);
	}

	async listApprovals(status?: string) {
		return this.approvals.filter((a) => !status || a.status === status);
	}

	async getApproval(id: string) {
		const found = this.approvals.find((a) => a.approvalId === id);
		if (!found) throw new SomeWorkError(404, "not_found", "no such approval");
		return found;
	}

	async decideApproval(approvalId: string, decision: ApprovalDecision) {
		if (this.decideError) throw this.decideError;
		this.decisions.push({ approvalId, decision });
		const found = this.approvals.find((a) => a.approvalId === approvalId)!;
		found.status = decision.decision;
		return { taskId: found.taskId };
	}

	async listRules() {
		return this.rules;
	}

	async pauseRule(name: string) {
		const rule = this.rules.find((r) => r.name === name);
		if (!rule) throw new SomeWorkError(404, "not_found", "no such rule");
		this.rulesPaused.push(name);
		rule.status = "paused";
		return rule;
	}

	async resumeRule(name: string) {
		const rule = this.rules.find((r) => r.name === name);
		if (!rule) throw new SomeWorkError(404, "not_found", "no such rule");
		this.rulesResumed.push(name);
		rule.status = "active";
		return rule;
	}

	async ruleFirings(name: string) {
		return this.firings[name] ?? [];
	}

	async events(after: number | undefined) {
		const events = this.feed.filter((e) => e.seq > (after ?? 0));
		return { events, cursor: events.at(-1)?.seq ?? after ?? 0 };
	}

	async ackEvents(cursor: number) {
		this.acked.push(cursor);
	}
}

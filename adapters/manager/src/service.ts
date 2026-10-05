import { randomUUID } from "node:crypto";
import { SomeWorkError, sleep } from "@somework/sdk";
import { ApprovalQueue, type Approval } from "./approvals.ts";
import type { DomainApi, InboundMessage } from "./domain.ts";
import type { TaskTracker } from "./notifier.ts";
import { PolicyError, RateLimiter, runsWithoutApproval, withBudget, type PolicyConfig } from "./policy.ts";
import { summarizeInput } from "./redact.ts";
import { TERMINAL } from "./state.ts";

/** How the Manager reaches its owner. The Telegram bridge implements it; it returns the id of the message it sent. */
export interface Owner {
	tell(text: string): Promise<number | undefined>;
}

export type SubmitOutcome =
	| { status: "submitted"; taskId: string; state: string }
	| { status: "awaiting_approval"; approvalId: string; expiresAt: string; note: string };

export interface SubmitRequest {
	capability: { id: string; version: string };
	input?: Record<string, unknown>;
	targetAgentId?: string;
}

export interface ServiceDeps {
	domain: DomainApi;
	policy: PolicyConfig;
	owner: Owner;
	tracker: TaskTracker;
	approvals?: ApprovalQueue;
	now?: () => number;
}

const MAX_MESSAGE_CHARS = 8000;

const sideEffectsOf = (capability: any): string | undefined => capability?.sideEffects ?? capability?.definition?.sideEffects ?? capability?.capability?.sideEffects;

function compactTask(view: any): Record<string, unknown> {
	const question = view.blocker?.question ?? view.pendingInput;
	return {
		taskId: view.taskId,
		state: view.state,
		capability: view.capability,
		...(view.result === undefined ? {} : { result: view.result }),
		...(view.failure ? { failure: view.failure } : {}),
		...(question === undefined ? {} : { question }),
		...(view.resultArtifacts?.length ? { artifacts: view.resultArtifacts.map((a: any) => ({ artifactId: a.artifactId, filename: a.filename })) } : {}),
	};
}

/**
 * Everything the Manager may do on the domain, with the rules applied here rather than in a prompt: what needs the owner's
 * approval, how large a budget may be, how often it may submit. The gateway (for Pi) and the Telegram commands (for the owner)
 * are two front doors to this one class.
 */
export class ManagerService {
	readonly approvals: ApprovalQueue;
	readonly #domain: DomainApi;
	readonly #policy: PolicyConfig;
	readonly #owner: Owner;
	readonly #tracker: TaskTracker;
	readonly #submissions: RateLimiter;
	readonly #messages: RateLimiter;

	constructor(deps: ServiceDeps) {
		this.#domain = deps.domain;
		this.#policy = deps.policy;
		this.#owner = deps.owner;
		this.#tracker = deps.tracker;
		this.approvals = deps.approvals ?? new ApprovalQueue(deps.policy.approvalTtlMs, deps.now);
		this.#submissions = new RateLimiter(deps.policy.submissionsPerHour, 3_600_000, deps.now);
		this.#messages = new RateLimiter(deps.policy.messagesPerHour, 3_600_000, deps.now);
	}

	// ---- reading --------------------------------------------------------------------------------------------------
	async catalog(query: string): Promise<unknown> {
		const found = await this.#domain.searchCatalog(query, 10);
		const results = [];
		for (const match of found.matches ?? []) {
			for (const ref of match.matchedCapabilities ?? []) {
				const capability = await this.#domain.capability(ref.id, ref.version).catch(() => undefined);
				results.push({
					agentId: match.agentId,
					availability: match.availability,
					capability: { id: ref.id, version: ref.version, description: capability?.description, sideEffects: sideEffectsOf(capability) ?? "unknown", inputSchema: capability?.inputSchema ?? capability?.definition?.inputSchema },
				});
			}
		}
		return { results };
	}

	async agents(): Promise<{ agentId: string; capabilities: string[]; availability?: string }[]> {
		const response = await this.#domain.listEntries();
		return (response.entries ?? []).map((entry: any) => ({
			agentId: entry.agentCard?.agentId ?? entry.agentId,
			availability: typeof entry.availability === "string" ? entry.availability : entry.availability?.state,
			capabilities: (entry.agentCard?.capabilities ?? []).map((c: any) => `${c.id}@${c.version}`),
		}));
	}

	/** A submitted task by id, or the outcome of an approval by its id. `waitSeconds` is bounded and only polls the domain briefly. */
	async task(id: string, waitSeconds = 0): Promise<unknown> {
		if (/^a[0-9a-f]{8}$/.test(id)) return this.#approvalStatus(id);
		const deadline = Date.now() + Math.min(Math.max(waitSeconds, 0), 30) * 1000;
		for (;;) {
			const view = await this.#domain.getTask(id);
			if (TERMINAL.has(view.state) || view.state === "input_required" || Date.now() >= deadline) return compactTask(view);
			await sleep(1000);
		}
	}

	#approvalStatus(id: string): unknown {
		const approval = this.approvals.get(id);
		if (!approval) throw new PolicyError(404, "unknown_approval", "no such approval (it may have expired long ago or the Manager restarted); submit again");
		return { approvalId: approval.id, status: approval.status, ...(approval.taskId ? { taskId: approval.taskId } : {}) };
	}

	async inbox(options: { conversationId?: string; limit?: number }): Promise<{ messages: InboundMessage[] }> {
		const limit = Math.min(options.limit ?? 20, 50);
		const messages = options.conversationId ? await this.#domain.conversationMessages(options.conversationId, limit) : await this.#domain.unreadMessages(limit);
		return { messages: messages.map((m) => ({ ...m, text: m.text.slice(0, MAX_MESSAGE_CHARS) })) };
	}

	// ---- acting ---------------------------------------------------------------------------------------------------
	async submit(request: SubmitRequest): Promise<SubmitOutcome> {
		const { id, version } = request.capability;
		if (!id || !version) throw new PolicyError(400, "invalid_request", "capability.id and capability.version are required (take them from the catalog)");
		const input = withBudget(id, request.input ?? {}, this.#policy);
		const capability = await this.#domain.capability(id, version).catch((error) => {
			throw new PolicyError(error instanceof SomeWorkError && error.status === 404 ? 404 : 502, "unknown_capability", `capability ${id}@${version} could not be resolved`);
		});
		const sideEffects = sideEffectsOf(capability);
		if (!this.#submissions.take()) throw new PolicyError(429, "rate_limited", "submission limit for this hour reached");
		if (runsWithoutApproval(sideEffects)) return this.#submit({ capability: { id, version }, input, targetAgentId: request.targetAgentId });
		const approval = this.approvals.create({
			capability: { id, version },
			targetAgentId: request.targetAgentId,
			sideEffects: sideEffects ?? "unknown",
			input,
			summary: summarizeInput(input),
		});
		const budget = (input.budget as { maxTokens: number; maxMinutes: number } | undefined) ?? undefined;
		await this.#owner
			.tell(
				[
					`Approval ${approval.id} needed (expires in ${Math.round(this.#policy.approvalTtlMs / 60_000)} min)`,
					`Capability: ${id} v${version} (side effects: ${approval.sideEffects})`,
					...(request.targetAgentId ? [`To: ${request.targetAgentId}`] : []),
					...(budget ? [`Budget: ${budget.maxTokens} tokens, ${budget.maxMinutes} min`] : []),
					"Input:",
					approval.summary,
					`Reply /approve ${approval.id} or /deny ${approval.id}`,
				].join("\n"),
			)
			.catch(() => {
				approval.status = "denied";
				throw new PolicyError(503, "owner_unreachable", "the owner could not be asked, so nothing was submitted");
			});
		return {
			status: "awaiting_approval",
			approvalId: approval.id,
			expiresAt: new Date(approval.expiresAt).toISOString(),
			note: "The owner has been asked on Telegram. Nothing runs until they approve. Tell them what you asked for; check later with somework_task using the approvalId.",
		};
	}

	async #submit(request: { capability: { id: string; version: string }; input: Record<string, unknown>; targetAgentId?: string }): Promise<SubmitOutcome> {
		const submitted = await this.#domain.submitTask(
			{ capability: request.capability, input: request.input, ...(request.targetAgentId ? { targetAgentId: request.targetAgentId } : {}) },
			`manager-${randomUUID()}`,
		);
		await this.#tracker.track({
			taskId: submitted.taskId,
			capability: `${request.capability.id}@${request.capability.version}`,
			targetAgentId: request.targetAgentId,
			submittedAt: new Date().toISOString(),
			state: submitted.state ?? "submitted",
		});
		return { status: "submitted", taskId: submitted.taskId, state: submitted.state };
	}

	/** The owner's decision (from Telegram only). Approving submits exactly what was shown. */
	async approve(id: string): Promise<{ ok: boolean; message: string }> {
		const approval = this.approvals.decide(id, true);
		if (!approval) return { ok: false, message: this.#whyNotDecidable(id) };
		const outcome = await this.#submit({ capability: approval.capability, input: approval.input, targetAgentId: approval.targetAgentId });
		if (outcome.status === "submitted") approval.taskId = outcome.taskId;
		return { ok: true, message: `Approved ${id}: submitted task ${(outcome as { taskId: string }).taskId}` };
	}

	deny(id: string): { ok: boolean; message: string } {
		const approval = this.approvals.decide(id, false);
		return approval ? { ok: true, message: `Denied ${id}. Nothing was submitted.` } : { ok: false, message: this.#whyNotDecidable(id) };
	}

	#whyNotDecidable(id: string): string {
		const approval = this.approvals.get(id);
		return approval ? `Approval ${id} is already ${approval.status}.` : `No pending approval ${id}.`;
	}

	pending(): Approval[] {
		return this.approvals.pending();
	}

	/** Called on a timer: owners hear about approvals that ran out. */
	async announceExpired(): Promise<void> {
		for (const approval of this.approvals.expireOverdue()) {
			await this.#owner.tell(`Approval ${approval.id} for ${approval.capability.id} expired. Nothing was submitted.`).catch(() => {});
		}
	}

	async cancel(taskId: string, reason = "canceled by the Manager"): Promise<unknown> {
		if (!this.#tracker.get(taskId)) throw new PolicyError(403, "not_submitted_here", "only tasks this Manager submitted can be canceled");
		return compactTask(await this.#domain.cancelTask(taskId, reason));
	}

	async answer(taskId: string, data: unknown): Promise<void> {
		if (!this.#tracker.get(taskId)) throw new PolicyError(403, "not_submitted_here", "only tasks this Manager submitted can be answered");
		await this.#domain.provideInput(taskId, data);
	}

	async message(request: { to: string; text: string; conversationId?: string }): Promise<unknown> {
		if (!request.to || !request.text) throw new PolicyError(400, "invalid_request", "to and text are required");
		if (request.text.length > MAX_MESSAGE_CHARS) throw new PolicyError(413, "message_too_long", `messages are limited to ${MAX_MESSAGE_CHARS} characters`);
		if (!this.#messages.take()) throw new PolicyError(429, "rate_limited", "message limit for this hour reached");
		const sent = await this.#domain.sendMessage(request);
		return { messageId: sent.messageId, conversationId: sent.conversationId };
	}
}

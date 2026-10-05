import { randomBytes } from "node:crypto";

export interface ApprovalRequest {
	capability: { id: string; version: string };
	targetAgentId?: string;
	sideEffects: string;
	input: Record<string, unknown>;
	summary: string;
}

export type ApprovalStatus = "pending" | "approved" | "denied" | "expired";

export interface Approval extends ApprovalRequest {
	id: string;
	createdAt: number;
	expiresAt: number;
	status: ApprovalStatus;
	taskId?: string;
}

const REMEMBER_DECIDED_MS = 3_600_000;

/** Approvals live in memory only: a restart forgets them, which means "denied". Only the owner's Telegram command decides. */
export class ApprovalQueue {
	readonly #ttlMs: number;
	readonly #now: () => number;
	readonly #items = new Map<string, Approval>();
	#newlyExpired: Approval[] = [];

	constructor(ttlMs: number, now: () => number = Date.now) {
		this.#ttlMs = ttlMs;
		this.#now = now;
	}

	create(request: ApprovalRequest): Approval {
		const now = this.#now();
		const approval: Approval = { ...request, id: `a${randomBytes(4).toString("hex")}`, createdAt: now, expiresAt: now + this.#ttlMs, status: "pending" };
		this.#items.set(approval.id, approval);
		return approval;
	}

	get(id: string): Approval | undefined {
		this.#expire();
		return this.#items.get(id);
	}

	/** Moves a pending approval to approved/denied. Anything that is not pending (unknown, expired, already decided) returns undefined. */
	decide(id: string, approve: boolean): Approval | undefined {
		const approval = this.get(id);
		if (approval?.status !== "pending") return undefined;
		approval.status = approve ? "approved" : "denied";
		return approval;
	}

	pending(): Approval[] {
		this.#expire();
		return [...this.#items.values()].filter((approval) => approval.status === "pending");
	}

	/** Marks overdue approvals expired and returns the ones that just became so (the owner is told once). */
	expireOverdue(): Approval[] {
		this.#expire();
		const expired = this.#newlyExpired;
		this.#newlyExpired = [];
		return expired;
	}

	#expire(): void {
		const now = this.#now();
		for (const [id, approval] of this.#items) {
			if (approval.status === "pending" && now >= approval.expiresAt) {
				approval.status = "expired";
				this.#newlyExpired.push(approval);
			}
			if (approval.status !== "pending" && now - approval.expiresAt > REMEMBER_DECIDED_MS) this.#items.delete(id);
		}
	}
}

import { SomeWorkError } from "@somework/sdk";
import type { DomainApi, DomainApproval, RuleSummary } from "./domain.ts";
import { clip, defang, summarizeInput } from "./redact.ts";
import type { AnnouncedApproval, ManagerState, SaveState } from "./state.ts";

/** How the Manager reaches its owner. `markup` is a Telegram reply markup (inline buttons). */
export interface ApprovalChannel {
	tell(text: string, markup?: unknown): Promise<number | undefined>;
}

export const DOMAIN_APPROVAL_ID = /^appr_[A-Za-z0-9_-]{1,60}$/;

const KEEP = 100;
const MAX_RULE_LOOKUPS = 20;

export const approvalButtons = (id: string) => ({
	inline_keyboard: [[{ text: "Approve", callback_data: `ap:y:${id}` }, { text: "Deny", callback_data: `ap:n:${id}` }]],
});

interface Context {
	capability: string;
	sideEffects?: string;
	rule?: string;
	selector?: string;
	eventId?: string;
	depth?: number;
	budget?: { maxTokens: number; maxMinutes: number };
	inputLines?: string;
	inputNote?: string;
}

const budgetOf = (value: unknown): Context["budget"] => {
	const budget = value as { maxTokens?: unknown; maxMinutes?: unknown } | undefined;
	return typeof budget?.maxTokens === "number" && typeof budget?.maxMinutes === "number" ? { maxTokens: budget.maxTokens, maxMinutes: budget.maxMinutes } : undefined;
};

/** A standing decision of the owner: this action, started by this rule's reaction, is approved without asking again. */
export interface AutoApproval {
	action: string;
	rule: string;
}

/** `qa.verify@1=qa-on-ticket,other@1=other-rule`: a capability and the rule whose reaction starts it, plain names only, so a typo cannot widen what is approved. */
export function parseAutoApprovals(text: string | undefined): AutoApproval[] {
	if (text === undefined || text.trim() === "") return [];
	return text.split(",").map((entry) => {
		const match = /^\s*([a-z][a-z0-9._-]{0,60}@[A-Za-z0-9._-]{1,20})\s*=\s*([a-z][a-z0-9-]{0,60})\s*$/.exec(entry);
		if (!match) throw new Error(`MANAGER_AUTO_APPROVE: "${entry.trim().slice(0, 60)}" is not <capability>@<version>=<rule name>`);
		return { action: match[1]!, rule: match[2]! };
	});
}

export interface ReactionApprovalDeps {
	domain: DomainApi;
	/** The owner's standing approvals: matching approvals are decided here, with the same digest and revision checks, and not announced. */
	autoApprove?: readonly AutoApproval[];
	/** While everything is suspended nothing is approved, standing decisions included. */
	isSuspended?: () => boolean;
	owner: ApprovalChannel;
	state: ManagerState;
	save: SaveState;
	now?: () => number;
	log?: (event: string, fields?: Record<string, unknown>) => void;
}

/**
 * The owner as the decision channel for approvals the domain asks for: write-class tasks that reactions submit wait for a structured
 * approval bound to the task's action digest and revision. This class only relays: it shows what the domain says is being approved,
 * and sends the owner's answer back with the digest and revision it read, so the domain's own checks (expiry, revision, requester
 * not approving their own task) stay the authority. Event text never enters the prompt except through `defang`.
 */
export class ReactionApprovals {
	readonly #deps: ReactionApprovalDeps;
	readonly #now: () => number;
	#polling = false;

	constructor(deps: ReactionApprovalDeps) {
		this.#deps = deps;
		this.#now = deps.now ?? Date.now;
	}

	get #known(): Record<string, AnnouncedApproval> {
		return (this.#deps.state.reactionApprovals ??= {});
	}

	/** Tells the owner about new pending approvals once, and about the outcome of announced ones that ended without the owner. */
	async poll(): Promise<void> {
		if (this.#polling) return;
		this.#polling = true;
		try {
			const pending = await this.#deps.domain.listApprovals("pending");
			const rules = new RuleBook(this.#deps.domain);
			for (const approval of pending) {
				if (this.#known[approval.approvalId]) continue;
				if (await this.#autoApprove(approval)) continue;
				const text = await this.#describe(approval, rules);
				const messageId = await this.#deps.owner.tell(text, approvalButtons(approval.approvalId));
				this.#known[approval.approvalId] = { announcedAt: new Date(this.#now()).toISOString(), status: "pending", ...(messageId === undefined ? {} : { messageId }) };
				await this.#deps.save(this.#deps.state);
			}
			const stillPending = new Set(pending.map((a) => a.approvalId));
			for (const [id, known] of Object.entries(this.#known)) {
				if (known.status !== "pending" || stillPending.has(id)) continue;
				const approval = await this.#deps.domain.getApproval(id).catch(() => undefined);
				if (!approval || approval.status === "pending") continue;
				known.status = approval.status;
				if (!known.reported) {
					known.reported = true;
					await this.#deps.owner.tell(`Approval ${id} (${approval.action}) ended: ${approval.status}${approval.approvedBy ? ` by ${defang(approval.approvedBy)}` : ""}. Nothing more to decide.`).catch(() => {});
				}
				await this.#deps.save(this.#deps.state);
			}
			this.#prune();
		} finally {
			this.#polling = false;
		}
	}

	/** True when a standing approval of the owner decided it. A refusal by the domain leaves the approval to the owner, as any other. */
	async #autoApprove(approval: DomainApproval): Promise<boolean> {
		const candidates = this.#deps.autoApprove?.filter((entry) => entry.action === approval.action) ?? [];
		if (candidates.length === 0 || this.#deps.isSuspended?.()) return false;
		if (Date.parse(approval.expiresAt) <= this.#now()) return false;
		// the domain records which rule's reaction started a task; a task nobody can show the origin of is left to the owner
		const origin = (await this.#deps.domain.getTask(approval.taskId).catch(() => undefined))?.origin;
		const rule = origin?.kind === "reaction" ? candidates.find((entry) => entry.rule === origin.rule) : undefined;
		if (!rule) return false;
		try {
			await this.#deps.domain.decideApproval(approval.approvalId, {
				decision: "approved",
				actionDigest: approval.actionDigest,
				taskRevision: approval.taskRevision,
				comment: `approved by the owner's standing rule for ${rule.action} from the rule ${rule.rule}`,
			});
		} catch (error) {
			this.#deps.log?.("approval_auto_refused", { approvalId: approval.approvalId, error: this.#why(error) });
			return false;
		}
		this.#known[approval.approvalId] = { announcedAt: new Date(this.#now()).toISOString(), status: "approved", reported: true };
		await this.#deps.save(this.#deps.state);
		this.#deps.log?.("approval_auto_approved", { approvalId: approval.approvalId, action: approval.action, rule: rule.rule });
		return true;
	}

	async pending(): Promise<DomainApproval[]> {
		return this.#deps.domain.listApprovals("pending");
	}

	/** The owner's decision. The digest and revision are read from the domain at decision time, so the domain checks they are still current. */
	async decide(id: string, approve: boolean): Promise<{ ok: boolean; message: string }> {
		if (!DOMAIN_APPROVAL_ID.test(id)) return { ok: false, message: `No approval ${clip(defang(id), 60)}.` };
		let approval: DomainApproval;
		try {
			approval = await this.#deps.domain.getApproval(id);
		} catch (error) {
			return { ok: false, message: error instanceof SomeWorkError && error.status === 404 ? `No approval ${id}.` : `Could not read approval ${id}: ${this.#why(error)}` };
		}
		if (approval.status !== "pending") return { ok: false, message: `Approval ${id} is already ${approval.status}.` };
		if (Date.parse(approval.expiresAt) <= this.#now()) return { ok: false, message: `Approval ${id} has expired. Nothing was started.` };
		try {
			await this.#deps.domain.decideApproval(id, {
				decision: approve ? "approved" : "denied",
				actionDigest: approval.actionDigest,
				taskRevision: approval.taskRevision,
				comment: "decided by the owner in Telegram",
			});
		} catch (error) {
			return { ok: false, message: `The domain refused the decision on ${id}: ${this.#why(error)}` };
		}
		const known = (this.#known[id] ??= { announcedAt: new Date(this.#now()).toISOString(), status: "pending" });
		known.status = approve ? "approved" : "denied";
		known.reported = true;
		await this.#deps.save(this.#deps.state);
		return { ok: true, message: approve ? `Approved ${id} (${approval.action}). The task is queued.` : `Denied ${id}. The task was rejected.` };
	}

	#why(error: unknown): string {
		return clip(defang(error instanceof Error ? error.message : "error"), 240);
	}

	#prune(): void {
		const ids = Object.keys(this.#known);
		if (ids.length <= KEEP) return;
		const finished = ids.filter((id) => this.#known[id]!.status !== "pending").sort((a, b) => this.#known[a]!.announcedAt.localeCompare(this.#known[b]!.announcedAt));
		for (const id of finished.slice(0, ids.length - KEEP)) delete this.#known[id];
	}

	async #describe(approval: DomainApproval, rules: RuleBook): Promise<string> {
		const context = await this.#context(approval, rules);
		const minutes = Math.max(0, Math.round((Date.parse(approval.expiresAt) - this.#now()) / 60_000));
		return [
			`Approval ${approval.approvalId} needed (expires in ${minutes} min)`,
			`Capability: ${defang(context.capability)}${context.sideEffects ? ` (side effects: ${defang(context.sideEffects)})` : ""}`,
			...(context.rule ? [`Rule: ${defang(context.rule)}${context.selector ? `, fires on ${defang(context.selector)}` : ""}`] : []),
			...(context.eventId ? [`Event: ${defang(context.eventId)}${context.depth === undefined ? "" : `, depth ${context.depth}`}`] : []),
			`Requested by: ${defang(approval.requestedBy)}`,
			...(context.budget ? [`Budget: ${context.budget.maxTokens} tokens, ${context.budget.maxMinutes} min`] : []),
			context.inputLines ? `Input:\n${context.inputLines}` : (context.inputNote ?? "Input: not visible to the Manager"),
			`Decide with the buttons, or /approve ${approval.approvalId} or /deny ${approval.approvalId}`,
		].join("\n");
	}

	async #context(approval: DomainApproval, rules: RuleBook): Promise<Context> {
		const context: Context = { capability: approval.action };
		const task = await this.#deps.domain.getTask(approval.taskId).catch(() => undefined);
		if (task) {
			context.sideEffects = task.sideEffects ?? task.constraints?.sideEffects;
			context.budget = budgetOf(task.input?.budget);
			if (task.input && typeof task.input === "object") context.inputLines = summarizeInput(task.input);
			const origin = task.origin;
			if (origin?.rule) context.rule = String(origin.rule);
			if (origin?.eventId) context.eventId = String(origin.eventId);
			if (typeof origin?.depth === "number") context.depth = origin.depth;
		}
		if (!context.rule) {
			const found = await rules.firingFor(approval.approvalId).catch(() => undefined);
			if (found) {
				context.rule = found.rule.name;
				context.eventId ??= found.eventId;
			}
		}
		const rule = context.rule ? await rules.get(context.rule).catch(() => undefined) : undefined;
		if (rule) {
			context.selector = rule.selector;
			context.budget ??= budgetOf(rule.reaction?.budget);
			if (!context.inputLines && rule.reaction?.input !== undefined) {
				context.inputNote = `Input (the rule's template, values filled in from the event):\n${summarizeInput(rule.reaction.input)}`;
			}
		}
		return context;
	}
}

/** The few rule lookups an approval prompt needs, cached for one poll. */
class RuleBook {
	readonly #domain: DomainApi;
	#rules: Promise<RuleSummary[]> | undefined;

	constructor(domain: DomainApi) {
		this.#domain = domain;
	}

	#all(): Promise<RuleSummary[]> {
		return (this.#rules ??= this.#domain.listRules());
	}

	async get(name: string): Promise<RuleSummary | undefined> {
		return (await this.#all()).find((rule) => rule.name === name);
	}

	async firingFor(approvalId: string): Promise<{ rule: RuleSummary; eventId: string } | undefined> {
		const reactions = (await this.#all()).filter((rule) => rule.reaction).slice(0, MAX_RULE_LOOKUPS);
		for (const rule of reactions) {
			const hit = (await this.#domain.ruleFirings(rule.name, 50)).find((firing) => firing.approvalId === approvalId);
			if (hit) return { rule, eventId: hit.eventId };
		}
		return undefined;
	}
}

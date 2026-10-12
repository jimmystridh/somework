import type { ChatSessions } from "./chat.ts";
import type { DomainApi, InboundMessage } from "./domain.ts";
import { CONTROL_REQUEST_ID, ControlRequests, describeAction, parseAction, type ControlAction, type Controls } from "./controls.ts";
import { callKey, PolicyError, RateLimiter, type ApprovalGrants, type ApprovalRules, type PolicyConfig, type ToolCall } from "./policy.ts";
import { clip, defang } from "./redact.ts";
import { SETUP_LABELS } from "./setup/contract.ts";

/** How the Manager reaches its owner. The Telegram bridge implements it; it returns the id of the message it sent. */
export interface Owner {
	/** `markup` is a Telegram reply markup (inline buttons). */
	tell(text: string, markup?: unknown): Promise<number | undefined>;
}

export const controlButtons = (id: string) => ({
	inline_keyboard: [[{ text: "Confirm", callback_data: `ct:y:${id}` }, { text: "Cancel", callback_data: `ct:n:${id}` }]],
});

export interface ServiceDeps {
	domain: DomainApi;
	policy: PolicyConfig;
	owner: Owner;
	controls?: Controls;
	/** The owner's chats with agents (`/ask`). */
	chats?: ChatSessions;
	/** The tool calls of the model that need the owner (Operations replaces the rules at run time), and the one-use permissions the owner gave. */
	approvals?: { rules: ApprovalRules; grants: ApprovalGrants };
	now?: () => number;
}

const MAX_MESSAGE_CHARS = 8000;
const MAX_CALL_CHARS = 100_000;

function parseCall(raw: Record<string, unknown>): ToolCall {
	const bad = (message: string): never => {
		throw new PolicyError(400, "invalid_request", message);
	};
	if (raw.kind === "bash") return typeof raw.command === "string" && raw.command.length <= MAX_CALL_CHARS ? { kind: "bash", command: raw.command } : bad("command must be text");
	if (raw.kind === "mcp") {
		const input = typeof raw.input === "string" && raw.input.length <= MAX_CALL_CHARS ? raw.input : bad("input must be the call's arguments as text");
		return typeof raw.tool === "string" && /^mcp__[A-Za-z0-9_]{1,200}$/.test(raw.tool) ? { kind: "mcp", tool: raw.tool, input, readOnly: raw.readOnly === true } : bad("tool must be an MCP tool name");
	}
	return bad("kind must be bash or mcp");
}

/**
 * Everything the Manager may do on the domain, with the rules applied here rather than in a prompt: what needs the owner's
 * confirmation, how often it may write to agents. The gateway (for Pi) and the Telegram commands (for the owner) are two front
 * doors to this one class. The Manager talks to agents the way anyone does: in messages. An agent decides for itself what to do with one.
 */
export class ManagerService {
	readonly controls: Controls | undefined;
	readonly chats: ChatSessions | undefined;
	readonly controlRequests: ControlRequests | undefined;
	readonly #domain: DomainApi;
	readonly #policy: PolicyConfig;
	readonly #owner: Owner;
	readonly #messages: RateLimiter;
	readonly #approvals: ServiceDeps["approvals"];
	readonly #askedAbout = new Map<string, string>();

	constructor(deps: ServiceDeps) {
		this.#domain = deps.domain;
		this.#policy = deps.policy;
		this.#owner = deps.owner;
		this.controls = deps.controls;
		this.chats = deps.chats;
		this.controlRequests = deps.controls ? new ControlRequests(deps.controls, deps.policy.approvalTtlMs, deps.now) : undefined;
		this.#messages = new RateLimiter(deps.policy.messagesPerHour, 3_600_000, deps.now);
		this.#approvals = deps.approvals;
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
					capability: { id: ref.id, version: ref.version, description: capability?.description, inputSchema: capability?.inputSchema ?? capability?.definition?.inputSchema },
				});
			}
		}
		return { results: highestVersionFirst(results) };
	}

	async agents(): Promise<{ agentId: string; capabilities: string[]; availability?: string }[]> {
		const response = await this.#domain.listEntries();
		return (response.entries ?? []).map((entry: any) => ({
			agentId: entry.agentCard?.agentId ?? entry.agentId,
			availability: typeof entry.availability === "string" ? entry.availability : entry.availability?.state,
			capabilities: (entry.agentCard?.capabilities ?? []).map((c: any) => `${c.id}@${c.version}`),
		}));
	}

	async inbox(options: { conversationId?: string; limit?: number }): Promise<{ messages: InboundMessage[] }> {
		const limit = Math.min(options.limit ?? 20, 50);
		const messages = options.conversationId ? await this.#domain.conversationMessages(options.conversationId, limit) : await this.#domain.unreadMessages(limit);
		return { messages: messages.filter((m) => m.labels?.[SETUP_LABELS.kind] === undefined).map(({ senderKind: _kind, artifacts: _artifacts, ...m }) => ({ ...m, text: m.text.slice(0, MAX_MESSAGE_CHARS) })) };
	}

	// ---- acting ---------------------------------------------------------------------------------------------------
	/** The owner's decision on a switch the model asked for (from Telegram only). Approving runs exactly what was shown. */
	async approve(id: string): Promise<{ ok: boolean; message: string }> {
		return this.#decide(id, true);
	}

	async denyAny(id: string): Promise<{ ok: boolean; message: string }> {
		return this.#decide(id, false);
	}

	async #decide(id: string, approved: boolean): Promise<{ ok: boolean; message: string }> {
		if (!CONTROL_REQUEST_ID.test(id)) return { ok: false, message: `No pending request ${defang(id).slice(0, 40)}.` };
		return this.#controlRequests().decide(id, approved);
	}

	#controlRequests(): ControlRequests {
		if (!this.controlRequests) throw new PolicyError(503, "not_configured", "controls are not configured");
		return this.controlRequests;
	}

	#controls(): Controls {
		if (!this.controls) throw new PolicyError(503, "not_configured", "controls are not configured");
		return this.controls;
	}

	// ---- controls: reading is free, switching needs the owner -----------------------------------------------------
	async rules(): Promise<unknown> {
		return { rules: (await this.#controls().rules()).map((r) => ({ name: r.name, status: r.status, selector: r.selector, kind: r.wake ? "wake" : "record", fired: r.counters?.fired ?? 0, skipped: r.counters?.skipped ?? {}, lastFiredAt: r.lastFiredAt })) };
	}

	async sources(): Promise<unknown> {
		return this.#controls().sources();
	}

	/** What the agents are doing now (jobs running and waiting, what they wait for, what finished lately, spend today), and the fleet limits, from Operations. */
	async status(agent?: string): Promise<unknown> {
		if (agent !== undefined && !/^agent\/[a-z0-9][a-z0-9._-]{0,48}$/.test(agent)) throw new PolicyError(400, "invalid_request", "agent must be an agent id such as agent/qa, or left out for all agents");
		return this.#controls().agentStatus(agent);
	}

	/** An agent's operator instructions and the role's prompt, as Operations holds them. */
	async setup(agent: string): Promise<unknown> {
		if (!/^agent\/[a-z0-9][a-z0-9._-]{0,48}$/.test(agent)) throw new PolicyError(400, "invalid_request", "agent must be an agent id such as agent/reviewer");
		return this.#controls().agentSetup(agent);
	}

	async handlers(agent: string): Promise<unknown> {
		return this.#controls().handlers(agent);
	}

	/** A switch the model asked for: nothing changes until the owner confirms it in Telegram. */
	async controlRequest(raw: Record<string, unknown>): Promise<unknown> {
		const action = parseAction(raw);
		if (action.action === "set_instructions" && !this.#controls().operationsConfigured) throw new PolicyError(503, "operations_not_configured", "the Manager has no access to Operations, so it cannot change instructions (MANAGER_OPERATIONS_URL and MANAGER_OPERATIONS_TOKEN_FILE)");
		const request = await this.#askOwner(action);
		return { status: "awaiting_owner", requestId: request.id, note: "The owner has been asked on Telegram. Nothing changes until they confirm. Tell them what you asked for." };
	}

	async #askOwner(action: ControlAction): Promise<{ id: string }> {
		const request = this.#controlRequests().create(action);
		await this.#owner
			.tell(`Confirmation ${request.id} needed (expires in ${Math.round(this.#policy.approvalTtlMs / 60_000)} min)\nThe Manager asks to ${describeAction(action)}.\nConfirm with the button, or /approve ${request.id} or /deny ${request.id}`, controlButtons(request.id))
			.catch(() => {
				throw new PolicyError(503, "owner_unreachable", "the owner could not be asked, so nothing changed");
			});
		return request;
	}

	/**
	 * The gate in Pi's tool pipeline asks before a bash command or an MCP tool call runs. A call the rules do not cover goes ahead; any other waits
	 * for the owner, whose confirmation lets exactly that call (same command, or same tool and arguments) through once.
	 */
	async checkCall(raw: Record<string, unknown>): Promise<{ allowed: boolean; requestId?: string; reason?: string; note?: string }> {
		const call = parseCall(raw);
		const reason = this.#approvals?.rules.reasonFor(call);
		if (!reason) return { allowed: true };
		const key = callKey(call);
		if (this.#approvals!.grants.consume(key)) return { allowed: true };
		const asked = this.#askedAbout.get(key);
		const waiting = asked !== undefined && this.controlRequests?.get(asked)?.status === "pending";
		const subject = call.kind === "bash" ? `bash: ${call.command}` : `${call.tool} ${call.input}`;
		const requestId = waiting ? asked : (await this.#askOwner({ action: "allow_call", key, summary: `${clip(defang(subject), 300)} (${reason})` })).id;
		this.#askedAbout.set(key, requestId);
		return { allowed: false, requestId, reason, note: "This call needs the owner's approval. The owner has been asked on Telegram. Tell them what you tried to do and stop; after they confirm you may make exactly the same call once." };
	}

	/** Switches the model asked for that wait for the owner. */
	pendingRequests(): number {
		return this.controlRequests?.pending().length ?? 0;
	}

	/** A chat message to an agent whose answer comes back to the owner in Telegram. Sending is the only effect; no approval is needed. */
	async ask(request: { agent?: string; agents?: string[]; text: string; then?: string }): Promise<unknown> {
		if (!this.chats) throw new PolicyError(503, "not_configured", "chat is not configured");
		const several = Array.isArray(request.agents) && request.agents.length > 0 ? request.agents.map(String) : undefined;
		const sent = await this.chats.ask(several ?? String(request.agent ?? ""), String(request.text ?? ""), typeof request.then === "string" ? request.then : undefined);
		const who = sent.agents ? `${sent.agents.join(", ")} (one conversation, each sees the others' answers)` : sent.agent;
		await this.#owner.tell(`Asked ${who}: ${clip(defang(sent.text), 300)}\nSent, waiting for a reply (I will tell you if nothing comes back in 3 minutes).`).catch(() => {});
		const later = request.then?.trim() ? " You will be woken with the answer to do what you said (once); do not wait for it." : " The agent's answer, if any, is shown to the owner in Telegram; it does not come back to you.";
		return { status: "sent", agent: sent.agent, ...(sent.agents ? { agents: sent.agents } : {}), conversationId: sent.conversationId, note: `Sent.${later} Tell the owner you asked and stop.` };
	}

	/** Agent ids from the catalog, for resolving short names. */
	async knownAgentIds(): Promise<string[]> {
		return [...new Set((await this.agents()).map((a) => a.agentId).filter((id): id is string => typeof id === "string"))];
	}

	async message(request: { to: string | string[]; text: string; conversationId?: string }): Promise<unknown> {
		if (!request.to || request.to.length === 0 || !request.text) throw new PolicyError(400, "invalid_request", "to and text are required");
		if (request.text.length > MAX_MESSAGE_CHARS) throw new PolicyError(413, "message_too_long", `messages are limited to ${MAX_MESSAGE_CHARS} characters`);
		if (!this.#messages.take()) throw new PolicyError(429, "rate_limited", "message limit for this hour reached");
		const sent = await this.#domain.sendMessage(request);
		return { messageId: sent.messageId, conversationId: sent.conversationId };
	}
}

/** Dotted numbers compare by value ("10" after "9"); anything else falls back to text. */
export function compareVersions(a: string, b: string): number {
	const left = a.split(".");
	const right = b.split(".");
	for (let i = 0; i < Math.max(left.length, right.length); i++) {
		const x = left[i] ?? "0";
		const y = right[i] ?? "0";
		const numeric = /^\d+$/.test(x) && /^\d+$/.test(y);
		const order = numeric ? Number(x) - Number(y) : x.localeCompare(y);
		if (order !== 0) return order;
	}
	return 0;
}

/** Keeps the search ranking between capabilities, lists each capability's versions highest first and marks the highest, so a model that takes the first hit takes the latest. */
function highestVersionFirst<T extends { capability: { id: string; version: string } }>(results: T[]): (T & { latest: boolean })[] {
	const rank = new Map<string, number>();
	for (const result of results) if (!rank.has(result.capability.id)) rank.set(result.capability.id, rank.size);
	const latest = new Map<string, string>();
	for (const { capability } of results) {
		const known = latest.get(capability.id);
		if (known === undefined || compareVersions(capability.version, known) > 0) latest.set(capability.id, capability.version);
	}
	return results
		.map((result) => ({ ...result, latest: latest.get(result.capability.id) === result.capability.version }))
		.sort((a, b) => rank.get(a.capability.id)! - rank.get(b.capability.id)! || compareVersions(b.capability.version, a.capability.version));
}

import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { DomainApi, RuleSummary } from "./domain.ts";
import { call, type CallOptions, type CallResult } from "./http.ts";
import { PolicyError, type ApprovalGrants } from "./policy.ts";
import { clip, defang, scrub } from "./redact.ts";
import type { HostControls } from "./host.ts";
import type { ManagerState, SaveState } from "./state.ts";

export interface ControlsConfig {
	/** Base URL of the event hub and the file with its admin bearer token; the CA verifies its TLS when it has one. */
	hubUrl?: string;
	hubTokenFile?: string;
	hubCaFile?: string;
	/** Health endpoint of each agent that runs handlers, by agent id. */
	agentHealth: Record<string, string>;
	agentCaFile?: string;
	/** Operations (ADR 0004): its base URL, the file with the Manager's service token and the CA that verifies its TLS. Without it the Manager cannot read or change an agent's instructions. */
	operations?: { url: string; tokenFile: string; caFile?: string };
}

export type ControlAction =
	| { action: "pause_rule" | "resume_rule"; rule: string }
	| { action: "pause_source" | "resume_source"; source: string }
	| { action: "kill_handler" | "unkill_handler"; agent: string; handler: string; reason?: string }
	| { action: "raise_budget"; agent: string; pool: BudgetPool; tokens: number; reason?: string }
	/** The whole operator addendum of an agent's prompt; an empty text clears it. */
	| { action: "set_instructions"; agent: string; instructions: string; reason?: string }
	/** Made by the approval gate only (`parseAction` never returns it): the owner lets one exact tool call of the model go ahead. */
	| { action: "allow_call"; key: string; summary: string };

export const BUDGET_POOLS = ["tasks", "events", "chat"] as const;
export type BudgetPool = (typeof BUDGET_POOLS)[number];
/** The most one request can add; the agent has its own daily ceiling on top of this. */
export const MAX_BUDGET_RAISE = 10_000_000;
/** Operations refuses a longer addendum. */
export const MAX_INSTRUCTIONS_CHARS = 16_000;
const SHOWN_INSTRUCTIONS_CHARS = 1500;

const RULE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SOURCE = /^[a-z][a-z0-9-]{0,30}$/;
const AGENT = /^agent\/[a-z0-9][a-z0-9._-]{0,48}$/;
const HANDLER = /^(\*|all|[A-Za-z0-9][A-Za-z0-9._-]{0,63})$/;

const bad = (message: string): never => {
	throw new PolicyError(400, "invalid_request", message);
};

const text = (value: unknown): string => (typeof value === "string" ? value : "");

export function parseAction(raw: Record<string, unknown>): ControlAction {
	const action = text(raw.action);
	switch (action) {
		case "pause_rule":
		case "resume_rule":
			return RULE.test(text(raw.rule)) ? { action, rule: text(raw.rule) } : bad("rule must be a rule name such as pr-review-opened");
		case "pause_source":
		case "resume_source":
			return SOURCE.test(text(raw.source)) ? { action, source: text(raw.source) } : bad("source must be a source name such as github");
		case "kill_handler":
		case "unkill_handler": {
			if (!AGENT.test(text(raw.agent))) return bad("agent must be an agent id such as agent/reviewer");
			if (!HANDLER.test(text(raw.handler))) return bad("handler must be a handler name, or all");
			const reason = text(raw.reason) ? clip(defang(text(raw.reason)), 200) : undefined;
			return { action, agent: text(raw.agent), handler: text(raw.handler), ...(reason ? { reason } : {}) };
		}
		case "raise_budget": {
			if (!AGENT.test(text(raw.agent))) return bad("agent must be an agent id such as agent/reviewer");
			const pool = text(raw.pool) as BudgetPool;
			if (!BUDGET_POOLS.includes(pool)) return bad("pool must be tasks (the whole daily limit), events or chat");
			const tokens = Number(raw.tokens);
			if (!Number.isInteger(tokens) || tokens < 1 || tokens > MAX_BUDGET_RAISE) return bad(`tokens must be a whole number from 1 to ${MAX_BUDGET_RAISE}`);
			const reason = text(raw.reason) ? clip(defang(text(raw.reason)), 200) : undefined;
			return { action, agent: text(raw.agent), pool, tokens, ...(reason ? { reason } : {}) };
		}
		case "set_instructions": {
			if (!AGENT.test(text(raw.agent))) return bad("agent must be an agent id such as agent/reviewer");
			if (typeof raw.instructions !== "string") return bad("instructions must be the complete new text of the operator instructions (an empty text clears them)");
			if (raw.instructions.length > MAX_INSTRUCTIONS_CHARS) return bad(`instructions can be at most ${MAX_INSTRUCTIONS_CHARS} characters`);
			const reason = text(raw.reason) ? clip(defang(text(raw.reason)), 200) : undefined;
			return { action, agent: text(raw.agent), instructions: raw.instructions.trim(), ...(reason ? { reason } : {}) };
		}
		default:
			return bad("action must be pause_rule, resume_rule, pause_source, resume_source, kill_handler, unkill_handler, raise_budget or set_instructions");
	}
}

/** Text the model wrote, shown to the owner whole and in its own lines, but with secrets hidden and no `/word` that Telegram would make tappable. */
const quoted = (value: string, max: number): string => clip(scrub(value).replace(/(^|[\s([{"'])\/(?=[A-Za-z0-9_])/g, "$1\u2215"), max);

export const describeAction = (a: ControlAction): string => {
	switch (a.action) {
		case "pause_rule": return `pause rule ${a.rule}`;
		case "resume_rule": return `resume rule ${a.rule}`;
		case "pause_source": return `pause event source ${a.source}`;
		case "resume_source": return `resume event source ${a.source}`;
		case "kill_handler": return `switch off ${a.handler === "*" || a.handler === "all" ? "all handlers" : `handler ${a.handler}`} of ${a.agent}`;
		case "raise_budget": return `give ${a.agent} ${a.tokens} more ${a.pool} tokens for today${a.reason ? ` (${a.reason})` : ""}`;
		case "set_instructions": return a.instructions === "" ? `clear the operator instructions of ${a.agent}${a.reason ? ` (${a.reason})` : ""}` : `set the operator instructions of ${a.agent} to the following ${a.instructions.length} characters${a.reason ? ` (${a.reason})` : ""}:\n${quoted(a.instructions, SHOWN_INSTRUCTIONS_CHARS)}`;
		case "unkill_handler": return `switch on ${a.handler === "*" || a.handler === "all" ? "all handlers" : `handler ${a.handler}`} of ${a.agent}`;
		case "allow_call": return `let one tool call go ahead: ${a.summary}`;
	}
};

interface Sample {
	name: string;
	labels: Record<string, string>;
	value: number;
}

export function parseMetrics(text: string): Sample[] {
	const samples: Sample[] = [];
	for (const line of text.split("\n")) {
		const match = /^([a-zA-Z_:][\w:]*)(?:\{(.*)\})?\s+(-?[0-9.]+(?:[eE][+-]?\d+)?)$/.exec(line.trim());
		if (!match) continue;
		const labels: Record<string, string> = {};
		for (const pair of (match[2] ?? "").matchAll(/([a-zA-Z_]\w*)="((?:[^"\\]|\\.)*)"/g)) labels[pair[1]!] = pair[2]!;
		samples.push({ name: match[1]!, labels, value: Number(match[3]) });
	}
	return samples;
}

export interface SourceStats {
	source: string;
	received: number;
	published: number;
	duplicate: number;
	dropped: number;
	deadLettered: number;
	deadLettersWaiting: number;
}

export interface HubStats {
	receiverUp?: boolean;
	queued?: number;
	oldestPendingSeconds?: number;
	sources: SourceStats[];
}

export function hubStats(samples: Sample[]): HubStats {
	const bySource = new Map<string, SourceStats>();
	const row = (source: string): SourceStats => {
		let found = bySource.get(source);
		if (!found) bySource.set(source, (found = { source, received: 0, published: 0, duplicate: 0, dropped: 0, deadLettered: 0, deadLettersWaiting: 0 }));
		return found;
	};
	const stats: HubStats = { sources: [] };
	for (const sample of samples) {
		const source = sample.labels.source;
		switch (sample.name) {
			case "hub_events_received_total": if (source) row(source).received += sample.value; break;
			case "hub_events_published_total": if (source) row(source).published += sample.value; break;
			case "hub_events_duplicate_total": if (source) row(source).duplicate += sample.value; break;
			case "hub_events_dropped_total": if (source) row(source).dropped += sample.value; break;
			case "hub_events_dead_lettered_total": if (source) row(source).deadLettered += sample.value; break;
			case "hub_dead_letters": if (source) row(source).deadLettersWaiting = sample.value; break;
			case "hub_receiver_up": stats.receiverUp = sample.value === 1; break;
			case "hub_receiver_queued": stats.queued = sample.value; break;
			case "hub_receiver_oldest_pending_age_seconds": stats.oldestPendingSeconds = sample.value; break;
		}
	}
	stats.sources = [...bySource.values()].sort((a, b) => a.source.localeCompare(b.source));
	return stats;
}

const shortJob = (job: any) => ({ job: defang(String(job.id ?? "")), what: clip(defang(String(job.label ?? "")), 120), by: defang(String(job.requestedBy ?? "")) || undefined, since: typeof job.since === "string" ? job.since.slice(11, 16) + "Z" : undefined });

/** One agent's Operations detail as the few facts the model needs: everything from an agent is flattened to plain text. */
export function summariseStatus(id: string, detail: any, full: boolean) {
	const jobs: any[] = Array.isArray(detail.liveJobs) ? detail.liveJobs : [];
	const finished = jobs.filter((job) => job.state === "finished").sort((a, b) => String(b.finishedAt ?? "").localeCompare(String(a.finishedAt ?? ""))).slice(0, full ? 8 : 3);
	const history: any[] = Array.isArray(detail.history) ? detail.history : [];
	const summaries = new Map(history.map((entry) => [String(entry.job), entry]));
	const usage: any[] = Array.isArray(detail.usage) ? detail.usage : [];
	const today = usage.reduce((sum, row) => sum + (Number(row?.day?.costUsd) || 0), 0);
	const agent = detail.agent ?? {};
	return {
		agent: id,
		state: agent.liveness ?? "unknown",
		...(agent.reachable === false ? { unreachable: "Operations cannot read its health endpoint" } : {}),
		setup: { savedRevision: agent.savedRevision ?? 0, appliedRevision: agent.appliedRevision ?? null, ...(agent.rejected ? { rejected: clip(defang(String(agent.rejected.reason ?? "")), 160) } : {}) },
		running: jobs.filter((job) => job.state === "running").map(shortJob),
		waiting: jobs.filter((job) => job.state === "waiting").map((job) => ({ ...shortJob(job), waitingFor: clip(defang(String(job.waitingFor ?? "a free slot")), 80) })),
		recentlyFinished: finished.map((job) => {
			const known = summaries.get(String(job.id));
			return { ...shortJob(job), result: job.result ?? "unknown", ...(typeof job.finishedAt === "string" ? { at: job.finishedAt.slice(11, 16) + "Z" } : {}), ...(typeof job.seconds === "number" ? { seconds: Math.round(job.seconds) } : {}), ...(known?.summary || job.summary ? { summary: clip(defang(String(known?.summary ?? job.summary)), full ? 400 : 160) } : {}) };
		}),
		spendTodayUsd: Math.round(today * 100) / 100,
		...(usage[0]?.model ? { model: `${usage[0].provider ?? ""}/${usage[0].model}` } : {}),
		...(Array.isArray(detail.notes) && detail.notes.length > 0 ? { notes: detail.notes.slice(0, 3).map((note: unknown) => clip(defang(String(note)), 160)) } : {}),
	};
}

export interface ControlsDeps {
	domain: DomainApi;
	config: ControlsConfig;
	state: ManagerState;
	save: SaveState;
	/** Questions waiting for the owner: approvals agents asked for and switches the model asked for. */
	pendingQuestions?: () => number;
	http?: (url: string, options?: CallOptions) => Promise<CallResult>;
	readToken?: (path: string) => Promise<string>;
	/** The processes: the agent stacks on this machine and the Windows agents. Without it /suspend only reaches what the platform controls. */
	host?: HostControls;
	/** For tests: how long to wait for the hub to answer after it was started. */
	hubWaitMs?: number;
	/** Where the owner's permission for one tool call is kept, and for how long it lasts. */
	grants?: { store: ApprovalGrants; ttlMs: number };
}

/** Everything the owner can look at and switch off: rules in the domain, event sources in the hub, handlers in the agents. Creating a rule is deliberately not here. */
export class Controls {
	readonly #deps: ControlsDeps;
	readonly #http: NonNullable<ControlsDeps["http"]>;

	constructor(deps: ControlsDeps) {
		this.#deps = deps;
		this.#http = deps.http ?? call;
	}

	// ---- rules -----------------------------------------------------------------------------------------------------
	async rules(): Promise<RuleSummary[]> {
		return this.#deps.domain.listRules();
	}

	formatRules(rules: RuleSummary[]): string {
		if (rules.length === 0) return "No rules in the domain.";
		return rules
			.map((r) => {
				const skipped = Object.entries(r.counters?.skipped ?? {}).filter(([, n]) => n > 0).map(([why, n]) => `${why} ${n}`).join(", ");
				return `${r.name} [${r.status}] ${r.wake ? "wake" : "record"} on ${r.selector}; fired ${r.counters?.fired ?? 0}${skipped ? `, skipped: ${skipped}` : ""}; last ${r.lastFiredAt ?? "never"}`;
			})
			.join("\n");
	}

	// ---- the hub ---------------------------------------------------------------------------------------------------
	/** One request to a service this one does not own: a connection that fails is a 502 with the service named, never an unexplained 500. */
	async #reach(who: string, code: "hub_unavailable" | "agent_unavailable" | "operations_unavailable", url: string, options: Parameters<NonNullable<ControlsDeps["http"]>>[1]) {
		try {
			return await this.#http(url, options);
		} catch (error) {
			if (error instanceof PolicyError) throw error;
			throw new PolicyError(502, code, `${who} could not be reached`);
		}
	}

	async sources(): Promise<HubStats> {
		const { hubUrl, hubCaFile } = this.#deps.config;
		if (!hubUrl) throw new PolicyError(503, "hub_not_configured", "no hub URL is configured (MANAGER_HUB_URL)");
		const answer = await this.#reach("the hub", "hub_unavailable", `${hubUrl.replace(/\/$/, "")}/metrics`, { caFile: hubCaFile });
		if (answer.status !== 200) throw new PolicyError(502, "hub_unavailable", `the hub answered ${answer.status}`);
		return hubStats(parseMetrics(answer.text));
	}

	formatSources(stats: HubStats): string {
		const paused = this.#deps.state.sourcesPaused ?? {};
		const head = `Receiver ${stats.receiverUp === undefined ? "state unknown" : stats.receiverUp ? "up" : "DOWN"}, ${stats.queued ?? "?"} queued, oldest ${stats.oldestPendingSeconds === undefined ? "?" : `${Math.round(stats.oldestPendingSeconds)} s`}`;
		const lines = stats.sources.map(
			(s) => `${s.source}${paused[s.source] ? " [paused from here]" : ""}: in ${s.received}, published ${s.published}, duplicate ${s.duplicate}, dropped ${s.dropped}, dead letters ${s.deadLettersWaiting}`,
		);
		return [head, ...(lines.length ? lines : ["No source has received anything yet."])].join("\n");
	}

	async setSourcePaused(source: string, paused: boolean): Promise<string> {
		const { hubUrl, hubTokenFile, hubCaFile } = this.#deps.config;
		if (!hubUrl || !hubTokenFile) throw new PolicyError(503, "hub_not_configured", "the hub URL and admin token file are not configured");
		const token = (await (this.#deps.readToken ?? ((path) => readFile(path, "utf8")))(hubTokenFile)).trim();
		const answer = await this.#reach("the hub", "hub_unavailable", `${hubUrl.replace(/\/$/, "")}/admin/sources/${encodeURIComponent(source)}/${paused ? "pause" : "resume"}`, {
			method: "POST",
			headers: { authorization: `Bearer ${token}` },
			caFile: hubCaFile,
		});
		if (answer.status === 404) throw new PolicyError(404, "unknown_source", `the hub has no source ${source}`);
		if (answer.status !== 200) throw new PolicyError(502, "hub_refused", `the hub answered ${answer.status}`);
		const state = this.#deps.state;
		state.sourcesPaused = { ...state.sourcesPaused, [source]: paused };
		await this.#deps.save(state);
		return `Source ${source} ${paused ? "paused" : "resumed"}.`;
	}

	// ---- handlers --------------------------------------------------------------------------------------------------
	async handlers(agent: string): Promise<any> {
		const base = this.#deps.config.agentHealth[agent];
		if (!base) throw new PolicyError(404, "unknown_agent", `no health URL is configured for ${agent} (MANAGER_AGENT_HEALTH)`);
		const answer = await this.#reach(agent, "agent_unavailable", `${base.replace(/\/$/, "")}/status`, { caFile: this.#deps.config.agentCaFile });
		if (answer.status !== 200) throw new PolicyError(502, "agent_unavailable", `${agent} answered ${answer.status}`);
		try {
			return JSON.parse(answer.text);
		} catch {
			throw new PolicyError(502, "agent_unavailable", `${agent} answered something that is not JSON`);
		}
	}

	formatHandlers(agent: string, status: any): string {
		const handlers: any[] = Array.isArray(status?.handlers) ? status.handlers : [];
		const pools = status?.tokenPools ?? {};
		const lines = handlers.map(
			(h) => `${defang(String(h.name))} v${defang(String(h.version ?? "?"))} [${h.enabled ? "on" : `OFF${h.disabledReason ? `: ${clip(defang(String(h.disabledReason)), 80)}` : ""}`}] runs ${h.runs ?? 0}, errors ${h.errors ?? 0}, drops ${h.drops ?? 0}, wakes ${h.wakes ?? 0}${h.lastError ? `, last error: ${clip(defang(String(h.lastError)), 80)}` : ""}`,
		);
		const pool = (name: string) => {
			const p = pools[name];
			return p ? `${name} ${p.used}/${p.limit}${p.stopped ? " STOPPED" : p.throttled ? " throttled" : ""}` : undefined;
		};
		const raised = Object.entries(pools.raisedToday ?? {}).filter(([, n]) => Number(n) > 0).map(([name, n]) => `${name} ${Number(n)}`);
		const listed = [pool("tasks"), pool("events"), pool("chat")].filter(Boolean).join("; ");
		const poolLine = listed && raised.length ? `${listed} (raised today: ${raised.join(", ")})` : listed;
		return [`${agent}: ${handlers.length} handlers`, ...lines, ...(poolLine ? [`Token pools: ${poolLine}`] : [])].join("\n");
	}

	async setHandler(agent: string, handler: string, off: boolean, reason?: string): Promise<string> {
		const all = handler === "all" || handler === "*";
		const labels: Record<string, string> = { eventControl: all ? (off ? "disable-all" : "enable-all") : off ? "disable" : "enable" };
		if (!all) labels.eventTarget = handler;
		if (off) labels.eventReason = reason ?? "switched off by the owner from Telegram";
		await this.#deps.domain.sendMessage({ to: agent, text: `event handler control: ${labels.eventControl}${all ? "" : ` ${handler}`}`, labels });
		return `Asked ${agent} to switch ${off ? "off" : "on"} ${all ? "all handlers" : `handler ${handler}`}. The agent applies it when it reads the message; check with /handlers ${agent}.`;
	}

	/** The budget rides on a direct message like the handler switch; the agent applies it, caps it per day and answers with what it did. */
	async raiseBudget(agent: string, pool: BudgetPool, tokens: number, reason?: string): Promise<string> {
		const labels: Record<string, string> = { budgetControl: "raise", budgetPool: pool, budgetTokens: String(tokens) };
		if (reason) labels.budgetReason = reason;
		await this.#deps.domain.sendMessage({ to: agent, text: `budget control: raise ${pool} by ${tokens} tokens for today`, labels });
		return `Asked ${agent} to add ${tokens} tokens to its ${pool} pool for today. It confirms by message and the raise ends tomorrow; the pools are in somework_handlers.`;
	}

	// ---- Operations: an agent's instructions --------------------------------------------------------------------------
	get operationsConfigured(): boolean {
		return this.#deps.config.operations !== undefined;
	}

	async #operations(method: "GET" | "PUT", agent: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
		const slug = agent.replace(/^agent\//, "");
		const answer = await this.#operationsCall(method, `/agents/${encodeURIComponent(slug)}${path}`, body);
		if (answer.status === 404) throw new PolicyError(404, "unknown_agent", `Operations does not know ${agent}`);
		return answer;
	}

	/** One call to a route of Operations (`/fleet/api/ops` + `path`) with the Manager's service token. */
	async #operationsCall(method: "GET" | "PUT", path: string, body?: unknown): Promise<{ status: number; json: any }> {
		const operations = this.#deps.config.operations;
		if (!operations) throw new PolicyError(503, "operations_not_configured", "Operations is not configured for the Manager (MANAGER_OPERATIONS_URL and MANAGER_OPERATIONS_TOKEN_FILE)");
		const token = (await (this.#deps.readToken ?? ((file) => readFile(file, "utf8")))(operations.tokenFile)).trim();
		const answer = await this.#reach("Operations", "operations_unavailable", `${operations.url.replace(/\/$/, "")}/fleet/api/ops${path}`, {
			method,
			headers: { "x-operations-service-token": token, ...(method === "GET" ? {} : { "x-operations-request": "1" }) },
			caFile: operations.caFile,
			...(body === undefined ? {} : { body }),
			maxBytes: 4_000_000,
		});
		let json: any;
		try {
			json = JSON.parse(answer.text);
		} catch {
			json = undefined;
		}
		if (answer.status === 401 || answer.status === 403) throw new PolicyError(502, "operations_refused", `Operations refused the Manager's token (${answer.status}); the service token needs the editor role`);
		return { status: answer.status, json };
	}

	/**
	 * What the agents are doing right now, from Operations (which follows their job events): per agent whether it is alive, the jobs that run and
	 * those that wait (and for what), the last jobs that finished, today's spend; and the fleet limits every run is held to.
	 */
	async agentStatus(agent?: string): Promise<unknown> {
		const [limits, list] = await Promise.all([this.#operationsCall("GET", "/limits").catch(() => undefined), agent ? undefined : this.#operationsCall("GET", "/agents")]);
		if (list && (list.status !== 200 || !list.json)) throw new PolicyError(502, "operations_unavailable", `Operations answered ${list.status}`);
		const ids: string[] = agent ? [agent] : (list!.json.agents ?? []).map((entry: any) => String(entry.id));
		const one = async (id: string) => {
			const answer = await this.#operations("GET", id, "");
			if (answer.status !== 200 || !answer.json) throw new PolicyError(502, "operations_unavailable", `Operations answered ${answer.status}`);
			return summariseStatus(id, answer.json, agent !== undefined);
		};
		const agents = await Promise.all(ids.map((id) => one(id).catch((error: unknown) => ({ agent: id, error: error instanceof PolicyError ? error.message : "could not be read" }))));
		const current = limits?.json?.current?.values;
		return {
			...(current ? { fleetLimits: { perJobTokens: current.maxTokensCap, perJobMinutes: current.maxMinutesCap, dailyTokens: current.dailyTokenLimit, raiseCeiling: current.budgetRaiseCeiling, note: "set by the owner in Operations (Fleet limits); every agent is held to them, raise_budget adds extra tokens for one agent for today only" } } : {}),
			agents,
		};
	}

	/** What the agent runs on now: the operator instructions Operations holds for it, the role's own prompt (read only) and whether the last save has reached it. */
	async agentSetup(agent: string): Promise<unknown> {
		const { status, json } = await this.#operations("GET", agent, "");
		if (status !== 200 || !json) throw new PolicyError(502, "operations_unavailable", `Operations answered ${status}`);
		const prompt: string | undefined = json.roleDefaults?.prompt ?? undefined;
		return {
			agent: json.agent?.id ?? agent,
			savedRevision: json.agent?.savedRevision ?? 0,
			appliedRevision: json.agent?.appliedRevision ?? null,
			pending: json.agent?.pending ?? false,
			...(json.agent?.rejected ? { rejected: json.agent.rejected } : {}),
			instructions: json.form?.instructions ?? "",
			rolePrompt: prompt === undefined ? "(not reported by the agent)" : clip(prompt, 2500),
			note: "instructions is the operator addendum appended to the role's built-in prompt, which cannot be edited. To change it, ask the owner with somework_control set_instructions and the complete new text.",
		};
	}

	/** Saves the new addendum as one more revision from the current one, keeping skills, tool servers, model and approvals as they are. */
	async setInstructions(agent: string, instructions: string, reason?: string): Promise<string> {
		const { status: read, json: detail } = await this.#operations("GET", agent, "");
		if (read !== 200 || !detail) throw new PolicyError(502, "operations_unavailable", `Operations answered ${read}`);
		const note = clip(`by the Manager at the owner's request${reason ? `: ${reason}` : ""}`, 250);
		const form = { ...(detail.form ?? {}), instructions: instructions === "" ? null : instructions };
		const { status, json } = await this.#operations("PUT", agent, "/setup", { baseRevision: detail.agent?.savedRevision ?? 0, form, note });
		if (status === 409) throw new PolicyError(409, "revision_conflict", `${agent}'s setup was saved by someone else first (revision ${json?.current?.revision ?? "?"}); read it again before asking`);
		if (status === 400 || status === 422) throw new PolicyError(400, "invalid_setup", clip(defang(String(json?.message ?? "Operations refused the instructions")), 200));
		if (status !== 200) throw new PolicyError(502, "operations_unavailable", `Operations answered ${status}`);
		return `Saved revision ${json?.revision?.revision ?? "?"} of ${agent}'s operator instructions (${instructions === "" ? "cleared" : `${instructions.length} characters`}). Operations sends it to the agent now; the agent applies it from its next model run and confirms.`;
	}

	allowCall(key: string): string {
		const grants = this.#deps.grants;
		if (!grants) throw new PolicyError(503, "not_configured", "tool call approvals are not configured");
		grants.store.allow(key, grants.ttlMs);
		return `Allowed: the model may repeat that exact call once within ${Math.round(grants.ttlMs / 60_000)} minutes.`;
	}

	// ---- everything at once ----------------------------------------------------------------------------------------
	isSuspended(): boolean {
		return this.#deps.state.suspended !== undefined || (this.#deps.host?.isSuspended() ?? false);
	}

	/**
	 * Stops the work the platform itself starts: every active rule is paused, every event source of the hub is paused, every agent that runs handlers is
	 * told to switch all of them off. What was changed is recorded first, so `resumeAll` restores only that (a rule or source the owner had paused
	 * before stays paused). Each step reports its own failure; the others still run.
	 */
	async suspendAll(reason?: string): Promise<string> {
		const state = this.#deps.state;
		const record = state.suspended ?? { at: new Date().toISOString(), rules: [], sources: [], agents: [] };
		if (reason) record.reason = clip(defang(reason), 200);
		state.suspended = record;
		await this.#deps.save(state);
		const why = record.reason ?? "suspended by the owner from Telegram";
		const lines: string[] = [];
		const failed = (what: string, error: unknown) => lines.push(`${what}: FAILED (${clip(defang(error instanceof Error ? error.message : "error"), 120)})`);

		try {
			const active = (await this.rules()).filter((rule) => rule.status === "active");
			for (const rule of active) {
				await this.#deps.domain.pauseRule(rule.name);
				if (!record.rules.includes(rule.name)) record.rules.push(rule.name);
			}
			lines.push(`Rules paused: ${active.length}${active.length ? ` (${active.map((rule) => rule.name).join(", ")})` : ""}`);
		} catch (error) {
			failed("Rules", error);
		}
		if (this.#deps.config.hubUrl) {
			try {
				const sources = (await this.sources()).sources.map((s) => s.source).filter((name) => !(state.sourcesPaused ?? {})[name]);
				for (const source of sources) {
					await this.setSourcePaused(source, true);
					if (!record.sources.includes(source)) record.sources.push(source);
				}
				lines.push(`Event sources paused: ${sources.length}${sources.length ? ` (${sources.join(", ")})` : ""}`);
			} catch (error) {
				failed("Event sources", error);
			}
		}
		for (const agent of Object.keys(this.#deps.config.agentHealth)) {
			try {
				await this.setHandler(agent, "all", true, why);
				if (!record.agents.includes(agent)) record.agents.push(agent);
			} catch (error) {
				failed(`Handlers of ${agent}`, error);
			}
		}
		if (record.agents.length > 0) lines.push(`Handlers switched off on: ${record.agents.join(", ")}`);
		await this.#deps.save(state);
		if (this.#deps.host) {
			try {
				lines.push("Processes:", ...(await this.#deps.host.suspend()).map((line) => `  ${line}`));
			} catch (error) {
				failed("Processes", error);
			}
		}
		return lines.join("\n");
	}

	async #waitForHub(): Promise<void> {
		if (!this.#deps.config.hubUrl) return;
		const until = Date.now() + (this.#deps.hubWaitMs ?? 90_000);
		while (Date.now() < until) {
			try {
				await this.sources();
				return;
			} catch {
				await new Promise((resolve) => setTimeout(resolve, Math.min(3000, Math.max(50, until - Date.now()))));
			}
		}
	}

	/** Puts back what `suspendAll` changed. A step that fails stays in the record, so running it again retries only that. */
	async resumeAll(): Promise<string> {
		const state = this.#deps.state;
		const record = state.suspended;
		const lines: string[] = [];
		// the processes first: the hub has to be up for its sources to be resumed and the agents for the handlers to be switched on
		if (this.#deps.host?.isSuspended()) {
			try {
				lines.push("Processes:", ...(await this.#deps.host.resume()).map((line) => `  ${line}`));
			} catch (error) {
				lines.push(`Processes: FAILED (${clip(defang(error instanceof Error ? error.message : "error"), 120)})`);
			}
			if (record && record.sources.length > 0) await this.#waitForHub();
		}
		if (!record) return lines.length > 0 ? lines.join("\n") : "Nothing is suspended.";
		const remaining: { rules: string[]; sources: string[]; agents: string[] } = { rules: [], sources: [], agents: [] };
		for (const rule of record.rules) {
			try {
				await this.#deps.domain.resumeRule(rule);
			} catch {
				remaining.rules.push(rule);
			}
		}
		for (const source of record.sources) {
			try {
				await this.setSourcePaused(source, false);
			} catch {
				remaining.sources.push(source);
			}
		}
		for (const agent of record.agents) {
			try {
				await this.setHandler(agent, "all", false);
			} catch {
				remaining.agents.push(agent);
			}
		}
		lines.push(`Resumed: ${record.rules.length - remaining.rules.length} rules, ${record.sources.length - remaining.sources.length} sources, handlers of ${record.agents.length - remaining.agents.length} agents.`);
		if (remaining.rules.length + remaining.sources.length + remaining.agents.length > 0) {
			state.suspended = { ...record, ...remaining };
			lines.push(`Still suspended because they could not be reached: ${[...remaining.rules, ...remaining.sources, ...remaining.agents].join(", ")}. Send /unsuspend again.`);
		} else {
			delete state.suspended;
		}
		await this.#deps.save(state);
		return lines.join("\n");
	}

	// ---- one entry point for commands and confirmed requests --------------------------------------------------------
	async run(action: ControlAction): Promise<string> {
		switch (action.action) {
			case "pause_rule": return `Rule ${(await this.#deps.domain.pauseRule(action.rule)).name} paused.`;
			case "resume_rule": return `Rule ${(await this.#deps.domain.resumeRule(action.rule)).name} resumed.`;
			case "pause_source": return this.setSourcePaused(action.source, true);
			case "resume_source": return this.setSourcePaused(action.source, false);
			case "kill_handler": return this.setHandler(action.agent, action.handler, true, action.reason);
			case "unkill_handler": return this.setHandler(action.agent, action.handler, false);
			case "raise_budget": return this.raiseBudget(action.agent, action.pool, action.tokens, action.reason);
			case "set_instructions": return this.setInstructions(action.agent, action.instructions, action.reason);
			case "allow_call": return this.allowCall(action.key);
		}
	}

	// ---- the digest ------------------------------------------------------------------------------------------------
	async digest(): Promise<string> {
		const lines = ["Daily digest"];
		lines.push(`Questions waiting for you: ${this.#deps.pendingQuestions?.() ?? 0}`);
		await this.rules()
			.then((rules) => {
				const active = rules.filter((r) => r.status === "active").length;
				const fired = rules.reduce((sum, r) => sum + (r.counters?.fired ?? 0), 0);
				lines.push(`Rules: ${active} active, ${rules.length - active} paused, ${fired} firings in total`);
			})
			.catch(() => lines.push("Rules: not readable"));
		if (this.#deps.config.hubUrl) {
			await this.sources().then((s) => lines.push(this.formatSources(s))).catch((error: unknown) => lines.push(`Hub: ${clip(defang(error instanceof Error ? error.message : "error"), 100)}`));
		}
		for (const agent of Object.keys(this.#deps.config.agentHealth)) {
			await this.handlers(agent)
				.then((status) => {
					const off = (status.handlers ?? []).filter((h: any) => !h.enabled).map((h: any) => h.name);
					const stopped = status.tokenPools?.events?.stopped ? "; event pool used up" : "";
					lines.push(`${agent}: ${(status.handlers ?? []).length} handlers${off.length ? `, off: ${off.join(", ")}` : ""}${stopped}`);
				})
				.catch(() => lines.push(`${agent}: health not readable`));
		}
		return lines.join("\n");
	}
}

interface PendingControl {
	id: string;
	action: ControlAction;
	expiresAt: number;
	status: "pending" | "approved" | "denied" | "expired";
}

export const CONTROL_REQUEST_ID = /^c[0-9a-f]{8}$/;

/**
 * Switches the model asks for. The model's tools can only create a request; the owner's Telegram button or command runs it, so a prompt
 * injected into the model cannot pause a rule or silence a handler on its own. The owner's own commands skip this step.
 */
export class ControlRequests {
	readonly #controls: Controls;
	readonly #ttlMs: number;
	readonly #now: () => number;
	readonly #items = new Map<string, PendingControl>();

	constructor(controls: Controls, ttlMs: number, now: () => number = Date.now) {
		this.#controls = controls;
		this.#ttlMs = ttlMs;
		this.#now = now;
	}

	create(action: ControlAction): PendingControl {
		const id = `c${randomBytes(4).toString("hex")}`;
		const item: PendingControl = { id, action, expiresAt: this.#now() + this.#ttlMs, status: "pending" };
		this.#items.set(id, item);
		return item;
	}

	get(id: string): PendingControl | undefined {
		const item = this.#items.get(id);
		if (item?.status === "pending" && this.#now() >= item.expiresAt) item.status = "expired";
		return item;
	}

	pending(): PendingControl[] {
		return [...this.#items.keys()].map((id) => this.get(id)!).filter((item) => item.status === "pending");
	}

	async decide(id: string, approve: boolean): Promise<{ ok: boolean; message: string }> {
		const item = this.get(id);
		if (!item) return { ok: false, message: `No pending request ${id}.` };
		if (item.status !== "pending") return { ok: false, message: `Request ${id} is already ${item.status}.` };
		item.status = approve ? "approved" : "denied";
		if (!approve) return { ok: true, message: `Denied ${id}. Nothing changed.` };
		try {
			return { ok: true, message: await this.#controls.run(item.action) };
		} catch (error) {
			return { ok: false, message: `Confirmed, but it failed: ${clip(defang(error instanceof Error ? error.message : "error"), 240)}` };
		}
	}
}

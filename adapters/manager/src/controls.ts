import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { DomainApi, RuleSummary } from "./domain.ts";
import { call, type CallOptions, type CallResult } from "./http.ts";
import { PolicyError } from "./policy.ts";
import { clip, defang } from "./redact.ts";
import type { ManagerState, SaveState, TrackedTask } from "./state.ts";

export interface ControlsConfig {
	/** Base URL of the event hub and the file with its admin bearer token; the CA verifies its TLS when it has one. */
	hubUrl?: string;
	hubTokenFile?: string;
	hubCaFile?: string;
	/** Health endpoint of each agent that runs handlers, by agent id. */
	agentHealth: Record<string, string>;
	agentCaFile?: string;
}

export type ControlAction =
	| { action: "pause_rule" | "resume_rule"; rule: string }
	| { action: "pause_source" | "resume_source"; source: string }
	| { action: "kill_handler" | "unkill_handler"; agent: string; handler: string; reason?: string };

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
		default:
			return bad("action must be pause_rule, resume_rule, pause_source, resume_source, kill_handler or unkill_handler");
	}
}

export const describeAction = (a: ControlAction): string => {
	switch (a.action) {
		case "pause_rule": return `pause rule ${a.rule}`;
		case "resume_rule": return `resume rule ${a.rule}`;
		case "pause_source": return `pause event source ${a.source}`;
		case "resume_source": return `resume event source ${a.source}`;
		case "kill_handler": return `switch off ${a.handler === "*" || a.handler === "all" ? "all handlers" : `handler ${a.handler}`} of ${a.agent}`;
		case "unkill_handler": return `switch on ${a.handler === "*" || a.handler === "all" ? "all handlers" : `handler ${a.handler}`} of ${a.agent}`;
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

export interface ControlsDeps {
	domain: DomainApi;
	config: ControlsConfig;
	state: ManagerState;
	save: SaveState;
	tasks?: () => TrackedTask[];
	localPendingApprovals?: () => number;
	domainPendingApprovals?: () => Promise<number>;
	http?: (url: string, options?: CallOptions) => Promise<CallResult>;
	readToken?: (path: string) => Promise<string>;
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
				return `${r.name} [${r.status}] ${r.reaction ? "reaction" : r.wake ? "wake" : "record"} on ${r.selector}; fired ${r.counters?.fired ?? 0}${skipped ? `, skipped: ${skipped}` : ""}; last ${r.lastFiredAt ?? "never"}`;
			})
			.join("\n");
	}

	// ---- the hub ---------------------------------------------------------------------------------------------------
	/** One request to a service this one does not own: a connection that fails is a 502 with the service named, never an unexplained 500. */
	async #reach(who: string, code: "hub_unavailable" | "agent_unavailable", url: string, options: Parameters<NonNullable<ControlsDeps["http"]>>[1]) {
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
		const poolLine = [pool("tasks"), pool("events")].filter(Boolean).join("; ");
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

	// ---- one entry point for commands and confirmed requests --------------------------------------------------------
	async run(action: ControlAction): Promise<string> {
		switch (action.action) {
			case "pause_rule": return `Rule ${(await this.#deps.domain.pauseRule(action.rule)).name} paused.`;
			case "resume_rule": return `Rule ${(await this.#deps.domain.resumeRule(action.rule)).name} resumed.`;
			case "pause_source": return this.setSourcePaused(action.source, true);
			case "resume_source": return this.setSourcePaused(action.source, false);
			case "kill_handler": return this.setHandler(action.agent, action.handler, true, action.reason);
			case "unkill_handler": return this.setHandler(action.agent, action.handler, false);
		}
	}

	// ---- the digest ------------------------------------------------------------------------------------------------
	async digest(): Promise<string> {
		const lines = ["Daily digest"];
		const tasks = this.#deps.tasks?.() ?? [];
		const day = Date.now() - 86_400_000;
		const recent = tasks.filter((t) => Date.parse(t.submittedAt) >= day);
		lines.push(`Tasks: ${tasks.filter((t) => !["succeeded", "failed", "rejected", "canceled", "expired"].includes(t.state)).length} in flight, ${recent.length} submitted in the last day`);
		const domainPending = await this.#deps.domainPendingApprovals?.().catch(() => undefined);
		lines.push(`Approvals waiting: ${(this.#deps.localPendingApprovals?.() ?? 0) + (domainPending ?? 0)}`);
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

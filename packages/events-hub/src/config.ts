import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface ProducerConfig {
	/** Key file of the source's own SomeWork principal (`producer/<source>`), written by `somework admin enroll-agent`. */
	keyFile: string;
}

export interface ForwardConfig {
	/** Where the webhook is replayed to: baseUrl + the path suffix the sender used + the original query string. The query carries the
	 * sender's own credential (Woodpecker's access_token), so it is taken from the webhook, never from this file. */
	baseUrl: string;
	/** CA bundle that signs the target's certificate; only it is trusted. */
	caFile?: string;
}

export interface SourceConfig {
	name: string;
	version: number;
	/** The JSONata mapping (mappings/<name>.jsonata). Absent for forward-only sources. */
	mapping?: string;
	producer?: ProducerConfig;
	classification?: string;
	/** Static data handed to the mapping as `defaults`, for what a webhook cannot carry (for example the repository a Jira project is tested against). */
	defaults?: { [key: string]: unknown };
	/** Served by the hub's own listener (POST /in/<source>/<token>) instead of the public receiver. */
	internal?: boolean;
	forward?: ForwardConfig;
}

export interface ScheduleConfig {
	name: string;
	cron: string;
	timeZone: string;
	jitterSeconds: number;
	missed: "run-once" | "skip" | "auto";
}

/** One-shot timers that agents ask the hub for ("trigger me with this in 15 minutes"). Needs the clock's producer, the events are published as its source. */
export interface TimersConfig {
	/** The agents that may ask, by id. Each has its own token (`somework-hub timer-token <agent>`). */
	agents: string[];
	minDelaySeconds: number;
	maxDelaySeconds: number;
	maxPendingPerAgent: number;
}

/** Watches on pull requests (ADR 0005): an agent asks the hub for the events of one pull request and gets them as `github.watch.<agent>.event`. Open to every agent that presents its own token. */
export interface WatchesConfig {
	/** The source whose mapped events are matched and whose producer publishes the watch events (default `github`). */
	source: string;
	maxPerAgent: number;
}

export interface HubConfig {
	domain: { url: string; caFile?: string; requireTls: boolean };
	receiver: { url: string; caFile?: string; waitSeconds: number };
	defaultClassification: string;
	mappingsDir: string;
	storePath: string;
	maxAttempts: number;
	sources: SourceConfig[];
	clock: { producer?: ProducerConfig; schedules: ScheduleConfig[] };
	timers?: TimersConfig;
	watches?: WatchesConfig;
}

const SOURCE_NAME = /^[a-z][a-z0-9-]{0,30}$/;
const SCHEDULE_NAME = /^[a-z][a-z0-9_]{0,40}$/;

export function parseConfig(raw: unknown, baseDir = "."): HubConfig {
	if (typeof raw !== "object" || raw === null) throw new Error("the hub config must be an object");
	const input = raw as Record<string, any>;
	const need = (value: unknown, label: string): string => {
		if (typeof value !== "string" || value === "") throw new Error(`the hub config needs ${label}`);
		return value;
	};
	const seen = new Set<string>();
	const sources = (input.sources ?? []).map((entry: Record<string, any>): SourceConfig => {
		const name = need(entry.name, "a source name");
		if (!SOURCE_NAME.test(name)) throw new Error(`invalid source name "${name}"`);
		if (seen.has(name)) throw new Error(`duplicate source "${name}"`);
		seen.add(name);
		const version = Number(entry.version ?? 1);
		if (!Number.isInteger(version) || version < 1) throw new Error(`source ${name}: version must be a positive integer`);
		const forward = entry.forward
			? { baseUrl: need(entry.forward.baseUrl, `source ${name}: forward.baseUrl`).replace(/\/+$/, ""), ...(entry.forward.caFile ? { caFile: String(entry.forward.caFile) } : {}) }
			: undefined;
		if (forward) new URL(forward.baseUrl);
		if (entry.defaults !== undefined && (typeof entry.defaults !== "object" || entry.defaults === null || Array.isArray(entry.defaults))) throw new Error(`source ${name}: defaults must be an object`);
		if (entry.defaults && JSON.stringify(entry.defaults).length > 16 * 1024) throw new Error(`source ${name}: defaults is larger than 16 KiB`);
		if (forward && (entry.mapping || entry.producer)) throw new Error(`source ${name}: a forward-only source has no mapping or producer`);
		if (!forward && (!entry.mapping || !entry.producer?.keyFile)) throw new Error(`source ${name}: needs a mapping and a producer key file (or forward)`);
		return {
			name,
			version,
			...(entry.mapping ? { mapping: String(entry.mapping) } : {}),
			...(entry.producer ? { producer: { keyFile: String(entry.producer.keyFile) } } : {}),
			...(entry.classification ? { classification: String(entry.classification) } : {}),
			...(entry.defaults ? { defaults: entry.defaults } : {}),
			...(entry.internal ? { internal: true } : {}),
			...(forward ? { forward } : {}),
		};
	});
	const schedules = (input.clock?.schedules ?? []).map((entry: Record<string, any>): ScheduleConfig => {
		const name = need(entry.name, "a schedule name");
		if (!SCHEDULE_NAME.test(name)) throw new Error(`invalid schedule name "${name}" (lowercase letters, digits, underscore)`);
		const missed = entry.missed === undefined ? "auto" : String(entry.missed);
		if (missed !== "run-once" && missed !== "skip" && missed !== "auto") throw new Error(`schedule ${name}: missed must be run-once or skip`);
		return { name, cron: need(entry.cron, `schedule ${name}: cron`), timeZone: String(entry.timeZone ?? "Europe/Stockholm"), jitterSeconds: Number(entry.jitterSeconds ?? 0), missed };
	});
	if (schedules.length > 0 && !input.clock?.producer?.keyFile) throw new Error("clock schedules need clock.producer.keyFile");
	const timers = input.timers === undefined ? undefined : parseTimers(input.timers, Boolean(input.clock?.producer?.keyFile));
	const watches = input.watches === undefined ? undefined : parseWatches(input.watches, sources);
	return {
		domain: { url: need(input.domain?.url, "domain.url"), ...(input.domain?.caFile ? { caFile: String(input.domain.caFile) } : {}), requireTls: input.domain?.requireTls !== false },
		receiver: { url: need(input.receiver?.url, "receiver.url"), ...(input.receiver?.caFile ? { caFile: String(input.receiver.caFile) } : {}), waitSeconds: Number(input.receiver?.waitSeconds ?? 25) },
		defaultClassification: String(input.defaultClassification ?? "internal"),
		mappingsDir: resolve(baseDir, String(input.mappingsDir ?? "mappings")),
		storePath: String(input.storePath ?? "/data/hub.sqlite"),
		maxAttempts: Number(input.maxAttempts ?? 20),
		sources,
		clock: { ...(input.clock?.producer ? { producer: { keyFile: String(input.clock.producer.keyFile) } } : {}), schedules },
		...(timers ? { timers } : {}),
		...(watches ? { watches } : {}),
	};
}

export const AGENT_ID = /^agent\/[a-z0-9][a-z0-9._-]{0,48}$/;

function parseTimers(raw: unknown, hasClockProducer: boolean): TimersConfig {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("timers must be an object");
	const input = raw as Record<string, any>;
	if (!hasClockProducer) throw new Error("timers need clock.producer.keyFile (timer events are published as the clock)");
	const agents: string[] = Array.isArray(input.agents) ? input.agents.map(String) : [];
	if (agents.length === 0) throw new Error("timers.agents must list at least one agent id");
	for (const agent of agents) if (!AGENT_ID.test(agent)) throw new Error(`timers.agents: invalid agent id "${agent}"`);
	const topics = new Set(agents.map((agent) => agent.slice("agent/".length).replace(/[^a-z0-9]/g, "_")));
	if (topics.size !== new Set(agents).size) throw new Error("timers.agents: two agents would share one timer topic (hyphens and dots become underscores)");
	const whole = (value: unknown, fallback: number, label: string): number => {
		const number = Number(value ?? fallback);
		if (!Number.isInteger(number) || number < 1) throw new Error(`timers.${label} must be a positive whole number`);
		return number;
	};
	const config: TimersConfig = {
		agents: [...new Set(agents)],
		minDelaySeconds: whole(input.minDelaySeconds, 60, "minDelaySeconds"),
		maxDelaySeconds: whole(input.maxDelaySeconds, 7 * 86_400, "maxDelaySeconds"),
		maxPendingPerAgent: whole(input.maxPendingPerAgent, 20, "maxPendingPerAgent"),
	};
	if (config.minDelaySeconds > config.maxDelaySeconds) throw new Error("timers.minDelaySeconds is larger than maxDelaySeconds");
	return config;
}

function parseWatches(raw: unknown, sources: SourceConfig[]): WatchesConfig {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("watches must be an object");
	const input = raw as Record<string, any>;
	const source = String(input.source ?? "github");
	if (!sources.some((s) => s.name === source && s.mapping && s.producer)) throw new Error(`watches.source "${source}" is not a source with a mapping and a producer`);
	const maxPerAgent = Number(input.maxPerAgent ?? 50);
	if (!Number.isInteger(maxPerAgent) || maxPerAgent < 1) throw new Error("watches.maxPerAgent must be a positive whole number");
	return { source, maxPerAgent };
}

export function loadConfig(path: string): HubConfig {
	return parseConfig(JSON.parse(readFileSync(path, "utf8")), dirname(resolve(path)));
}

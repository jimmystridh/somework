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

export interface HubConfig {
	domain: { url: string; caFile?: string; requireTls: boolean };
	receiver: { url: string; caFile?: string; waitSeconds: number };
	defaultClassification: string;
	mappingsDir: string;
	storePath: string;
	maxAttempts: number;
	sources: SourceConfig[];
	clock: { producer?: ProducerConfig; schedules: ScheduleConfig[] };
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
	return {
		domain: { url: need(input.domain?.url, "domain.url"), ...(input.domain?.caFile ? { caFile: String(input.domain.caFile) } : {}), requireTls: input.domain?.requireTls !== false },
		receiver: { url: need(input.receiver?.url, "receiver.url"), ...(input.receiver?.caFile ? { caFile: String(input.receiver.caFile) } : {}), waitSeconds: Number(input.receiver?.waitSeconds ?? 25) },
		defaultClassification: String(input.defaultClassification ?? "internal"),
		mappingsDir: resolve(baseDir, String(input.mappingsDir ?? "mappings")),
		storePath: String(input.storePath ?? "/data/hub.sqlite"),
		maxAttempts: Number(input.maxAttempts ?? 20),
		sources,
		clock: { ...(input.clock?.producer ? { producer: { keyFile: String(input.clock.producer.keyFile) } } : {}), schedules },
	};
}

export function loadConfig(path: string): HubConfig {
	return parseConfig(JSON.parse(readFileSync(path, "utf8")), dirname(resolve(path)));
}

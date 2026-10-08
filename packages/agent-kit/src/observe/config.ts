import { parseMatcherList, type Matcher } from "./logql.ts";

/**
 * The observe tools (see docs/AGENT_FLEET.md, "Observe tools"): read-only access to the central logs and alert states, for agents that
 * look at their own history or at the rest of the fleet. Off unless a role's profile or `OBSERVE_ENABLED=1` turns it on.
 */
export interface ObserveProfile {
	enabled?: boolean;
	scope?: {
		/** Label matchers (`container=~"somework-reviewer-agent-.*"`) that are added to every query of a role that may only see itself. */
		own?: string[];
		/** True lets the role query every service. */
		fleet?: boolean;
	};
	/** The furthest back a query may reach, in hours (default 24, at most 168). */
	maxRangeHours?: number;
	/** Calls per hour across all observe tools (default 60). */
	hourlyCalls?: number;
	/** The most bytes one answer may carry (default 12288). */
	maxBytes?: number;
	/** Lets `count_over_time` and `rate` over one log stream through. */
	metricFunctions?: boolean;
	/** The Grafana folder `alerts_status` reads (default "Agent Cluster"). */
	alertFolder?: string;
	/** The furthest back a metrics query may reach, in hours (default 720, at most 2160): costs are read over weeks. */
	metricsMaxRangeHours?: number;
}

export interface ResolvedObserve {
	enabled: boolean;
	url?: string;
	tokenFile?: string;
	caFile?: string;
	lokiUid: string;
	promUid: string;
	metricsMaxRangeMs: number;
	fleet: boolean;
	own: Matcher[];
	maxRangeMs: number;
	defaultRangeMs: number;
	hourlyCalls: number;
	maxBytes: number;
	metricFunctions: boolean;
	alertFolder: string;
	timeoutMs: number;
	defaultLines: number;
	maxLines: number;
}

const HOUR = 3_600_000;
export const MAX_RANGE_HOURS = 168;
export const MAX_METRICS_RANGE_HOURS = 2160;

const flag = (value: string | undefined): boolean | undefined => (value === undefined || value === "" ? undefined : value === "1" || value.toLowerCase() === "true");

function whole(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
	const raw = env[name];
	if (raw === undefined || raw === "") return fallback;
	const value = Number(raw);
	if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be a whole number from ${min} to ${max}`);
	return value;
}

/** Profile plus environment. Fails when the tools are on but cannot be made safe (no Grafana address or token, or an own-scope role with no scope). */
export function resolveObserve(profile: ObserveProfile | undefined, env: NodeJS.ProcessEnv = process.env): ResolvedObserve {
	const enabled = flag(env.OBSERVE_ENABLED) ?? profile?.enabled ?? false;
	const scopeSetting = env.OBSERVE_SCOPE;
	if (scopeSetting !== undefined && scopeSetting !== "" && scopeSetting !== "own" && scopeSetting !== "fleet") throw new Error("OBSERVE_SCOPE must be own or fleet");
	const fleet = scopeSetting ? scopeSetting === "fleet" : (profile?.scope?.fleet ?? false);
	const ownText = env.OBSERVE_OWN !== undefined && env.OBSERVE_OWN !== "" ? [env.OBSERVE_OWN] : (profile?.scope?.own ?? []);
	const own = ownText.flatMap((text) => parseMatcherList(text));
	const maxRangeHours = Math.min(MAX_RANGE_HOURS, whole(env, "OBSERVE_MAX_RANGE_HOURS", profile?.maxRangeHours ?? 24, 1, MAX_RANGE_HOURS));
	const resolved: ResolvedObserve = {
		enabled,
		url: env.GRAFANA_URL || undefined,
		tokenFile: env.GRAFANA_TOKEN_FILE || undefined,
		caFile: env.GRAFANA_CA_FILE || undefined,
		lokiUid: env.GRAFANA_LOKI_UID || "cluster-loki",
		promUid: env.GRAFANA_PROM_UID || "cluster-prometheus",
		metricsMaxRangeMs: whole(env, "OBSERVE_METRICS_MAX_RANGE_HOURS", profile?.metricsMaxRangeHours ?? 720, 1, MAX_METRICS_RANGE_HOURS) * HOUR,
		fleet,
		own,
		maxRangeMs: maxRangeHours * HOUR,
		defaultRangeMs: Math.min(HOUR, maxRangeHours * HOUR),
		hourlyCalls: whole(env, "OBSERVE_HOURLY_CALLS", profile?.hourlyCalls ?? 60, 1, 1000),
		maxBytes: whole(env, "OBSERVE_MAX_BYTES", profile?.maxBytes ?? 12_288, 1024, 65_536),
		metricFunctions: flag(env.OBSERVE_METRIC_FUNCTIONS) ?? profile?.metricFunctions ?? false,
		alertFolder: env.GRAFANA_ALERT_FOLDER || profile?.alertFolder || "Agent Cluster",
		timeoutMs: 15_000,
		defaultLines: 100,
		maxLines: 300,
	};
	if (!enabled) return resolved;
	if (!resolved.url) throw new Error("observe: GRAFANA_URL is required when the observe tools are on");
	if (!/^https?:\/\//.test(resolved.url)) throw new Error("observe: GRAFANA_URL must be an http(s) address");
	if (!resolved.tokenFile) throw new Error("observe: GRAFANA_TOKEN_FILE (a read-only Grafana service account token) is required when the observe tools are on");
	if (!fleet && own.length === 0) throw new Error("observe: a role without fleet scope needs its own scope (OBSERVE_OWN, for example container=~\"somework-reviewer-agent-.*\")");
	return resolved;
}

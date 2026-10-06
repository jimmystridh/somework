export const PRIORITIES = ["P1", "P2", "P3", "P4", "P5"] as const;
export type Priority = (typeof PRIORITIES)[number];

/** Datadog sites this role may talk to: the API host is always `api.<site>`. */
export const DATADOG_SITES = ["datadoghq.eu", "datadoghq.com", "us3.datadoghq.com", "us5.datadoghq.com", "ap1.datadoghq.com", "ap2.datadoghq.com", "ddog-gov.com"];

export const HARD_BUDGET_CAP = { maxTokens: 300_000, maxMinutes: 20 };
export const MB = 1024 * 1024;

export interface TriageSettings {
	site: string;
	credentialsFile: string;
	/** Alerts of a lower priority than this are not triaged; an alert without a priority passes. */
	minPriority: Priority;
	/** When set, only these monitors are triaged. */
	monitorIds: string[];
	/** When set, only monitors with one of these tags (`key:value`, lower case) are triaged. */
	tagFilter: string[];
	/** Warn transitions are alerts too unless this is set. */
	ignoreWarn: boolean;
	cooldownMinutes: number;
	dailyCap: number;
	/** How far back from the alert a triage looks. */
	windowMinutes: number;
	budget: { maxTokens: number; maxMinutes: number };
	/** Largest file one save-mode call writes, and the most all of them write for one task. */
	saveFileBytes: number;
	saveTaskBytes: number;
	/** Who gets the one notice per finished triage. */
	notifyTo: string;
	apiBase?: string;
}

const list = (text: string | undefined): string[] => (text === undefined || text.trim() === "" ? [] : text.split(/[\s,]+/).filter(Boolean));

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
	const raw = env[name];
	if (raw === undefined || raw === "") return fallback;
	const value = Number(raw);
	if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
	if (value > max) throw new Error(`${name} must be at most ${max}`);
	return value;
}

/** `P2`, `p2`, `2` or `priority:2` to `P2`; anything else is undefined (an unknown priority is not a reason to ignore an alert). */
export function normalisePriority(value: unknown): Priority | undefined {
	if (typeof value !== "string" && typeof value !== "number") return undefined;
	const match = /^(?:priority:)?p?([1-5])$/i.exec(String(value).trim());
	return match ? (`P${match[1]}` as Priority) : undefined;
}

/** The role's settings from the environment (everything is `DD_*` except the kit's own variables). Fails at startup, not at the first alert. */
export function loadSettings(env: NodeJS.ProcessEnv = process.env): TriageSettings {
	const site = (env.DD_SITE ?? "datadoghq.eu").trim().toLowerCase();
	if (!DATADOG_SITES.includes(site)) throw new Error(`DD_SITE must be one of ${DATADOG_SITES.join(", ")}`);
	const rawPriority = env.DD_MIN_PRIORITY ?? "P3";
	const minPriority = normalisePriority(rawPriority);
	if (!minPriority) throw new Error(`DD_MIN_PRIORITY must be one of ${PRIORITIES.join(", ")}`);
	const monitorIds = list(env.DD_MONITOR_IDS);
	for (const id of monitorIds) if (!/^[0-9]{1,15}$/.test(id)) throw new Error(`DD_MONITOR_IDS holds a value that is not a monitor id: ${id.slice(0, 30)}`);
	const override = env.DD_ALLOW_BASE_OVERRIDE === "1";
	return {
		site,
		credentialsFile: env.DD_CREDENTIALS_FILE ?? "/run/secrets/datadog-keys.json",
		minPriority,
		monitorIds,
		tagFilter: list(env.DD_TAG_FILTER).map((tag) => tag.toLowerCase()),
		ignoreWarn: env.DD_IGNORE_WARN === "1",
		cooldownMinutes: integer(env, "DD_COOLDOWN_MINUTES", 60),
		dailyCap: integer(env, "DD_DAILY_CAP", 20),
		windowMinutes: integer(env, "DD_WINDOW_MINUTES", 60, 360),
		budget: { maxTokens: integer(env, "DD_TRIAGE_BUDGET_TOKENS", 150_000, HARD_BUDGET_CAP.maxTokens), maxMinutes: integer(env, "DD_TRIAGE_BUDGET_MINUTES", 10, HARD_BUDGET_CAP.maxMinutes) },
		saveFileBytes: integer(env, "DD_SAVE_FILE_BYTES", 5 * MB, 5 * MB),
		saveTaskBytes: integer(env, "DD_SAVE_TASK_BYTES", 20 * MB, 20 * MB),
		notifyTo: env.EVENTS_NOTIFY_TO || "agent/manager",
		...(override && env.DD_API_BASE ? { apiBase: env.DD_API_BASE } : {}),
	};
}

/** Environment for `runAgentService`: the kit's own settings filled in from the role's, without overriding what the deployment set. */
export function roleEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	return {
		...env,
		PI_CONCURRENCY: env.PI_CONCURRENCY ?? "1",
		GIT_AUTHOR_NAME: env.GIT_AUTHOR_NAME ?? "SomeWork Datadog triage",
		GIT_AUTHOR_EMAIL: env.GIT_AUTHOR_EMAIL ?? "datadog-triage@somework.invalid",
		BUDGET_MAX_TOKENS_CAP: env.BUDGET_MAX_TOKENS_CAP ?? String(HARD_BUDGET_CAP.maxTokens),
		BUDGET_MAX_MINUTES_CAP: env.BUDGET_MAX_MINUTES_CAP ?? String(HARD_BUDGET_CAP.maxMinutes),
		EVENTS_ENABLED: env.EVENTS_ENABLED ?? "1",
	};
}

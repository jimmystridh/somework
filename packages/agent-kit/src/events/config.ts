import type { ModelRef } from "../providers/allowlist.ts";
import { DEFAULT_EVENTS, type EventsProfile, type ResolvedEvents } from "./types.ts";

const list = (text: string | undefined): string[] | undefined => (text === undefined ? undefined : text.split(/[\s,]+/).filter(Boolean));

function number(env: NodeJS.ProcessEnv, name: string, fallback: number, check: (value: number) => boolean, what: string): number {
	const raw = env[name];
	if (raw === undefined || raw === "") return fallback;
	const value = Number(raw);
	if (!Number.isFinite(value) || !check(value)) throw new Error(`${name} must be ${what}`);
	return value;
}

const positive = (value: number) => value > 0;
const integer = (value: number) => Number.isInteger(value) && value > 0;
const fraction = (value: number) => value > 0 && value <= 1;

function model(text: string | undefined, fallback: ModelRef | undefined): ModelRef | undefined {
	if (!text) return fallback;
	const [provider, ...rest] = text.split("/");
	if (!provider || rest.length === 0) throw new Error("EVENTS_SMALL_MODEL must be provider/model-id");
	return { provider, modelId: rest.join("/") };
}

/** The profile's event settings with the deployment's environment overrides applied (`EVENTS_*`). */
export function resolveEvents(profile: EventsProfile | undefined, env: NodeJS.ProcessEnv = process.env): ResolvedEvents {
	const base = { ...DEFAULT_EVENTS, ...profile };
	const enabled = env.EVENTS_ENABLED === "1" ? true : env.EVENTS_ENABLED === "0" ? false : base.enabled === true;
	const notifyTo = env.EVENTS_NOTIFY_TO || base.notifyTo;
	const resolved: ResolvedEvents = {
		enabled,
		notifyTo,
		controllers: list(env.EVENTS_CONTROLLERS) ?? profile?.controllers ?? [notifyTo],
		fetchHosts: list(env.EVENTS_FETCH_HOSTS) ?? base.fetchHosts,
		accept: list(env.EVENTS_ACCEPT) ?? base.accept,
		timeoutSeconds: number(env, "EVENTS_HANDLER_TIMEOUT_SECONDS", base.timeoutSeconds, positive, "a positive number"),
		memoryMb: number(env, "EVENTS_HANDLER_MEMORY_MB", base.memoryMb, positive, "a positive number"),
		maxOutputBytes: base.maxOutputBytes,
		maxConsecutiveFailures: number(env, "EVENTS_MAX_FAILURES", base.maxConsecutiveFailures, integer, "a positive integer"),
		maxWakesPerHour: number(env, "EVENTS_MAX_WAKES_PER_HOUR", base.maxWakesPerHour, integer, "a positive integer"),
		throttledWakesPerHour: number(env, "EVENTS_THROTTLED_WAKES_PER_HOUR", base.throttledWakesPerHour, integer, "a positive integer"),
		wakeBudget: { maxTokens: number(env, "EVENTS_WAKE_MAX_TOKENS", base.wakeBudget.maxTokens, integer, "a positive integer"), maxMinutes: number(env, "EVENTS_WAKE_MAX_MINUTES", base.wakeBudget.maxMinutes, positive, "a positive number") },
		submitBudgetCap: base.submitBudgetCap,
		tokenShare: number(env, "EVENTS_TOKEN_SHARE", base.tokenShare, fraction, "a number above 0 and at most 1"),
		throttleAt: number(env, "EVENTS_THROTTLE_AT", base.throttleAt, fraction, "a number above 0 and at most 1"),
		staleAfterHours: base.staleAfterHours,
		classificationLevels: base.classificationLevels,
	};
	const weekly = env.EVENTS_WEEKLY_TOKENS === undefined || env.EVENTS_WEEKLY_TOKENS === "" ? base.weeklyTokens : number(env, "EVENTS_WEEKLY_TOKENS", 0, integer, "a positive integer");
	if (weekly !== undefined) resolved.weeklyTokens = weekly;
	const small = model(env.EVENTS_SMALL_MODEL, base.smallModel);
	if (small) resolved.smallModel = small;
	return resolved;
}

/** Profile-level checks that fail at startup instead of at the first event. */
export function validateEventsProfile(id: string, events: EventsProfile | undefined): void {
	if (events === undefined) return;
	if (typeof events !== "object" || events === null) throw new Error(`profile ${id}: events must be an object`);
	if (events.enabled !== undefined && typeof events.enabled !== "boolean") throw new Error(`profile ${id}: events.enabled must be true or false`);
	for (const field of ["timeoutSeconds", "memoryMb", "maxOutputBytes", "maxConsecutiveFailures", "maxWakesPerHour", "throttledWakesPerHour", "staleAfterHours"] as const) {
		const value = events[field];
		if (value !== undefined && !(typeof value === "number" && value > 0)) throw new Error(`profile ${id}: events.${field} must be a positive number`);
	}
	for (const field of ["tokenShare", "throttleAt"] as const) {
		const value = events[field];
		if (value !== undefined && !(typeof value === "number" && value > 0 && value <= 1)) throw new Error(`profile ${id}: events.${field} must be above 0 and at most 1`);
	}
	if (events.weeklyTokens !== undefined && !(typeof events.weeklyTokens === "number" && events.weeklyTokens > 0)) throw new Error(`profile ${id}: events.weeklyTokens must be a positive number`);
	for (const field of ["controllers", "fetchHosts", "accept", "classificationLevels"] as const) {
		const value = events[field];
		if (value !== undefined && !(Array.isArray(value) && value.every((entry) => typeof entry === "string"))) throw new Error(`profile ${id}: events.${field} must be a list of strings`);
	}
	if (events.smallModel !== undefined && !(typeof events.smallModel.provider === "string" && typeof events.smallModel.modelId === "string")) throw new Error(`profile ${id}: events.smallModel must be {provider, modelId}`);
}

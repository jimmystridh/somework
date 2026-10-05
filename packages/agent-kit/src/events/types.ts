import type { Budget } from "../runtime.ts";
import type { ModelRef } from "../providers/allowlist.ts";

/** What a role may configure about events. Nothing happens unless `enabled` is true. */
export interface EventsProfile {
	enabled?: boolean;
	/** The cheaper model used for `tier: "small"` and while the events pool is throttled. */
	smallModel?: ModelRef;
	/** Who `notify` decisions and owner notices go to. Default `agent/manager`. */
	notifyTo?: string;
	/** Who may send control messages (disable or enable handlers). Default: `notifyTo`. */
	controllers?: string[];
	/** Hosts the handler kit's `fetchJson`/`fetchText` may call. Default none. */
	fetchHosts?: string[];
	/** Extra domain event types (globs) delivered to handlers, besides published topics. */
	accept?: string[];
	/** Wall-clock seconds per handler run. Default 10. */
	timeoutSeconds?: number;
	/** Memory cap of a handler run. Default 128. */
	memoryMb?: number;
	/** Cap on a handler's output. Default 64 KiB. */
	maxOutputBytes?: number;
	/** Consecutive errors or timeouts that disable a handler. Default 5. */
	maxConsecutiveFailures?: number;
	/** Wakes per hour and handler above which the handler is disabled. Default 20. */
	maxWakesPerHour?: number;
	/** Wakes per hour for the whole agent while the events pool is throttled. Default 5. */
	throttledWakesPerHour?: number;
	/** Budget of one woken run and the cap on a `submit` decision's budget. */
	wakeBudget?: Budget;
	submitBudgetCap?: Budget;
	/** Share of the daily token limit for event-driven runs. Default 0.3. */
	tokenShare?: number;
	/** Optional cap per week for event-driven runs. */
	weeklyTokens?: number;
	/** Fraction of the events pool at which the agent is throttled. Default 0.8. */
	throttleAt?: number;
	/** Events older than this are recorded but never woken on. Default 24. */
	staleAfterHours?: number;
	/** Classification levels from lowest to highest; a rewrite may keep or lower a level that is on this list. */
	classificationLevels?: string[];
}

export interface ResolvedEvents {
	enabled: boolean;
	smallModel?: ModelRef;
	notifyTo: string;
	controllers: string[];
	fetchHosts: string[];
	accept: string[];
	timeoutSeconds: number;
	memoryMb: number;
	maxOutputBytes: number;
	maxConsecutiveFailures: number;
	maxWakesPerHour: number;
	throttledWakesPerHour: number;
	wakeBudget: Budget;
	submitBudgetCap: Budget;
	tokenShare: number;
	weeklyTokens?: number;
	throttleAt: number;
	staleAfterHours: number;
	classificationLevels: string[];
}

export const DEFAULT_EVENTS: Omit<ResolvedEvents, "smallModel" | "weeklyTokens"> = {
	enabled: false,
	notifyTo: "agent/manager",
	controllers: ["agent/manager"],
	fetchHosts: [],
	accept: [],
	timeoutSeconds: 10,
	memoryMb: 128,
	maxOutputBytes: 64 * 1024,
	maxConsecutiveFailures: 5,
	maxWakesPerHour: 20,
	throttledWakesPerHour: 5,
	wakeBudget: { maxTokens: 100_000, maxMinutes: 10 },
	submitBudgetCap: { maxTokens: 200_000, maxMinutes: 20 },
	tokenShare: 0.3,
	throttleAt: 0.8,
	staleAfterHours: 24,
	classificationLevels: ["public", "internal", "confidential", "secret"],
};

/** A domain event as the feed returns it (`GET /v1/events`). */
export interface FeedEvent {
	seq: number;
	eventId: string;
	type: string;
	wake?: boolean;
	payload?: Record<string, any>;
	createdAt?: string;
}

/** The event a handler sees. Everything in `data` came from outside and is untrusted text. */
export interface HandlerEvent {
	id: string;
	seq: number;
	topic: string;
	source: string;
	key: string;
	data: unknown;
	classification: string;
	verified: boolean;
	depth: number;
	causedByTask?: string;
	publishedBy?: string;
	receivedAt?: string;
	untrusted: true;
}

export interface HandlerInput {
	event: HandlerEvent;
	agent: { id: string; role: string; capabilities: { id: string; version: string }[] };
	now: string;
}

export type DecisionAction = "drop" | "deliver" | "wake" | "submit" | "notify" | "rewrite";

export interface Decision {
	action: DecisionAction;
	tier?: "default" | "small";
	reason?: string;
	prompt?: string;
	event?: { topic?: string; data?: unknown; classification?: string };
	task?: { capability: { id: string; version: string }; input: Record<string, unknown>; budget?: Budget };
	message?: string;
}

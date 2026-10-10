import type { Budget } from "../runtime.ts";

export const DEFAULT_APPROVERS = ["agent/manager", "kind:human"];

/** What a role may tune about conversations; everything has a default, and the deployment's environment overrides it. */
export interface ThreadsConfig {
	/** `off` turns the agent's reading of messages off (it takes no part in conversations). */
	mode?: "on" | "off";
	/** Who may decide an approval: principal ids or `kind:<kind>`. The question goes to whoever's message started the work if they are one of these, else to the first named id. */
	approvers?: string[];
	/** How many conversations the agent keeps going at the same moment (default 4). */
	maxConversations?: number;
	/** A message that arrives later than this after it was sent counts as backlog and waits its turn (default 120 seconds). */
	liveWindowSeconds?: number;
	/** What one model run in a conversation, and one job, may use unless it asks for less. The role's own limits still apply. */
	runBudget?: Budget;
	hardTokenCap?: number;
	approvalMinutes?: number;
	/** Seconds after which a message that has not been taken up says so (default 20). */
	busyAfterSeconds?: number;
	/** Share of the daily token limit for the `chat` pool and the fraction of it at which runs get half the cap. */
	share?: number;
	throttleAt?: number;
	historyMessages?: number;
	messageChars?: number;
	replyMaxBytes?: number;
}

export interface ThreadSettings {
	enabled: boolean;
	approvers: string[];
	maxConversations: number;
	liveWindowMs: number;
	runBudget: Budget;
	hardTokenCap: number;
	approvalMinutes: number;
	busyAfterSeconds: number;
	share: number;
	throttleAt: number;
	historyMessages: number;
	messageChars: number;
	replyMaxBytes: number;
}

export const DEFAULT_THREAD_SETTINGS: ThreadSettings = {
	enabled: true,
	approvers: DEFAULT_APPROVERS,
	maxConversations: 4,
	liveWindowMs: 120_000,
	runBudget: { maxTokens: 150_000, maxMinutes: 15 },
	hardTokenCap: 200_000,
	approvalMinutes: 10,
	busyAfterSeconds: 20,
	share: 0.1,
	throttleAt: 0.8,
	historyMessages: 10,
	messageChars: 600,
	replyMaxBytes: 4096,
};

const list = (text: string | undefined): string[] | undefined => (text === undefined || text.trim() === "" ? undefined : text.split(/[\s,]+/).filter(Boolean));

function positive(env: NodeJS.ProcessEnv, name: string, fallback: number, whole = false): number {
	const raw = env[name];
	if (raw === undefined || raw === "") return fallback;
	const value = Number(raw);
	if (!Number.isFinite(value) || value <= 0 || (whole && !Number.isInteger(value))) throw new Error(`${name} must be a positive ${whole ? "integer" : "number"}`);
	return value;
}

/** The role's settings with the deployment's environment applied. */
export function resolveThreadSettings(config: ThreadsConfig | undefined, env: NodeJS.ProcessEnv = process.env): ThreadSettings {
	const defaults = DEFAULT_THREAD_SETTINGS;
	const hard = positive(env, "CHAT_HARD_TOKEN_CAP", config?.hardTokenCap ?? defaults.hardTokenCap, true);
	const mode = env.CHAT_MODE === "off" ? "off" : (config?.mode ?? "on");
	const settings: ThreadSettings = {
		enabled: mode !== "off",
		approvers: list(env.APPROVERS) ?? config?.approvers ?? defaults.approvers,
		maxConversations: positive(env, "THREADS_MAX_CONVERSATIONS", config?.maxConversations ?? defaults.maxConversations, true),
		liveWindowMs: positive(env, "THREADS_LIVE_WINDOW_SECONDS", config?.liveWindowSeconds ?? defaults.liveWindowMs / 1000) * 1000,
		runBudget: {
			maxTokens: Math.min(positive(env, "CHAT_INSTRUCT_TOKENS", config?.runBudget?.maxTokens ?? defaults.runBudget.maxTokens, true), hard),
			maxMinutes: positive(env, "CHAT_INSTRUCT_MINUTES", config?.runBudget?.maxMinutes ?? defaults.runBudget.maxMinutes),
		},
		hardTokenCap: hard,
		approvalMinutes: positive(env, "CHAT_APPROVAL_MINUTES", config?.approvalMinutes ?? defaults.approvalMinutes),
		busyAfterSeconds: positive(env, "CHAT_BUSY_AFTER_SECONDS", config?.busyAfterSeconds ?? defaults.busyAfterSeconds),
		share: positive(env, "CHAT_TOKEN_SHARE", config?.share ?? defaults.share),
		throttleAt: positive(env, "CHAT_THROTTLE_AT", config?.throttleAt ?? defaults.throttleAt),
		historyMessages: Math.min(config?.historyMessages ?? defaults.historyMessages, 30),
		messageChars: Math.min(config?.messageChars ?? defaults.messageChars, 4000),
		replyMaxBytes: Math.min(config?.replyMaxBytes ?? defaults.replyMaxBytes, 8192),
	};
	if (settings.share > 1 || settings.throttleAt > 1) throw new Error("CHAT_TOKEN_SHARE and CHAT_THROTTLE_AT must be at most 1");
	return settings;
}

/** Whether `sender` is named by an entry: an exact principal id, or `kind:<kind>` for every principal of a kind. */
export function senderMatches(entries: readonly string[], sender: { kind: string; id: string }): boolean {
	return entries.some((entry) => (entry.startsWith("kind:") ? entry.slice(5).toLowerCase() === sender.kind.toLowerCase() : entry === sender.id));
}

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type Pool = "tasks" | "events" | "chat";
export type PoolState = "ok" | "throttled" | "stopped";

export interface EventPoolOptions {
	/** Share of the daily limit that event-driven runs may use. */
	share: number;
	/** Optional cap per ISO week for event-driven runs. */
	weeklyTokens?: number;
	/** Fraction of the events pool at which the agent is throttled. */
	throttleAt?: number;
}

export interface ChatPoolOptions {
	/** Share of the daily limit that model-answered chat may use. */
	share: number;
	/** Fraction of the chat pool at which chat is throttled. */
	throttleAt?: number;
}

export interface PoolUsage {
	/** `remaining` is what a task may still start with: the daily limit minus the tasks' spend and the events' and the chat's, which come off the same day. */
	tasks: { used: number; limit: number; remaining: number };
	events: { used: number; limit: number; weeklyUsed?: number; weeklyLimit?: number; throttled: boolean; stopped: boolean };
	/** Present only when the role answers chat with a model. */
	chat?: { used: number; limit: number; throttled: boolean; stopped: boolean };
	/** Tokens the owner added to each pool for today; the limits above already include them. Present only on a day with a raise. */
	raisedToday?: Record<Pool, number>;
}

interface LedgerState {
	date: string;
	tokens: number;
	events?: number;
	chat?: number;
	week?: string;
	weekEvents?: number;
	notices?: string[];
	/** Raises the owner granted for this day only: a new day starts without them. */
	bonus?: Partial<Record<Pool, number>>;
}

export const isoWeek = (date: string): string => {
	const day = new Date(`${date}T00:00:00Z`);
	day.setUTCDate(day.getUTCDate() + 4 - (day.getUTCDay() || 7));
	const week = Math.ceil(((day.getTime() - Date.UTC(day.getUTCFullYear(), 0, 1)) / 86_400_000 + 1) / 7);
	return `${day.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
};

/**
 * Daily token spend, persisted so a restart does not reset the cap. Two pools share the daily limit: `tasks` (what requesters submit) and
 * `events` (runs started by events, capped at a share of the limit); a role that answers chat with a model has a third, `chat`, with its own
 * share. A pool's spend never exceeds its share, so none of them can take more than that share away from tasks. Without event pool options the ledger behaves exactly as the plain daily ledger.
 */
export class DailyLedger {
	readonly #path: string;
	#limit: number;
	readonly #today: () => string;
	readonly #events: EventPoolOptions | undefined;
	readonly #chat: ChatPoolOptions | undefined;

	constructor(path: string, dailyTokenLimit: number, today: () => string = () => new Date().toISOString().slice(0, 10), events?: EventPoolOptions, chat?: ChatPoolOptions) {
		this.#path = path;
		this.#limit = dailyTokenLimit;
		this.#today = today;
		this.#events = events && events.share > 0 ? events : undefined;
		this.#chat = chat && chat.share > 0 ? chat : undefined;
		mkdirSync(dirname(path), { recursive: true });
	}

	/** Fleet limits change the daily limit while the agent runs; what was spent today stays. */
	setDailyTokenLimit(dailyTokenLimit: number): void {
		this.#limit = dailyTokenLimit;
	}

	#read(): LedgerState {
		const today = this.#today();
		let state: LedgerState = { date: today, tokens: 0 };
		try {
			const stored = JSON.parse(readFileSync(this.#path, "utf8")) as LedgerState;
			if (stored.date === today) state = stored;
			else if (stored.week === isoWeek(today)) state = { date: today, tokens: 0, week: stored.week, weekEvents: stored.weekEvents };
		} catch {
			// no ledger yet, or a new day
		}
		const week = isoWeek(today);
		if (state.week !== week) {
			state.week = week;
			state.weekEvents = 0;
		}
		return state;
	}

	#write(state: LedgerState): void {
		writeFileSync(`${this.#path}.tmp`, JSON.stringify(state));
		renameSync(`${this.#path}.tmp`, this.#path);
	}

	#raised(state: LedgerState, pool: Pool): number {
		return state.bonus?.[pool] ?? 0;
	}

	/** The daily limit including today's raise. */
	get dailyLimit(): number {
		return this.#limit + this.#raised(this.#read(), "tasks");
	}

	get eventsLimit(): number {
		return this.#events ? Math.floor(this.#limit * Math.min(this.#events.share, 1)) + this.#raised(this.#read(), "events") : 0;
	}

	/** Tokens spent today by requester tasks. */
	spent(): number {
		return this.#read().tokens;
	}

	get chatLimit(): number {
		return this.#chat ? Math.floor(this.#limit * Math.min(this.#chat.share, 1)) + this.#raised(this.#read(), "chat") : 0;
	}

	/** What a requester task may still use today: event and chat spend (each up to its share) comes off the daily limit, so tasks keep at least the rest. */
	remaining(): number {
		const state = this.#read();
		const events = this.#events ? Math.min(state.events ?? 0, this.eventsLimit) : 0;
		const chat = this.#chat ? Math.min(state.chat ?? 0, this.chatLimit) : 0;
		return Math.max(0, this.#limit + this.#raised(state, "tasks") - state.tokens - events - chat);
	}

	/** What chat answers may still use today. */
	chatRemaining(): number {
		if (!this.#chat) return 0;
		return Math.max(0, this.chatLimit - (this.#read().chat ?? 0));
	}

	chatState(): PoolState {
		if (!this.#chat) return "ok";
		const used = this.#read().chat ?? 0;
		if (used >= this.chatLimit) return "stopped";
		if (used >= this.chatLimit * (this.#chat.throttleAt ?? 0.8)) return "throttled";
		return "ok";
	}

	/** What event-driven runs may still use today (and this week, when a weekly cap is set). */
	eventsRemaining(): number {
		if (!this.#events) return 0;
		const state = this.#read();
		const daily = Math.max(0, this.eventsLimit - (state.events ?? 0));
		const weekly = this.#events.weeklyTokens === undefined ? Number.POSITIVE_INFINITY : Math.max(0, this.#events.weeklyTokens + this.#raised(state, "events") - (state.weekEvents ?? 0));
		return Math.min(daily, weekly);
	}

	eventsState(): PoolState {
		if (!this.#events) return "ok";
		const state = this.#read();
		const used = state.events ?? 0;
		const weeklyStopped = this.#events.weeklyTokens !== undefined && (state.weekEvents ?? 0) >= this.#events.weeklyTokens + this.#raised(state, "events");
		if (used >= this.eventsLimit || weeklyStopped) return "stopped";
		if (used >= this.eventsLimit * (this.#events.throttleAt ?? 0.8)) return "throttled";
		return "ok";
	}

	record(tokens: number, pool: Pool = "tasks"): void {
		const state = this.#read();
		const amount = Math.max(0, Math.round(tokens));
		if (pool === "events") {
			state.events = (state.events ?? 0) + amount;
			state.weekEvents = (state.weekEvents ?? 0) + amount;
		} else if (pool === "chat") {
			state.chat = (state.chat ?? 0) + amount;
		} else {
			state.tokens += amount;
		}
		this.#write(state);
	}

	/**
	 * Adds `tokens` to a pool's limit for today (`tasks` is the whole daily limit, `events` and `chat` their own pools) and returns what is raised and the new limit.
	 * The sum raised in one day stays within `ceiling`, and a pool the role does not have cannot be raised. Nothing carries over to tomorrow.
	 */
	raise(pool: Pool, tokens: number, ceiling: number): { pool: Pool; raisedToday: number; limit: number } {
		if (!Number.isInteger(tokens) || tokens <= 0) throw new RangeError("the raise must be a positive whole number of tokens");
		if (pool === "events" && !this.#events) throw new RangeError("this agent has no events pool");
		if (pool === "chat" && !this.#chat) throw new RangeError("this agent has no chat pool");
		const state = this.#read();
		const raisedToday = this.#raised(state, pool) + tokens;
		if (raisedToday > ceiling) throw new RangeError(`a pool can be raised by at most ${ceiling} tokens per day, and ${this.#raised(state, pool)} are raised already`);
		state.bonus = { ...state.bonus, [pool]: raisedToday };
		this.#write(state);
		return { pool, raisedToday, limit: pool === "tasks" ? this.dailyLimit : pool === "events" ? this.eventsLimit : this.chatLimit };
	}

	/** True the first time it is called for `key` today; used for "tell the owner once a day". */
	firstNoticeToday(key: string): boolean {
		const state = this.#read();
		if (state.notices?.includes(key)) return false;
		state.notices = [...(state.notices ?? []), key];
		this.#write(state);
		return true;
	}

	usage(): PoolUsage {
		const state = this.#read();
		const events = this.eventsState();
		const chat = this.chatState();
		return {
			tasks: { used: state.tokens, limit: this.#limit + this.#raised(state, "tasks"), remaining: this.remaining() },
			events: {
				used: state.events ?? 0,
				limit: this.eventsLimit,
				...(this.#events?.weeklyTokens === undefined ? {} : { weeklyUsed: state.weekEvents ?? 0, weeklyLimit: this.#events.weeklyTokens + this.#raised(state, "events") }),
				throttled: events === "throttled",
				stopped: events === "stopped",
			},
			...(this.#chat ? { chat: { used: state.chat ?? 0, limit: this.chatLimit, throttled: chat === "throttled", stopped: chat === "stopped" } } : {}),
			...(state.bonus ? { raisedToday: { tasks: this.#raised(state, "tasks"), events: this.#raised(state, "events"), chat: this.#raised(state, "chat") } } : {}),
		};
	}
}

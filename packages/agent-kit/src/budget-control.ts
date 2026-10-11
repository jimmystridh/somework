import type { InboundMessage } from "./threads/message.ts";
import type { Log } from "./log.ts";
import type { DailyLedger, Pool } from "./ledger.ts";

/** A message carrying this label asks the agent to raise one of its token pools for today. Value: raise. */
export const BUDGET_LABEL = "budgetControl";
export const BUDGET_POOL_LABEL = "budgetPool";
export const BUDGET_TOKENS_LABEL = "budgetTokens";
export const BUDGET_REASON_LABEL = "budgetReason";

const POOLS: readonly Pool[] = ["tasks", "events", "chat"];

export interface BudgetControlOptions {
	ledger: DailyLedger;
	/** Senders allowed to raise the budget (the manager, which asks its owner first). Anyone else is logged and ignored. */
	controllers: readonly string[];
	/** The most tokens one pool can be raised by in one day, over all raises. A function is read on every request (fleet limits can change it). */
	ceiling: number | (() => number);
	/** Tells the sender what happened; a failure to send is only logged. */
	reply: (message: InboundMessage, text: string) => Promise<void>;
	log: Log;
}

/**
 * The owner's way to give an agent more tokens today, carried by an ordinary direct message like the event kill switch. The raise lasts until
 * the day rolls over and is capped per pool and day, so a mistaken or repeated request cannot grow a budget without bound. The sender is told the result.
 * Returns true when the message was a budget message (it then gets no chat notice).
 */
export function createBudgetIntercept(options: BudgetControlOptions): (message: InboundMessage) => Promise<boolean> {
	return async (message) => {
		const action = message.labels?.[BUDGET_LABEL];
		if (action === undefined) return false;
		const say = (text: string) => options.reply(message, text).catch((error: unknown) => options.log("warn", "budget_reply_failed", { to: message.sender.id, error: String(error).slice(0, 160) }));
		if (!options.controllers.includes(message.sender.id)) {
			options.log("warn", "budget_control_refused", { from: message.sender.id, reason: "sender is not a controller" });
			return true;
		}
		const pool = message.labels?.[BUDGET_POOL_LABEL] as Pool | undefined;
		const tokens = Number(message.labels?.[BUDGET_TOKENS_LABEL]);
		if (action !== "raise" || !pool || !POOLS.includes(pool)) {
			options.log("warn", "budget_control_refused", { from: message.sender.id, action, reason: "unknown action or pool" });
			await say("Budget not changed: the action must be raise and the pool tasks, events or chat.");
			return true;
		}
		try {
			const result = options.ledger.raise(pool, tokens, typeof options.ceiling === "function" ? options.ceiling() : options.ceiling);
			options.log("info", "budget_raised", { from: message.sender.id, pool, tokens, raisedToday: result.raisedToday, limit: result.limit, reason: message.labels?.[BUDGET_REASON_LABEL]?.slice(0, 200) });
			await say(`Budget raised: the ${pool} pool gets ${tokens} more tokens today (${result.raisedToday} raised today, limit now ${result.limit}). It goes back to normal tomorrow.`);
		} catch (error) {
			const why = error instanceof RangeError ? error.message : "the ledger could not be written";
			options.log("warn", "budget_control_failed", { from: message.sender.id, pool, tokens, error: why });
			await say(`Budget not changed: ${why}.`);
		}
		return true;
	};
}

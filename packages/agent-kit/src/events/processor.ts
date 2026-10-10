import type { DailyLedger } from "../ledger.ts";
import type { Log } from "../log.ts";
import type { Metrics } from "../metrics.ts";
import { applyRewrite, parseDecision } from "./decision.ts";
import { globMatch } from "./glob.ts";
import { toHandlerEvent } from "./event.ts";
import type { HandlerGuard } from "./guard.ts";
import type { EventInbox } from "./inbox.ts";
import { redactText } from "./redact.ts";
import type { HandlerRunner } from "./runner.ts";
import type { HandlerStore } from "./store.ts";
import type { Decision, FeedEvent, HandlerEvent, ResolvedEvents } from "./types.ts";

/** What a decision can make happen. The kit implements these under the agent's normal policy and budgets. */
export interface EventActions {
	/** Runs the agent on the event; resolves with the tokens it used. */
	wake(event: HandlerEvent, options: { tier: "default" | "small"; note?: string }): Promise<{ tokens: number; answer?: string }>;
	submit(event: HandlerEvent, task: NonNullable<Decision["task"]>): Promise<{ jobId: string }>;
	notify(text: string): Promise<void>;
}

export interface ProcessorDeps {
	config: ResolvedEvents;
	store: HandlerStore;
	runner: Pick<HandlerRunner, "run">;
	guard: HandlerGuard;
	ledger: DailyLedger;
	inbox: EventInbox;
	actions: EventActions;
	agent: { id: string; role: string; capabilities: { id: string; version: string }[] };
	log: Log;
	metrics: Metrics;
	now?: () => number;
}

export type Outcome = "ignored" | "recorded" | "stale" | "dropped" | "delivered" | "woken" | "submitted" | "notified" | "suppressed";

const MAX_REWRITES = 8;
const HOUR_MS = 3_600_000;
const clip = (text: string, max = 200): string => redactText(text).slice(0, max);

/**
 * Decides what happens to one event for this agent. Handlers whose topics match run in name order; a rewrite hands the changed event
 * to the next handler, any other decision ends the chain. With no handler for the topic the agent is woken (it subscribed with wake).
 * Anything that goes wrong in a handler delivers the event to the inbox without waking the agent: events are never lost to a bug in
 * code the agent wrote.
 */
export class EventProcessor {
	readonly #d: ProcessorDeps;
	readonly #counted: (labels: { result: string }) => void;
	readonly #runs: (labels: { handler: string; result: string }) => void;
	readonly #wakeTimes: number[] = [];

	constructor(deps: ProcessorDeps) {
		this.#d = deps;
		this.#counted = deps.metrics.counter("somework_events_total", "Events handled by this agent, by outcome");
		this.#runs = deps.metrics.counter("somework_handler_runs_total", "Event handler runs, by handler and result");
	}

	async process(feed: FeedEvent): Promise<Outcome> {
		const { config, log } = this.#d;
		const event = toHandlerEvent(feed, config.accept);
		if (!event) return "ignored";
		log("info", "event_received", { eventId: event.id, topic: event.topic, source: event.source, depth: event.depth, wake: feed.wake === true });
		const done = (outcome: Outcome): Outcome => {
			this.#counted({ result: outcome });
			return outcome;
		};
		if (feed.wake !== true) {
			this.#d.inbox.add(event, "delivered without wake");
			return done("recorded");
		}
		const age = event.receivedAt ? this.#nowMs() - Date.parse(event.receivedAt) : 0;
		if (Number.isFinite(age) && age > config.staleAfterHours * HOUR_MS) {
			this.#d.inbox.add(event, `older than ${config.staleAfterHours} h`);
			return done("stale");
		}
		const chain = await this.#chain(event);
		return done(await this.#execute(chain.decision, chain.event, chain.handler));
	}

	#nowMs(): number {
		return (this.#d.now ?? Date.now)();
	}

	async #chain(start: HandlerEvent): Promise<{ decision: Decision; event: HandlerEvent; handler: string }> {
		const { store, runner, guard, config, log, agent } = this.#d;
		const matching = store.list().filter((info) => info.topics.some((pattern) => globMatch(pattern, start.topic)));
		if (matching.length === 0) return { decision: { action: "wake", reason: "no handler for this topic" }, event: start, handler: "(default)" };
		let event = start;
		let ran = 0;
		let lastHandler = "(default)";
		for (const info of matching) {
			const off = store.disabled(info.name);
			if (off) {
				log("info", "handler_skipped", { handler: info.name, reason: off.reason, by: off.by });
				continue;
			}
			const current = store.current(info.name);
			if (!current) continue;
			lastHandler = info.name;
			const result = await runner.run({ name: info.name, hash: current.hash, source: current.source }, { event, agent, now: new Date(this.#nowMs()).toISOString() });
			ran += 1;
			const failed = (kind: string, message: string): { decision: Decision; event: HandlerEvent; handler: string } => {
				this.#runs({ handler: info.name, result: kind });
				const switchedOff = guard.failure(info.name, message);
				log("warn", "handler_error", { handler: info.name, version: current.hash.slice(0, 12), eventId: event.id, kind, error: clip(message) });
				if (switchedOff) void this.#switchedOff(info.name, switchedOff);
				return { decision: { action: "deliver", reason: `handler ${info.name} failed (${kind}): delivered without waking` }, event, handler: info.name };
			};
			if (!result.ok) return failed(result.kind, `${result.message}${result.stderr ? ` | ${result.stderr}` : ""}`);
			const parsed = parseDecision(result.decision, event, { submitBudgetCap: config.submitBudgetCap, classificationLevels: config.classificationLevels });
			if (!parsed.ok) return failed("invalid", `invalid decision: ${parsed.error}`);
			guard.success(info.name);
			this.#runs({ handler: info.name, result: parsed.decision.action });
			log("info", "handler_decision", { handler: info.name, version: current.hash.slice(0, 12), eventId: event.id, action: parsed.decision.action, tier: parsed.decision.tier, reason: parsed.decision.reason ? clip(parsed.decision.reason) : undefined, ms: result.ms });
			if (parsed.decision.action === "rewrite") {
				event = applyRewrite(event, parsed.decision.event!);
				if (ran >= MAX_REWRITES) break;
				continue;
			}
			return { decision: parsed.decision, event, handler: info.name };
		}
		if (ran === 0) return { decision: { action: "deliver", reason: "every handler for this topic is switched off: delivered without waking" }, event, handler: lastHandler };
		return { decision: { action: "wake", reason: "handlers only rewrote the event" }, event, handler: lastHandler };
	}

	async #switchedOff(handler: string, reason: string): Promise<void> {
		this.#d.log("warn", "handler_disabled", { handler, reason: clip(reason) });
		await this.#d.actions.notify(`Event handler "${handler}" of ${this.#d.agent.id} was switched off automatically: ${clip(reason, 300)}. Events it covers are now delivered to the inbox without waking the agent until it is enabled again.`).catch((error) => this.#d.log("warn", "notify_failed", { error: clip(String(error)) }));
	}

	async #execute(decision: Decision, event: HandlerEvent, handler: string): Promise<Outcome> {
		const { inbox, guard, actions, log } = this.#d;
		switch (decision.action) {
			case "drop": {
				const reason = decision.reason ?? "dropped by handler";
				guard.drop(handler, { topic: event.topic, key: event.key, reason: clip(reason, 120) });
				log("info", "event_dropped", { eventId: event.id, topic: event.topic, handler, reason: clip(reason, 120) });
				return "dropped";
			}
			case "deliver":
			case "rewrite":
				inbox.add(event, decision.reason ?? "delivered by handler", handler);
				return "delivered";
			case "notify":
				try {
					await actions.notify(`${decision.message ?? ""}\n(event ${event.topic}, key ${event.key}, from ${this.#d.agent.id})`.trim());
					return "notified";
				} catch (error) {
					log("warn", "notify_failed", { eventId: event.id, error: clip(String(error)) });
					inbox.add(event, "notify failed", handler);
					return "delivered";
				}
			case "submit":
				try {
					const submitted = await actions.submit(event, decision.task!);
					log("info", "event_job_started", { eventId: event.id, topic: event.topic, handler, capability: decision.task!.capability.id, jobId: submitted.jobId });
					return "submitted";
				} catch (error) {
					log("warn", "event_submit_failed", { eventId: event.id, handler, error: clip(String(error)) });
					inbox.add(event, `task submission failed: ${clip(String(error), 120)}`, handler);
					return "delivered";
				}
			case "wake":
				return this.#wake(decision, event, handler);
		}
	}

	async #wake(decision: Decision, event: HandlerEvent, handler: string): Promise<Outcome> {
		const { ledger, guard, actions, inbox, config, log } = this.#d;
		const state = ledger.eventsState();
		if (state === "stopped") {
			inbox.add(event, "the events token pool is used up: recorded without waking", handler);
			log("warn", "event_wake_suppressed", { eventId: event.id, handler, reason: "pool_stopped" });
			if (ledger.firstNoticeToday("events-stopped")) await this.#poolNotice("used up: events are recorded but no longer wake the agent until the pool resets");
			return "suppressed";
		}
		let tier = decision.tier ?? "default";
		if (state === "throttled") {
			tier = "small";
			const now = this.#nowMs();
			while (this.#wakeTimes.length > 0 && now - this.#wakeTimes[0]! >= HOUR_MS) this.#wakeTimes.shift();
			if (this.#wakeTimes.length >= config.throttledWakesPerHour) {
				inbox.add(event, "the events token pool is nearly used up: wake rate limited", handler);
				log("warn", "event_wake_suppressed", { eventId: event.id, handler, reason: "throttled" });
				return "suppressed";
			}
			if (ledger.firstNoticeToday("events-throttled")) await this.#poolNotice(`at ${Math.round(config.throttleAt * 100)} percent: wakes use the cheaper model and are rate limited`);
		}
		if (handler !== "(default)") {
			const switchedOff = guard.wake(handler);
			if (switchedOff) {
				void this.#switchedOff(handler, switchedOff);
				inbox.add(event, `handler ${handler} switched off: ${switchedOff}`, handler);
				return "delivered";
			}
		}
		this.#wakeTimes.push(this.#nowMs());
		const used = await actions.wake(event, { tier, ...(decision.prompt ? { note: decision.prompt } : {}) }).catch((error) => {
			log("warn", "event_wake_failed", { eventId: event.id, handler, error: clip(String(error)) });
			inbox.add(event, `wake failed: ${clip(String(error), 120)}`, handler);
			return undefined;
		});
		if (!used) return "delivered";
		ledger.record(used.tokens, "events");
		if (used.answer?.trim()) await actions.notify(`${this.#d.agent.id} handled ${event.topic} (${event.key}):\n${used.answer.trim().slice(0, 1500)}`).catch(() => undefined);
		if (ledger.eventsState() === "stopped" && ledger.firstNoticeToday("events-stopped")) await this.#poolNotice("used up: events are recorded but no longer wake the agent until the pool resets");
		return "woken";
	}

	async #poolNotice(what: string): Promise<void> {
		await this.#d.actions.notify(`The events token pool of ${this.#d.agent.id} is ${what}.`).catch((error) => this.#d.log("warn", "notify_failed", { error: clip(String(error)) }));
	}
}

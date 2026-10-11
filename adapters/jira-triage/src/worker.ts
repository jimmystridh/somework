import { silent, type AgentOutcome, type AgentRequest, type AgentRuntime, type Log, type RunHooks } from "@somework/agent-kit";
import type { TriageEngine } from "./engine.ts";
import { NO_SHELL } from "./profile.ts";

export interface Worker {
	stop(): void;
	/** One look at the queue now (tests, and the first look after a start). */
	pass(): Promise<number>;
}

/**
 * The clock of the triage: every `intervalMs` the engine looks at the tickets whose time has come (a retry after an outage, an answer that may have
 * arrived, a deadline). Passes never overlap, and a pass that fails is logged and tried again at the next beat.
 */
export function startWorker(options: { engine: TriageEngine; intervalMs: number; log?: Log }): Worker {
	const log = options.log ?? silent;
	let running = false;
	let stopped = false;
	const pass = async (): Promise<number> => {
		if (running || stopped) return 0;
		running = true;
		try {
			const outcomes = await options.engine.tick();
			return outcomes.length;
		} catch (error) {
			log("error", "jira_triage_tick_failed", { error: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200) });
			return 0;
		} finally {
			running = false;
		}
	};
	const revived = options.engine.recover();
	if (revived > 0) log("info", "jira_triage_recovered", { tickets: revived });
	const timer = setInterval(() => void pass(), options.intervalMs);
	timer.unref();
	void pass();
	return { stop: () => (stopped = true, clearInterval(timer)), pass };
}

/** Every approval request of a model run is refused: this agent's model has the ticket tools and no shell, and nobody answers for a run that nobody asked for. */
export class RefusingRuntime implements AgentRuntime {
	readonly #inner: AgentRuntime;
	constructor(inner: AgentRuntime) {
		this.#inner = inner;
	}
	start(): Promise<void> {
		return this.#inner.start();
	}
	health(): { ready: boolean; reason?: string } {
		return this.#inner.health();
	}
	close(): Promise<void> {
		return this.#inner.close();
	}
	execute(request: AgentRequest, hooks: RunHooks): Promise<AgentOutcome> {
		return this.#inner.execute(request, { ...hooks, requestApproval: async () => ({ approved: false, reason: NO_SHELL }) });
	}
}

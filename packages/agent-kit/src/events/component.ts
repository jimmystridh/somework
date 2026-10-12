import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Extension } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { SomeWorkClient } from "@somework/sdk";
import type { InboundMessage } from "../threads/message.ts";
import type { DailyLedger, PoolUsage } from "../ledger.ts";
import type { Log } from "../log.ts";
import type { Metrics } from "../metrics.ts";
import type { AgentRuntime } from "../runtime.ts";
import { createEventActions, type ActionDeps } from "./actions.ts";
import { createControlIntercept } from "./control.ts";
import { HandlerGuard, type DroppedSample, type HandlerStatus } from "./guard.ts";
import { EventInbox } from "./inbox.ts";
import { EventIntake, eventsDir, handlersDir } from "./intake.ts";
import { EventProcessor } from "./processor.ts";
import { HandlerRunner } from "./runner.ts";
import { HandlerStore } from "./store.ts";
import { createHandlerTools } from "./tools.ts";
import type { ResolvedEvents } from "./types.ts";

export interface EventsComponentDeps {
	config: ResolvedEvents;
	stateDir: string;
	client: Pick<SomeWorkClient, "events" | "post">;
	/** Starts a job of this agent for a `submit` decision of a handler. */
	startJob: ActionDeps["startJob"];
	runtime: Pick<AgentRuntime, "execute">;
	/** The agent's own execution environment (container sandbox or the role's confined environment). */
	envFor: (cwd: string | undefined) => ExecutionEnv;
	workspaceRoot: string;
	ledger: DailyLedger;
	agent: { id: string; role: string; capabilities: { id: string; version: string }[] };
	log: Log;
	metrics: Metrics;
	/** True while the agent drains for a deployment (see `Drain`). */
	draining?: () => boolean;
}

export interface EventsStatus {
	handlers: HandlerStatus[];
	tokenPools: PoolUsage;
	events: { cursor: number; dropped: DroppedSample[]; inbox: number };
}

export interface EventsComponent {
	/** Runs until `signal` aborts. */
	run(signal: AbortSignal): Promise<void>;
	/** Pass to the chat responder: applies kill-switch messages from the controllers. */
	intercept(message: InboundMessage): Promise<boolean>;
	extension: Extension<any>;
	toolNames: string[];
	status(): EventsStatus;
	store: HandlerStore;
}

/** Wires intake, handler runner, guard, token pools and the authoring tools for one agent. Nothing starts until `run`. */
export function createEventsComponent(deps: EventsComponentDeps): EventsComponent {
	const { config } = deps;
	const store = new HandlerStore(handlersDir(deps.stateDir));
	const guard = new HandlerGuard(store, { maxConsecutiveFailures: config.maxConsecutiveFailures, maxWakesPerHour: config.maxWakesPerHour });
	const inbox = new EventInbox(eventsDir(deps.stateDir));
	const root = deps.workspaceRoot.replace(/[\\/]$/, "");
	const runner = new HandlerRunner({
		env: () => deps.envFor(deps.workspaceRoot),
		dir: `${root}/.somework-events`,
		timeoutSeconds: config.timeoutSeconds,
		memoryMb: config.memoryMb,
		maxOutputBytes: config.maxOutputBytes,
		fetchHosts: config.fetchHosts,
	});
	const actions = createEventActions({
		client: deps.client,
		startJob: deps.startJob,
		runtime: deps.runtime,
		agentId: deps.agent.id,
		workspace: `${root}/events`,
		prepareWorkspace: async (workspace) => void (await deps.envFor(deps.workspaceRoot).createDir(workspace, { recursive: true }, BACKGROUND_CONTEXT)),
		wakeBudget: config.wakeBudget,
		smallModel: config.smallModel,
		notifyTo: config.notifyTo,
		log: deps.log,
	});
	const processor = new EventProcessor({ config, store, runner, guard, ledger: deps.ledger, inbox, actions, agent: deps.agent, log: deps.log, metrics: deps.metrics, ...(deps.draining ? { draining: deps.draining } : {}) });
	const intake = new EventIntake({ client: deps.client, processor, dir: eventsDir(deps.stateDir), log: deps.log });
	const tools = createHandlerTools({ store, guard, inbox, runner, config, agent: deps.agent });

	const pools = deps.metrics.gauge("somework_token_pool_used", "Tokens used today per pool");
	const poolLimits = deps.metrics.gauge("somework_token_pool_limit", "Token limit today per pool");
	const status = (): EventsStatus => {
		const usage = deps.ledger.usage();
		pools.set(usage.tasks.used, { pool: "tasks" });
		pools.set(usage.events.used, { pool: "events" });
		poolLimits.set(usage.tasks.limit, { pool: "tasks" });
		poolLimits.set(usage.events.limit, { pool: "events" });
		return { handlers: guard.status(), tokenPools: usage, events: { cursor: intake.cursor, dropped: guard.samples(), inbox: inbox.recent(1000).length } };
	};

	return {
		run: async (signal) => {
			deps.log("info", "events_started", { handlers: store.names().length, notifyTo: config.notifyTo, share: config.tokenShare });
			await intake.run(signal);
		},
		intercept: createControlIntercept({ store, controllers: config.controllers, log: deps.log }),
		extension: tools.extension,
		toolNames: tools.toolNames,
		status,
		store,
	};
}

export const handlerFilePath = (stateDir: string, name: string): string => join(handlersDir(stateDir), `${name}.mjs`);

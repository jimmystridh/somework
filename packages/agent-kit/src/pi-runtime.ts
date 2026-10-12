import { type Context } from "@earendil-works/chord";
import { awaitWithContext, BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import { createRegistry, defineDoc, defineExtension, hook, Harness, ToolTask, watchEvents, type Conversation, type Extension, type ToolRegistration } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { silent, type Log } from "./log.ts";
import { sameModel } from "./providers/allowlist.ts";
import { Metrics } from "./metrics.ts";
import type { RunRecording, RunTracer } from "./trace.ts";
import { emptyUsage, type AgentOutcome, type AgentRequest, type AgentRuntime, type ApprovalDecision, type ApprovalRequest, type RunHooks, type Usage } from "./runtime.ts";

const ctx: Context = BACKGROUND_CONTEXT;

/** Index of agent keys to conversation ids, kept as a document on the root conversation. */
const Keys = defineDoc<{ map: Record<string, number> }>({ kind: "somework.keys", version: 1, scope: "conversation", history: "latest", initial: () => ({ map: {} }) });

export interface ApprovalPolicy {
	/** A summary when the call needs the requester's approval, otherwise `undefined`. */
	needsApproval(tool: string, args: Record<string, unknown>): string | undefined;
}

/** What an operator's setup (ADR 0004) adds to a new conversation. Read when a conversation is created: a running one keeps what it started with. */
export interface OperatorSetup {
	/** Appended to the standing orders of a new conversation. */
	instructions(): string | undefined;
	/** The tools a new conversation is offered on top of its own list; each must be registered by an extension. */
	tools(): readonly string[];
	/** Every tool the setup can ever bring: calls to them are never blocked as "not available". */
	toolNames: readonly string[];
}

export interface PiRuntimeOptions {
	storagePath: string;
	models: Models;
	model: { provider: string; modelId: string };
	env: (cwd: string | undefined) => ExecutionEnv;
	policy?: ApprovalPolicy;
	operator?: OperatorSetup;
	extensions?: Extension<any>[];
	/** Standing orders for every new conversation (the role's system prompt). */
	instructions?: string;
	/** The tools offered to the model, by name; unset offers all. A call to any other tool is blocked as well. */
	allowedTools?: readonly string[];
	log?: Log;
	metrics?: Metrics;
	/** Called with what a run spent on one model since the last call (tokens by kind and cost), while the run goes and once more when it ends. */
	onUsage?: (spent: ModelSpend) => void;
	/** Keeps the full record of every run (messages, tool calls with arguments and results, usage) for later analysis. */
	trace?: RunTracer;
}

/** What one model consumed in a stretch of a run; `provider` and `modelId` are the key the SDK keeps usage under, split at its first slash. */
export interface ModelSpend {
	provider: string;
	modelId: string;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	costUsd: number;
}

type ModelTotals = Record<string, Omit<ModelSpend, "provider" | "modelId">>;

interface Active {
	hooks: RunHooks;
	requestId: string;
	conversation: Conversation;
	context?: unknown;
}

/** Pi Durable behind the `AgentRuntime` interface. One harness, one storage owner, one conversation per agent key. */
export class PiDurableRuntime implements AgentRuntime {
	readonly #options: PiRuntimeOptions;
	readonly #log: Log;
	readonly #active = new Map<number, Active>();
	#harness: Harness | undefined;
	#rootId = 0;
	#resumed = false;
	#modelChoice: { provider: string; modelId: string };
	#offeredTools: ToolRegistration[] | undefined;
	#registered = new Map<string, ToolRegistration>();
	/** Tools a running conversation was restricted to by its request (chat sessions); everything else uses the runtime's list. */
	readonly #conversationTools = new Map<number, ReadonlySet<string>>();

	constructor(options: PiRuntimeOptions) {
		this.#options = options;
		this.#log = options.log ?? silent;
		this.#modelChoice = options.model;
	}

	/** The registrations behind `allowedTools`: a typo must stop the service at startup, not silently hide a tool. */
	#resolveAllowedTools(): ToolRegistration[] | undefined {
		const known = new Map<string, ToolRegistration>();
		for (const extension of [CodingTools, ...(this.#options.extensions ?? [])]) for (const tool of extension.tools ?? []) known.set(tool.name, tool);
		this.#registered = known;
		const allowed = this.#options.allowedTools;
		if (!allowed) return undefined;
		const unknown = allowed.filter((name) => !known.has(name));
		if (unknown.length > 0) throw new Error(`allowedTools names tools that do not exist: ${unknown.join(", ")} (known: ${[...known.keys()].join(", ")})`);
		return allowed.map((name) => known.get(name)!);
	}

	/** The registrations for a request's own tool list. Names the runtime does not have are an error, never silently dropped. */
	#toolsFor(names: readonly string[]): ToolRegistration[] {
		const unknown = names.filter((name) => !this.#registered.has(name));
		if (unknown.length > 0) throw new Error(`the request names tools that do not exist: ${unknown.join(", ")}`);
		return names.map((name) => this.#registered.get(name)!);
	}

	async start(): Promise<void> {
		this.#offeredTools = this.#resolveAllowedTools();
		const registry = createRegistry();
		registry.install(CodingTools);
		registry.install(this.#policyExtension());
		for (const extension of this.#options.extensions ?? []) registry.install(extension);
		const storage = await openNodeSqliteStorage(this.#options.storagePath);
		this.#harness = await Harness.open(storage, { models: this.#options.models, registry, env: ({ cwd }) => this.#options.env(cwd) }, ctx);
		const root = await this.#harness.root(ctx, { agent: { model: this.#modelChoice } });
		this.#rootId = root.id;
		// continue any run the last process left unfinished
		this.#harness.resume();
		this.#resumed = true;
		this.#log("info", "runtime_started", { storage: this.#options.storagePath });
	}

	/** The model a new conversation starts on unless its request names one. */
	get model(): { provider: string; modelId: string } {
		return this.#modelChoice;
	}

	/** Changes the model new conversations start on (`undefined`: back to the configured one). Throws with the reason when the provider does not offer it. */
	setModel(model: { provider: string; modelId: string } | undefined): void {
		const wanted = model ?? this.#options.model;
		if (!this.#options.models.getModel(wanted.provider, wanted.modelId)) throw new Error(`the model ${wanted.provider}/${wanted.modelId} is not offered by its provider`);
		this.#modelChoice = wanted;
	}

	/** The names of every tool this runtime has registered (the coding tools and its extensions' tools), for checks at startup. */
	knownTools(): string[] {
		return [...this.#registered.keys()];
	}

	contextOf(conversationId: number): unknown {
		return this.#active.get(conversationId)?.context;
	}

	async steer(requestId: string, text: string): Promise<boolean> {
		for (const active of this.#active.values()) {
			if (active.requestId !== requestId) continue;
			await active.conversation.submit({ type: "input", content: text, whenBusy: "steer" } as never, ctx);
			return true;
		}
		return false;
	}

	health(): { ready: boolean; reason?: string } {
		return this.#harness && this.#resumed ? { ready: true } : { ready: false, reason: "storage not open or resume not finished" };
	}

	async close(): Promise<void> {
		await this.#harness?.close(ctx);
		this.#harness = undefined;
	}

	/** The key to conversation index is written in the same commit that creates the conversation. */
	async #conversation(request: AgentRequest): Promise<Conversation> {
		const harness = this.#harness!;
		const model = request.model ?? this.#modelChoice;
		const workspace = request.workspace;
		// a conversation keeps the model it started with, so a different model gets its own conversation for the same key
		const agentKey = request.model && !sameModel(request.model, this.#modelChoice) ? `${request.agentKey}@${request.model.provider}/${request.model.modelId}` : request.agentKey;
		const existing = (await harness.snapshot(Keys, this.#rootId, ctx))?.map?.[agentKey];
		if (existing !== undefined) {
			const found = await harness.conversation(existing as never, ctx);
			if (found) return found as unknown as Conversation;
		}
		const rootId = this.#rootId;
		const instructions = [request.instructions ?? this.#options.instructions, this.#options.operator?.instructions()].filter(Boolean).join("\n\n") || undefined;
		const tools = this.#conversationToolRegistrations(request);
		return (await harness.createConversation(
			{
				ownership: { kind: "ownerless" },
				agent: { model, cwd: workspace, ...(instructions ? { instructions } : {}), ...(tools ? { tools } : {}) },
				init: async (tx, conversationId) => {
					(await tx.doc(Keys, rootId as never)).map[agentKey] = conversationId as unknown as number;
				},
			},
			ctx,
		)) as unknown as Conversation;
	}

	/** The tools of a new conversation: the request's own list or the runtime's, plus what the operator's setup brings (when the list restricts at all). */
	#conversationToolRegistrations(request: AgentRequest): ToolRegistration[] | undefined {
		const base = request.tools ? this.#toolsFor(request.tools) : this.#offeredTools;
		if (!base) return undefined;
		const extra = (this.#options.operator?.tools() ?? []).filter((name) => this.#registered.has(name) && !base.some((tool) => tool.name === name));
		return [...base, ...extra.map((name) => this.#registered.get(name)!)];
	}

	async execute(request: AgentRequest, hooks: RunHooks): Promise<AgentOutcome> {
		const harness = this.#harness;
		if (!harness) throw new Error("the runtime is not started");
		const conversation = await this.#conversation(request);
		const conversationId = conversation.id as unknown as number;
		this.#active.set(conversationId, { hooks, requestId: request.requestId, conversation, ...(request.context !== undefined ? { context: request.context } : {}) });
		if (request.tools) this.#conversationTools.set(conversationId, new Set([...request.tools, ...(this.#options.operator?.tools() ?? [])]));
		const baseline = await this.#usageOf(conversation);
		const reported = { totals: await this.#usageByModel(conversation) };
		const started = Date.now();
		const log = (event: string, fields: Record<string, unknown> = {}) => this.#log("info", event, { requestId: request.requestId, agentKey: request.agentKey, ...fields });

		let stopWhy: "cancel_requested" | "timeout" | "budget_exceeded" | undefined;
		const requestStop = (why: "cancel_requested" | "timeout" | "budget_exceeded") => {
			if (stopWhy) return;
			stopWhy = why;
			void conversation.abort(ctx).catch(() => {});
		};

		// progress from the event stream and the token budget from per-conversation usage
		const recording: RunRecording | undefined = this.#options.trace?.open({ requestId: request.requestId, agentKey: request.agentKey, instruction: request.instruction, ...(request.context !== undefined ? { context: request.context } : {}), ...(request.meta ? { meta: request.meta } : {}), model: request.model ?? this.#modelChoice });
		const events = await watchEvents(harness, conversation.id, ctx);
		await events.start(async (batch) => {
			for (const event of batch) {
				recording?.event(event);
				const update = describeEvent(event);
				if (update) hooks.onProgress(update);
				if (event.type === "tool_execution_start") hooks.onTool?.(event.toolName ?? event.name ?? event.tool?.name ?? "?");
				if (event.type === "usage_changed") {
					await this.#reportUsage(conversation, reported);
					const spent = diff(await this.#usageOf(conversation), baseline).totalTokens;
					if (spent > request.budget.maxTokens) requestStop("budget_exceeded");
				}
			}
		});
		const deadline = setTimeout(() => requestStop("timeout"), request.budget.maxMinutes * 60_000);

		const onSignal = () => {
			const why = hooks.signal.reason as string | undefined;
			if (why === "cancel_requested" || why === "timeout") requestStop(why);
		};
		hooks.signal.addEventListener("abort", onSignal, { once: true });

		let outcome: AgentOutcome | undefined;
		try {
			const submission = await conversation.submit({ type: "input", content: request.instruction, requestId: request.requestId }, ctx);
			log("run_submitted", { submissionId: submission.id });
			const settled = await this.#settle(submission.wait(ctx), hooks.signal);
			if (settled === "detach") {
				log("run_detached", { reason: hooks.signal.reason });
				outcome = { status: "detached" };
				return outcome;
			}
			const usage = diff(await this.#usageOf(conversation), baseline);
			if (stopWhy) outcome = { status: "aborted", reason: stopWhy, usage };
			else if (settled.status === "done") outcome = { status: "done", answer: await this.#answer(conversation), usage };
			else outcome = { status: "unanswered", reason: settled.reason ?? "unknown", usage };
			return outcome;
		} finally {
			clearTimeout(deadline);
			hooks.signal.removeEventListener("abort", onSignal);
			await events.stop?.().catch?.(() => {});
			recording?.end(outcome ? { status: outcome.status, ...("reason" in outcome ? { reason: outcome.reason } : {}), ...("answer" in outcome ? { answer: outcome.answer } : {}), ...("usage" in outcome ? { usage: outcome.usage } : {}) } : { status: "error" });
			await this.#reportUsage(conversation, reported).catch(() => {});
			this.#active.delete(conversationId);
			this.#conversationTools.delete(conversationId);
			log("run_finished", { ms: Date.now() - started });
		}
	}

	/** Waits for the submission, or returns "detach" when the SDK says the lease is lost or we are shutting down. */
	async #settle<T>(settled: Promise<T>, signal: AbortSignal): Promise<T | "detach"> {
		const detach = new Promise<"detach">((resolve) => {
			const check = () => {
				const why = signal.reason;
				if (why === "lease_lost" || why === "shutdown") resolve("detach");
			};
			if (signal.aborted) check();
			else signal.addEventListener("abort", check, { once: true });
		});
		return await Promise.race([settled, detach]);
	}

	async #answer(conversation: Conversation): Promise<string> {
		const view = await conversation.viewState(ctx);
		const entries = (view as any).value?.entries ?? [];
		const last = [...entries].reverse().find((entry: any) => entry.kind === "pi.assistant");
		return (last?.model ?? [])
			.flatMap((message: any) => message.content ?? [])
			.filter((block: any) => block.type === "text")
			.map((block: any) => block.text)
			.join("");
	}

	async #usageByModel(conversation: Conversation): Promise<ModelTotals> {
		const view = await conversation.viewState(ctx);
		const models = (view as any).value?.docs?.["pi.usage"]?.models ?? {};
		return Object.fromEntries(
			Object.entries<any>(models).map(([key, usage]) => [
				key,
				{ inputTokens: usage.input ?? 0, outputTokens: usage.output ?? 0, cacheReadTokens: usage.cacheRead ?? 0, cacheWriteTokens: usage.cacheWrite ?? 0, costUsd: usage.cost?.total ?? 0 },
			]),
		);
	}

	/** Hands the callback what each model spent since the previous report; a failing callback never disturbs the run. */
	async #reportUsage(conversation: Conversation, reported: { totals: ModelTotals }): Promise<void> {
		const onUsage = this.#options.onUsage;
		if (!onUsage) return;
		const now = await this.#usageByModel(conversation);
		for (const [key, total] of Object.entries(now)) {
			const before = reported.totals[key];
			const spent = {
				inputTokens: total.inputTokens - (before?.inputTokens ?? 0),
				outputTokens: total.outputTokens - (before?.outputTokens ?? 0),
				cacheReadTokens: total.cacheReadTokens - (before?.cacheReadTokens ?? 0),
				cacheWriteTokens: total.cacheWriteTokens - (before?.cacheWriteTokens ?? 0),
				costUsd: total.costUsd - (before?.costUsd ?? 0),
			};
			if (Object.values(spent).every((value) => value <= 0)) continue;
			const slash = key.indexOf("/");
			try {
				onUsage({ provider: slash < 0 ? "unknown" : key.slice(0, slash), modelId: slash < 0 ? key : key.slice(slash + 1), ...spent });
			} catch (error) {
				this.#log("warn", "usage_report_failed", { error: error instanceof Error ? error.message : String(error) });
			}
		}
		reported.totals = now;
	}

	async #usageOf(conversation: Conversation): Promise<Usage> {
		const view = await conversation.viewState(ctx);
		const models = (view as any).value?.docs?.["pi.usage"]?.models ?? {};
		const total = emptyUsage();
		for (const usage of Object.values<any>(models)) {
			total.inputTokens += usage.input ?? 0;
			total.outputTokens += usage.output ?? 0;
			total.totalTokens += usage.totalTokens ?? (usage.input ?? 0) + (usage.output ?? 0);
			total.costUsd += usage.cost?.total ?? 0;
		}
		return total;
	}

	/** Blocks a tool call that needs the requester's approval until they answer; the decision is memoized so a restart does not ask again. */
	#policyExtension(): Extension<any> {
		const policy = this.#options.policy;
		return defineExtension({
			name: "somework-policy",
			hooks: [
				hook(ToolTask, {
					beforeTool: async (call, api, context) => {
						const own = this.#conversationTools.get(api.conversationId as unknown as number);
						const fromSetup = this.#options.operator?.toolNames.includes(call.name) === true;
						if (own ? !own.has(call.name) : this.#options.allowedTools && !this.#options.allowedTools.includes(call.name) && !fromSetup) return { block: `the tool ${call.name} is not available to this agent` };
						const summary = policy?.needsApproval(call.name, call.arguments as Record<string, unknown>);
						if (!summary) return undefined;
						const memo = `approval:${call.id}`;
						let decision = await api.memo<ApprovalDecision>(memo, context);
						if (!decision) {
							const active = this.#active.get(api.conversationId as unknown as number);
							if (!active) return { block: "no requester is attached to approve this action" };
							decision = await awaitWithContext(active.hooks.requestApproval({ tool: call.name, summary } satisfies ApprovalRequest), context);
							decision = await api.memo<ApprovalDecision>(memo, decision, context);
							this.#options.trace?.note(active.requestId, "approval", { tool: call.name, summary, approved: decision.approved, ...(decision.reason ? { reason: decision.reason } : {}) });
						}
						return decision.approved ? undefined : { block: decision.reason ? `denied by the requester: ${decision.reason}` : "denied by the requester" };
					},
				}),
			],
		});
	}
}

const diff = (now: Usage, before: Usage): Usage => ({
	inputTokens: now.inputTokens - before.inputTokens,
	outputTokens: now.outputTokens - before.outputTokens,
	totalTokens: now.totalTokens - before.totalTokens,
	costUsd: now.costUsd - before.costUsd,
});

/** Maps Pi's agent events to SomeWork progress. Names and counts only: no prompt, file or tool output content. */
export function describeEvent(event: any): { message: string } | undefined {
	switch (event?.type) {
		case "run_start": return { message: "run started" };
		case "tool_execution_start": return { message: `tool: ${event.toolName ?? event.name ?? event.tool?.name ?? "?"}` };
		case "run_end": return { message: "run finished" };
		default: return undefined;
	}
}

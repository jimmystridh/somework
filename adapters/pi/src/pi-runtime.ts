import { type Context } from "@earendil-works/chord";
import { awaitWithContext, BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import { createRegistry, defineDoc, defineExtension, hook, Harness, ToolTask, watchEvents, type Conversation, type Extension } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { silent, type Log } from "./log.ts";
import { sameModel } from "./providers/allowlist.ts";
import { Metrics } from "./metrics.ts";
import { emptyUsage, type AgentOutcome, type AgentRequest, type AgentRuntime, type ApprovalDecision, type ApprovalRequest, type RunHooks, type Usage } from "./runtime.ts";

const ctx: Context = BACKGROUND_CONTEXT;

/** Index of agent keys to conversation ids, kept as a document on the root conversation. */
const Keys = defineDoc<{ map: Record<string, number> }>({ kind: "somework.keys", version: 1, scope: "conversation", history: "latest", initial: () => ({ map: {} }) });

export interface ApprovalPolicy {
	/** A summary when the call needs the requester's approval, otherwise `undefined`. */
	needsApproval(tool: string, args: Record<string, unknown>): string | undefined;
}

export interface PiRuntimeOptions {
	storagePath: string;
	models: Models;
	model: { provider: string; modelId: string };
	env: (cwd: string | undefined) => ExecutionEnv;
	policy?: ApprovalPolicy;
	extensions?: Extension<any>[];
	log?: Log;
	metrics?: Metrics;
}

interface Active {
	hooks: RunHooks;
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

	constructor(options: PiRuntimeOptions) {
		this.#options = options;
		this.#log = options.log ?? silent;
		this.#modelChoice = options.model;
	}

	async start(): Promise<void> {
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
		return (await harness.createConversation(
			{
				ownership: { kind: "ownerless" },
				agent: { model, cwd: workspace },
				init: async (tx, conversationId) => {
					(await tx.doc(Keys, rootId as never)).map[agentKey] = conversationId as unknown as number;
				},
			},
			ctx,
		)) as unknown as Conversation;
	}

	async execute(request: AgentRequest, hooks: RunHooks): Promise<AgentOutcome> {
		const harness = this.#harness;
		if (!harness) throw new Error("the runtime is not started");
		const conversation = await this.#conversation(request);
		const conversationId = conversation.id as unknown as number;
		this.#active.set(conversationId, { hooks });
		const baseline = await this.#usageOf(conversation);
		const started = Date.now();
		const log = (event: string, fields: Record<string, unknown> = {}) => this.#log("info", event, { requestId: request.requestId, agentKey: request.agentKey, ...fields });

		let stopWhy: "cancel_requested" | "timeout" | "budget_exceeded" | undefined;
		const requestStop = (why: "cancel_requested" | "timeout" | "budget_exceeded") => {
			if (stopWhy) return;
			stopWhy = why;
			void conversation.abort(ctx).catch(() => {});
		};

		// progress from the event stream and the token budget from per-conversation usage
		const events = await watchEvents(harness, conversation.id, ctx);
		await events.start(async (batch) => {
			for (const event of batch) {
				const update = describeEvent(event);
				if (update) hooks.onProgress(update);
				if (event.type === "tool_execution_start") hooks.onTool?.(event.toolName ?? event.name ?? event.tool?.name ?? "?");
				if (event.type === "usage_changed") {
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

		try {
			const submission = await conversation.submit({ type: "input", content: request.instruction, requestId: request.requestId }, ctx);
			log("run_submitted", { submissionId: submission.id });
			const settled = await this.#settle(submission.wait(ctx), hooks.signal);
			if (settled === "detach") {
				log("run_detached", { reason: hooks.signal.reason });
				return { status: "detached" };
			}
			const usage = diff(await this.#usageOf(conversation), baseline);
			if (stopWhy) return { status: "aborted", reason: stopWhy, usage };
			if (settled.status === "done") return { status: "done", answer: await this.#answer(conversation), usage };
			return { status: "unanswered", reason: settled.reason ?? "unknown", usage };
		} finally {
			clearTimeout(deadline);
			hooks.signal.removeEventListener("abort", onSignal);
			await events.stop?.().catch?.(() => {});
			this.#active.delete(conversationId);
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
						const summary = policy?.needsApproval(call.name, call.arguments as Record<string, unknown>);
						if (!summary) return undefined;
						const memo = `approval:${call.id}`;
						let decision = await api.memo<ApprovalDecision>(memo, context);
						if (!decision) {
							const active = this.#active.get(api.conversationId as unknown as number);
							if (!active) return { block: "no requester is attached to approve this action" };
							decision = await awaitWithContext(active.hooks.requestApproval({ tool: call.name, summary } satisfies ApprovalRequest), context);
							decision = await api.memo<ApprovalDecision>(memo, decision, context);
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

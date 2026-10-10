import { createHash } from "node:crypto";
import type { SomeWorkClient } from "@somework/sdk";
import type { Log } from "../log.ts";
import type { ModelRef } from "../providers/allowlist.ts";
import type { AgentRuntime, Budget } from "../runtime.ts";
import { frameEvent } from "./framing.ts";
import type { EventActions } from "./processor.ts";
import { redactText } from "./redact.ts";
import type { HandlerEvent } from "./types.ts";

export const EVENT_NOTICE_LABEL = "eventNotice";

export interface ActionDeps {
	client: Pick<SomeWorkClient, "post">;
	/** Starts a job of this agent for a `submit` decision. */
	startJob: (event: HandlerEvent, task: { capability: { id: string; version: string }; input: Record<string, unknown>; budget?: Budget }) => Promise<{ jobId: string }>;
	runtime: Pick<AgentRuntime, "execute">;
	agentId: string;
	workspace: string;
	/** Creates `workspace` in the agent's execution environment if it is missing. */
	prepareWorkspace?: (workspace: string) => Promise<void>;
	wakeBudget: Budget;
	smallModel?: ModelRef;
	notifyTo: string;
	log: Log;
}

/**
 * The kit's side of a decision. A woken run gets no human to ask: every approval request is refused, so nothing an event starts can
 * run a step that needs approval. The run's answer is passed on to the owner by the processor.
 */
export function createEventActions(deps: ActionDeps): EventActions {
	return {
		async wake(event: HandlerEvent, options) {
			await deps.prepareWorkspace?.(deps.workspace);
			const abort = new AbortController();
			const timer = setTimeout(() => abort.abort(), deps.wakeBudget.maxMinutes * 60_000);
			try {
				const outcome = await deps.runtime.execute(
					{
						requestId: `event:${event.id}`,
						agentKey: `event:${event.id}`,
						instruction: frameEvent(event, options.note),
						workspace: deps.workspace,
						budget: deps.wakeBudget,
						...(options.tier === "small" && deps.smallModel ? { model: deps.smallModel } : {}),
					},
					{
						signal: abort.signal,
						onProgress: () => {},
						requestApproval: async (request) => {
							deps.log("info", "event_approval_refused", { eventId: event.id, tool: request.tool });
							return { approved: false, reason: "no human is available to approve a step in a run started by an event" };
						},
					},
				);
				if (outcome.status === "detached") return { tokens: 0 };
				const answer = outcome.status === "done" ? outcome.answer : undefined;
				deps.log("info", "event_wake_finished", { eventId: event.id, topic: event.topic, status: outcome.status, totalTokens: outcome.usage.totalTokens, tier: options.tier });
				return { tokens: outcome.usage.totalTokens, ...(answer ? { answer } : {}) };
			} finally {
				clearTimeout(timer);
			}
		},

		async submit(event, task) {
			const input = { ...task.input, ...(task.budget && task.input.budget === undefined ? { budget: task.budget } : {}) };
			return deps.startJob(event, { capability: task.capability, input, ...(task.budget ? { budget: task.budget } : {}) });
		},

		async notify(text) {
			await deps.client.post(
				"/v1/messages",
				{
					type: "chat.notice",
					recipients: [{ kind: "agent", id: deps.notifyTo }],
					triggerMode: "never",
					content: { mediaType: "text/plain", data: redactText(text).slice(0, 4000) },
					labels: { [EVENT_NOTICE_LABEL]: "true" },
				},
				{ idempotencyKey: `event-notice:${deps.agentId}:${createHash("sha256").update(text).digest("hex").slice(0, 24)}:${Math.floor(Date.now() / 60_000)}` },
			);
		},
	};
}

import { defineExtension, defineTool, type Extension } from "@earendil-works/pi-durable";
import type { ChatJobTool, PlannedJob } from "./chat-model.ts";

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });
const failure = (value: string) => ({ isError: true as const, content: [{ type: "text" as const, text: value }] });

/**
 * The role's capabilities as tools for the open chat tier. A call is checked by the role (`plan`) and queued; the queued jobs run one after
 * another after the reply, each answered in the conversation, so a request for many things is one plain message and a few tool calls.
 */
export function createChatJobTools(tools: readonly ChatJobTool[], queue: (tool: ChatJobTool, planned: PlannedJob) => { queued: number } | { refuse: string }): { extension: Extension<any>; toolNames: string[] } {
	const registered = tools.map((tool) =>
		defineTool({
			name: tool.name,
			description: `${tool.description} The job does not run during this call: it is queued and starts after your reply, one at a time, and its result is posted to the conversation by itself.`,
			parameters: tool.parameters,
			// a replayed call queues the same job again, which the queue ignores
			replay: "safe",
			execute: async (args: unknown) => {
				const planned = await tool.plan(args);
				if ("refuse" in planned) return failure(`not queued: ${planned.refuse}`);
				const result = queue(tool, planned);
				if ("refuse" in result) return failure(`not queued: ${result.refuse}`);
				return text(`queued (${result.queued} in the queue). It runs after your reply; do not wait for its result, say what you queued.`);
			},
		}),
	);
	return { extension: defineExtension({ name: "chat-jobs", tools: registered }), toolNames: registered.map((tool) => tool.name) };
}

import { appendFileSync } from "node:fs";
import { awaitWithContext, BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, Type } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, defineTool, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

export { ctx };
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A harness over SQLite with a scripted, stateless fake model: the "model" decides from the transcript only. */
export async function open({ db, marker, tool, toolMs = 4000 }) {
	const note = (text) => appendFileSync(marker, `${Date.now()} pid=${process.pid} ${text}\n`);
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);

	const slowRead = defineTool({
		name: "slow_read",
		description: "A read-only operation that takes a while",
		parameters: Type.Object({}),
		replay: "safe",
		execute: async () => {
			note("slow_read start");
			await sleep(toolMs);
			note("slow_read end");
			return { content: [{ type: "text", text: "read ok" }] };
		},
	});
	const pushBranch = defineTool({
		name: "push_branch",
		description: "A side-effecting operation (default replay policy: not safe)",
		parameters: Type.Object({}),
		execute: async () => {
			note("push_branch start");
			await sleep(toolMs);
			note("push_branch end");
			return { content: [{ type: "text", text: "pushed" }] };
		},
	});
	const coopRead = defineTool({
		name: "coop_read",
		description: "A read-only operation that honours cancellation",
		parameters: Type.Object({}),
		replay: "safe",
		execute: async (_args, _api, context) => {
			note("coop_read start");
			await awaitWithContext(sleep(toolMs), context);
			note("coop_read end");
			return { content: [{ type: "text", text: "read ok" }] };
		},
	});
	const registry = createRegistry();
	registry.install(defineExtension({ name: "spike", tools: [slowRead, pushBranch, coopRead] }));

	// stateless script: with no tool result yet call the scenario's tool, afterwards answer
	const script = (context) => {
		const last = context.messages.at(-1);
		if (last?.role === "toolResult") return fauxAssistantMessage([fauxText(`finished after ${last.toolName}`)]);
		return fauxAssistantMessage([fauxToolCall(tool, {})], { stopReason: "toolUse" });
	};
	faux.setResponses(Array.from({ length: 50 }, () => script));

	const storage = await openNodeSqliteStorage(db);
	const harness = await Harness.open(storage, { models, registry, env: undefined }, ctx);
	const model = faux.getModel();
	return { harness, faux, note, modelChoice: { provider: model.provider, modelId: model.id } };
}

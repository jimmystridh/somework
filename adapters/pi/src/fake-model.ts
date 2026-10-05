import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";

/**
 * A deterministic, credential-free model for tests and smoke drills (opt-in: `PI_PROVIDER=faux`, never a default). The plan is a list of steps; the model decides which one to take from the number of tool results
 * already in the current run, so it behaves identically after a crash and restart (no queue position to lose).
 *   bash:<command>   write:<path>:<content>   read:<path>   final:<text>
 */
export function scriptedModels(plan: string[]) {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const step = (context: { messages: { role: string }[] }) => {
		// only the tool results of the current run count: a later run in the same conversation starts the plan again
		const lastUser = context.messages.map((m) => m.role).lastIndexOf("user");
		const index = context.messages.slice(lastUser + 1).filter((m) => m.role === "toolResult").length;
		const entry = plan[Math.min(index, plan.length - 1)]!;
		const [kind, ...rest] = entry.split(":");
		if (kind === "final") return fauxAssistantMessage([fauxText(rest.join(":"))]);
		if (kind === "bash") return fauxAssistantMessage([fauxToolCall("bash", { command: rest.join(":") })], { stopReason: "toolUse" });
		if (kind === "write") return fauxAssistantMessage([fauxToolCall("write", { path: rest[0]!, content: rest.slice(1).join(":") })], { stopReason: "toolUse" });
		if (kind === "read") return fauxAssistantMessage([fauxToolCall("read", { path: rest.join(":") })], { stopReason: "toolUse" });
		throw new Error(`unknown plan step ${entry}`);
	};
	faux.setResponses(Array.from({ length: 200 }, () => step));
	const model = faux.getModel();
	return { models, faux, model: { provider: model.provider as string, modelId: model.id as string } };
}

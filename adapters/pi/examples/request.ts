// Submit a coding task to the Pi agent and follow it to the end.
//   node examples/request.ts --url https://host:8443 --key requester.key.json --ca ca.pem \
//        --repo https://github.com/acme/app.git --ref main --instruction "fix the failing test" [--approve ask|yes|no]
import { createInterface } from "node:readline/promises";
import { Identity, SomeWorkClient, sleep } from "@somework/sdk";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i]!.replace(/^--/, ""), process.argv[i + 1] ?? "");
const need = (name: string): string => args.get(name) ?? (console.error(`missing --${name}`), process.exit(2));

const client = new SomeWorkClient({ baseUrl: need("url"), identity: Identity.fromFile(need("key")), caFile: args.get("ca"), requireTls: args.has("ca") });
const task = await client.submitTask({
	capability: { id: "code.agent", version: "1" },
	input: {
		repository: { url: need("repo"), ref: args.get("ref") ?? "main" },
		instruction: need("instruction"),
		budget: { maxTokens: Number(args.get("max-tokens") ?? 500_000), maxMinutes: Number(args.get("max-minutes") ?? 20) },
		...(args.has("key-name") ? { agentKey: args.get("key-name") } : {}),
	},
});
console.error(`task ${task.taskId} submitted`);

let answered = false;
for (;;) {
	const current = await client.getTask(task.taskId);
	if (current.state === "input_required" && !answered) {
		const question = current.blocker?.question ?? current.pendingInput ?? current;
		console.error("the agent asks for approval:", JSON.stringify(question.question ?? question).slice(0, 400));
		const mode = args.get("approve") ?? "ask";
		let approved = mode === "yes";
		if (mode === "ask") approved = (await createInterface({ input: process.stdin, output: process.stderr }).question("approve? [y/N] ")).trim().toLowerCase().startsWith("y");
		await client.provideInput(task.taskId, { approved, reason: approved ? undefined : "denied by the requester" });
		answered = false;
		await sleep(500);
		continue;
	}
	if (["succeeded", "failed", "canceled", "expired", "rejected"].includes(current.state)) {
		console.log(JSON.stringify({ state: current.state, result: current.result, failure: current.failure, artifacts: current.resultArtifacts }, null, 2));
		process.exit(current.state === "succeeded" ? 0 : 1);
	}
	await sleep(1000);
}

// Ask the Datadog triage agent to investigate one monitor and wait for the diagnosis.
//   node examples/request.ts --url https://host:8443 --key requester.key.json --ca ca.pem \
//        --monitor 12345 [--window 90] [--hint "suspect the checkout deploy"] [--max-minutes 10]
// The requester needs `--may-invoke ops.triage`. The service also sends the owner one notice when the triage ends.
import { Identity, SomeWorkClient } from "@somework/sdk";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i]!.replace(/^--/, ""), process.argv[i + 1] ?? "");
const need = (name: string): string => args.get(name) ?? (console.error(`missing --${name}`), process.exit(2));

const client = new SomeWorkClient({ baseUrl: need("url"), identity: Identity.fromFile(need("key")), caFile: args.get("ca"), requireTls: args.has("ca") });
const minutes = Number(args.get("max-minutes") ?? 10);
const task = await client.submitTask({
	capability: { id: "ops.triage", version: "1" },
	input: {
		monitor: { id: need("monitor") },
		alert: { at: new Date().toISOString() },
		...(args.has("window") ? { windowMinutes: Number(args.get("window")) } : {}),
		...(args.has("hint") ? { hint: args.get("hint") } : {}),
		budget: { maxTokens: Number(args.get("max-tokens") ?? 150_000), maxMinutes: minutes },
	},
});
console.error(`task ${task.taskId} submitted`);
const done = await client.waitTerminal(task.taskId, minutes * 60_000 + 60_000);
console.log(JSON.stringify({ state: done.state, result: done.result, failure: done.failure }, null, 2));
process.exit(done.state === "succeeded" && ["diagnosed", "noise"].includes(done.result?.outcome) ? 0 : 1);

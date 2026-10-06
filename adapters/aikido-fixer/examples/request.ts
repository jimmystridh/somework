// Submit a fix for one Aikido issue to the Aikido fixer and wait for the result.
//   node examples/request.ts --url https://host:8443 --key requester.key.json --ca ca.pem \
//        --issue 123 --repo https://github.com/acme/app.git [--ref <branch|sha>] [--hint "prefer 4.17.21"] [--max-minutes 30]
// The requester needs `--may-invoke code.fix`. The agent works on the default branch unless --ref says otherwise.
import { Identity, SomeWorkClient } from "@somework/sdk";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i]!.replace(/^--/, ""), process.argv[i + 1] ?? "");
const need = (name: string): string => args.get(name) ?? (console.error(`missing --${name}`), process.exit(2));

const client = new SomeWorkClient({ baseUrl: need("url"), identity: Identity.fromFile(need("key")), caFile: args.get("ca"), requireTls: args.has("ca") });
const minutes = Number(args.get("max-minutes") ?? 30);
const task = await client.submitTask({
	capability: { id: "code.fix", version: "1" },
	input: {
		issue: { id: need("issue") },
		repository: { url: need("repo"), ...(args.has("ref") ? { ref: args.get("ref") } : {}) },
		...(args.has("hint") ? { hint: args.get("hint") } : {}),
		budget: { maxTokens: Number(args.get("max-tokens") ?? 300_000), maxMinutes: minutes },
	},
});
console.error(`task ${task.taskId} submitted`);
const done = await client.waitTerminal(task.taskId, minutes * 60_000 + 60_000);
console.log(JSON.stringify({ state: done.state, result: done.result, failure: done.failure }, null, 2));
process.exit(done.state === "succeeded" && done.result?.outcome === "pr_opened" ? 0 : 1);

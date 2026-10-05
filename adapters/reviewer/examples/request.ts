// Submit a review to the reviewer role and wait for the result.
//   node examples/request.ts --url https://host:8443 --key requester.key.json --ca ca.pem \
//        --repo https://github.com/acme/app.git --ref <branch|tag|sha|refs/pull/N/head> [--pr 123] [--ticket KEY-1] [--focus "..."]
import { Identity, SomeWorkClient } from "@somework/sdk";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i]!.replace(/^--/, ""), process.argv[i + 1] ?? "");
const need = (name: string): string => args.get(name) ?? (console.error(`missing --${name}`), process.exit(2));

const client = new SomeWorkClient({ baseUrl: need("url"), identity: Identity.fromFile(need("key")), caFile: args.get("ca"), requireTls: args.has("ca") });
const task = await client.submitTask({
	capability: { id: "code.review", version: "3" },
	input: {
		repository: { url: need("repo"), ref: need("ref") },
		...(args.has("pr") ? { pullRequest: Number(args.get("pr")) } : {}),
		...(args.has("ticket") ? { ticket: args.get("ticket") } : {}),
		...(args.has("focus") ? { focus: args.get("focus") } : {}),
		budget: { maxTokens: Number(args.get("max-tokens") ?? 300_000), maxMinutes: Number(args.get("max-minutes") ?? 15) },
	},
});
console.error(`task ${task.taskId} submitted`);
const done = await client.waitTerminal(task.taskId, Number(args.get("max-minutes") ?? 15) * 60_000 + 30_000);
console.log(JSON.stringify({ state: done.state, result: done.result, failure: done.failure, artifacts: done.resultArtifacts }, null, 2));
process.exit(done.state === "succeeded" ? 0 : 1);

// A complete, independent agent: it learns about work itself (NATS when the domain offers it, short HTTP lookups otherwise), holds its own key, and needs nothing but this process.
//   SOMEWORK_URL=https://host:8443 SOMEWORK_KEY_FILE=agent.key.json SOMEWORK_CA_FILE=ca.pem node examples/reviewer.ts
import { Identity, SomeWorkClient, Worker } from "../src/index.ts";

const url = process.env.SOMEWORK_URL ?? "http://127.0.0.1:8080";
const client = new SomeWorkClient({
	baseUrl: url,
	identity: Identity.fromFile(process.env.SOMEWORK_KEY_FILE ?? "agent.key.json"),
	caFile: process.env.SOMEWORK_CA_FILE,
	requireTls: process.env.SOMEWORK_REQUIRE_TLS === "1",
});

const worker = new Worker(client, {
	concurrency: 1,
	logger: (level, message, fields) => console.error(JSON.stringify({ level, message, ...fields })),
	handler: async (job, control) => {
		control.progress({ message: "reviewing", percent: 10 });
		// honour control.signal in real work: it aborts for a requester cancel, a timeout, a lost lease or shutdown
		if (control.signal.aborted) return { type: "detach" };
		const text: string = job.input.text ?? "";
		const findings = /rm -rf|curl .*\| *sh/.test(text) ? [{ file: "input.txt", line: 1, severity: "high", message: "dangerous command" }] : [];
		return { type: "completed", result: { verdict: findings.length ? "reject" : "approve", summary: `${findings.length} finding(s)`, findings } };
	},
});

const stop = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => stop.abort());
await worker.run(stop.signal);

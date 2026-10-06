import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { HandlerStore, handlersDir } from "@somework/agent-kit";
import { sleep } from "@somework/sdk";
import { freePort, startDomain } from "../../../sdk/typescript/test/harness.ts";

const here = new URL(".", import.meta.url).pathname;
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const logs = new Map<ChildProcess, string>();
const run = (script: string, env: Record<string, string>): ChildProcess => {
	const child = spawn("node", [script], { env: { PATH: process.env.PATH!, HOME: process.env.HOME!, ...env }, stdio: ["ignore", "ignore", "pipe"], cwd: join(here, "..") });
	logs.set(child, "");
	child.stderr!.on("data", (d) => logs.set(child, logs.get(child)! + d));
	return child;
};

async function until<T>(what: string, read: () => Promise<T | undefined | false>, ms = 40_000): Promise<T> {
	const deadline = Date.now() + ms;
	for (;;) {
		const value = await read().catch(() => undefined);
		if (value) return value;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}\n${[...logs.values()].join("\n").slice(-2500)}`);
		await sleep(150);
	}
}

let datadog: Server;
let datadogUrl: string;
const datadogRequests: string[] = [];
before(async () => {
	datadog = createServer((req, res) => {
		datadogRequests.push(`${req.method} ${req.url}`);
		res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: 12345, name: "Checkout error rate", type: "metric alert", priority: 2, tags: ["service:checkout"], overall_state: "Alert" }));
	});
	await new Promise<void>((resolve) => datadog.listen(0, "127.0.0.1", resolve));
	datadogUrl = `http://127.0.0.1:${(datadog.address() as { port: number }).port}`;
});
after(() => void datadog.close());

const ANSWER = '```json\n{"outcome":"inconclusive","severity":"low","summary":"smoke test answer","confidence":"low","timeline":[],"evidence":[{"kind":"monitor","finding":"read the monitor","inference":true}],"recommendedActions":["nothing"]}\n```';

/** The real service process (the role's main.ts) with a real domain, a real sandbox daemon, a fake Datadog and a scripted model. */
describe("the service process", () => {
	it("boots without a repository or an egress proxy, seeds its handler, answers a question with the Datadog tools and runs an instruction as a triage", async () => {
		const domain = await startDomain({ cardFile: join(here, "../card.json"), mayInvoke: "ops.*" });
		cleanups.push(() => domain.stop());
		const dir = mkdtempSync(join(tmpdir(), "dd-proc-"));
		const workspaces = join(dir, "workspaces");
		const state = join(dir, "state");
		mkdirSync(workspaces);
		mkdirSync(state);
		const tokenFile = join(dir, "sandbox-token");
		writeFileSync(tokenFile, "s".repeat(48));
		const keys = join(dir, "datadog-keys.json");
		writeFileSync(keys, JSON.stringify({ apiKey: "a".repeat(32), appKey: "b".repeat(40) }), { mode: 0o600 });
		const sandboxPort = await freePort();
		const sandbox = run(join(here, "../../../packages/agent-kit/src/sandbox/main.ts"), { SANDBOX_TOKEN_FILE: tokenFile, SANDBOX_ROOT: workspaces, SANDBOX_PORT: String(sandboxPort), SANDBOX_HOST: "127.0.0.1" });
		cleanups.push(() => void sandbox.kill("SIGKILL"));
		await until("the sandbox", async () => (await fetch(`http://127.0.0.1:${sandboxPort}/healthz`)).ok);

		const healthPort = await freePort();
		const service = run(join(here, "../src/main.ts"), {
			SOMEWORK_URL: domain.url,
			SOMEWORK_KEY_FILE: join(domain.dir, "worker.key.json"),
			PI_STATE_DIR: state,
			PI_PROVIDER: "faux",
			PI_FAUX_PLAN: JSON.stringify(['call:monitor_get:{"id":"12345"}', 'call:logs_search:{"query":"service:checkout","from":"now-1h","save":true}', `bash:python3 -c "import json; print(json.load(open('data/logs_search-1.json'))['count'])"`, `final:${ANSWER}`]),
			SANDBOX_URL: `http://127.0.0.1:${sandboxPort}`,
			SANDBOX_TOKEN_FILE: tokenFile,
			SANDBOX_WORKSPACES: workspaces,
			HEALTH_PORT: String(healthPort),
			SOMEWORK_LEASE_SECONDS: "5",
			DD_CREDENTIALS_FILE: keys,
			DD_ALLOW_BASE_OVERRIDE: "1",
			DD_API_BASE: datadogUrl,
			CHAT_ALLOWED_SENDERS: "agent/ts-author",
			CHAT_INSTRUCTORS: "agent/ts-author",
			CHAT_BUSY_AFTER_SECONDS: "60",
		});
		cleanups.push(() => void service.kill("SIGKILL"));
		const status = async () => (await (await fetch(`http://127.0.0.1:${healthPort}/status`)).json()) as any;
		await until("the service to report chat", async () => (await status()).chat?.mode === "model");
		const ready = await fetch(`http://127.0.0.1:${healthPort}/ready`);
		assert.equal(ready.ok, true, await ready.text());
		assert.ok(new HandlerStore(handlersDir(state)).current("datadog"), "the shipped handler was installed");

		const replies = async () => (((await domain.author.get("/v1/inbox?limit=200")).messages ?? []) as any[]).filter((m) => m.type === "chat.message" && m.labels?.["chatReply"] === "true" && m.sender?.id === "agent/ts-worker");
		const text = (message: any): string => (typeof message.content?.data === "string" ? message.content.data : JSON.stringify(message.content?.data));

		// an instruction runs as a triage job of the real handler: no repository in the job, no clone, python and the Datadog tools offered
		const instruct = await domain.author.post("/v1/messages", { recipients: [{ kind: "agent", id: "agent/ts-worker" }], content: { mediaType: "text/plain", data: "instruct: triage monitor 12345" }, triggerMode: "directed" });
		const [done] = await until("the triage to be reported", async () => ((await replies()).length >= 1 ? await replies() : undefined), 60_000);
		assert.match(text(done), /Triage inconclusive, severity low\.\nsmoke test answer\nhttps:\/\/app\.datadoghq\.eu\/monitors\/12345/);
		assert.equal(done.replyTo, (instruct as any).messageId);

		// a question gets the read-only Datadog tools
		await sleep(16_000);
		await domain.author.post("/v1/messages", { recipients: [{ kind: "agent", id: "agent/ts-worker" }], conversationId: (instruct as any).conversationId, content: { mediaType: "text/plain", data: "what is monitor 12345?" }, triggerMode: "directed" });
		const both = await until("the answer", async () => ((await replies()).length >= 2 ? await replies() : undefined), 60_000);
		assert.match(both.map(text).join("\n"), /smoke test answer/);
		assert.deepEqual([...new Set(datadogRequests.map((request) => request.split("?")[0]))].sort(), ["GET /api/v1/monitor/12345", "POST /api/v2/logs/events/search"], "only reads reached Datadog");
		assert.match(logs.get(service)!, /datadog_saved[^\n]*data\/logs_search-1\.json/, "save mode wrote its file into the workspace through the real sandbox daemon");
		assert.equal((await status()).tokenPools.tasks.used, 0, "chat never touched the task pool");
	});
});

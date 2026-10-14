import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { sleep } from "@somework/sdk";
import { freePort, repoRoot, startDomain } from "../../../sdk/typescript/test/harness.ts";

const here = new URL(".", import.meta.url).pathname;
const binary = process.env.SOMEWORK_BIN ?? join(repoRoot, "dist/somework");
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const logs = new Map<ChildProcess, string>();
const run = (script: string, env: Record<string, string>): ChildProcess => {
	const child = spawn("node", [script], { env, stdio: ["ignore", "ignore", "pipe"], cwd: join(here, "..") });
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

const PROJECT = "0b6a3f1e-5c4d-4e8a-9f21-7d3c1a2b4e5f";
const KEY_VALUE = "plane-process-test-key-value";

/** A stand-in for Plane: one project with one label, files whatever it is sent. */
let plane: Server;
let planeUrl: string;
const planeCalls: { method: string; path: string; key: string | undefined; body: any }[] = [];
before(async () => {
	plane = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			const text = Buffer.concat(chunks).toString("utf8");
			planeCalls.push({ method: req.method ?? "", path: req.url ?? "", key: req.headers["x-api-key"] as string | undefined, body: text ? JSON.parse(text) : undefined });
			const body = req.url?.includes("/labels/") ? [{ id: "lbl-1", name: "feature" }] : req.url?.includes("/search/") ? { issues: [] } : { id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", name: "Add a thing", sequence_id: 12, project: PROJECT, project_detail: { identifier: "CLU" }, state: "Backlog", priority: "none" };
			res.writeHead(req.method === "POST" ? 201 : 200, { "content-type": "application/json" }).end(JSON.stringify(body));
		});
	});
	await new Promise<void>((resolve) => plane.listen(0, "127.0.0.1", resolve));
	planeUrl = `http://127.0.0.1:${(plane.address() as { port: number }).port}`;
});
after(() => void plane.close());

/** The real service process (the role's main.ts) with a real domain and sandbox, a fake Plane and a scripted model. */
describe("the service process", { skip: existsSync(binary) ? false : `no domain binary at ${binary}: set SOMEWORK_BIN` }, () => {
	it("refuses a command that is not inspection, asks the requester to approve the exact ticket, and files it under the conversation", async () => {
		const domain = await startDomain({ cardFile: join(here, "../card.json") });
		cleanups.push(() => domain.stop());
		const dir = mkdtempSync(join(tmpdir(), "pm-proc-"));
		const workspaces = join(dir, "workspaces");
		const state = join(dir, "state");
		for (const path of [workspaces, state]) mkdirSync(path);
		const tokenFile = join(dir, "sandbox-token");
		writeFileSync(tokenFile, "s".repeat(48));
		const planeKeyFile = join(dir, "plane-key");
		writeFileSync(planeKeyFile, KEY_VALUE);
		const env = { PATH: dirname(process.execPath), HOME: dir };
		const sandboxPort = await freePort();
		const sandbox = run(join(here, "../../../packages/agent-kit/src/sandbox/main.ts"), { ...env, SANDBOX_TOKEN_FILE: tokenFile, SANDBOX_ROOT: workspaces, SANDBOX_PORT: String(sandboxPort), SANDBOX_HOST: "127.0.0.1" });
		cleanups.push(() => void sandbox.kill("SIGKILL"));
		await until("the sandbox", async () => (await fetch(`http://127.0.0.1:${sandboxPort}/healthz`)).ok);

		const healthPort = await freePort();
		const draft = { title: "Add a thing", description: "The problem\n\n- agreed: do it", kind: "feature" };
		const service = run(join(here, "../src/main.ts"), {
			...env,
			SOMEWORK_URL: domain.url,
			SOMEWORK_KEY_FILE: join(domain.dir, "worker.key.json"),
			PI_STATE_DIR: state,
			PI_PROVIDER: "faux",
			PI_FAUX_PLAN: JSON.stringify(["call:plane_search:{\"query\":\"thing\"}", "call:bash:{\"command\":\"rm -rf /workspace\"}", `call:plane_create:${JSON.stringify(draft)}`, "final:Filed CLU-12."]),
			SANDBOX_URL: `http://127.0.0.1:${sandboxPort}`,
			SANDBOX_TOKEN_FILE: tokenFile,
			SANDBOX_WORKSPACES: workspaces,
			HEALTH_PORT: String(healthPort),
			SOMEWORK_LEASE_SECONDS: "5",
			APPROVERS: "agent/ts-author",
			PLANE_BASE_URL: planeUrl,
			PLANE_API_KEY_FILE: planeKeyFile,
			PLANE_WORKSPACE_SLUG: "acme",
			PLANE_PROJECT_ID: PROJECT,
			CHAT_BUSY_AFTER_SECONDS: "60",
		});
		cleanups.push(() => void service.kill("SIGKILL"));
		const status = async () => (await (await fetch(`http://127.0.0.1:${healthPort}/status`)).json()) as any;
		await until("the service to report chat", async () => (await status()).chat?.mode === "threads");
		await sleep(500);
		const ready = await fetch(`http://127.0.0.1:${healthPort}/ready`);
		assert.equal(ready.ok, true, await ready.text());
		const profile = (await (await fetch(`http://127.0.0.1:${healthPort}/profile`)).json()) as any;
		assert.equal(profile.role, "product-manager");
		assert.deepEqual(profile.plane, { enabled: true });
		assert.deepEqual(profile.capabilities.map((c: any) => c.id), ["product.intake"]);
		assert.deepEqual([profile.repository.push, profile.repository.pullRequest], [false, false]);

		const inbox = async () => ((await domain.author.get("/v1/inbox?limit=200")).messages ?? []) as any[];
		const text = (message: any): string => (typeof message.content?.data === "string" ? message.content.data : JSON.stringify(message.content?.data));
		await domain.author.post("/v1/messages", { recipients: [{ kind: "agent", id: "agent/ts-worker" }], content: { mediaType: "text/plain", data: "please file that thing we agreed" }, triggerMode: "directed" });

		// the command is refused at once and nobody is asked about it: the one question is the ticket
		const question = await until("the approval question", async () => (await inbox()).find((message) => message.labels?.chatApprovalRequest));
		assert.match(text(question), /file this ticket in Plane \(feature\): Add a thing\n\nThe problem\n\n- agreed: do it/);
		assert.equal((await inbox()).filter((message) => message.labels?.chatApprovalRequest).length, 1);
		assert.equal(planeCalls.some((call) => call.method === "POST" && call.path.includes("/work-items/")), false, "nothing is filed before the answer");
		await domain.author.post("/v1/messages", { recipients: [{ kind: "agent", id: "agent/ts-worker" }], content: { mediaType: "text/plain", data: "approve" }, conversationId: question.conversationId, labels: { chatApprovalDecision: question.labels.chatApprovalRequest } });

		const reply = await until("the reply", async () => (await inbox()).find((message) => message.labels?.chatReply === "true" && !message.labels?.chatApprovalRequest && /Filed CLU-12/.test(text(message))), 60_000);
		assert.match(text(reply), /Filed CLU-12/);
		const filed = planeCalls.filter((call) => call.method === "POST" && call.path.includes("/work-items/"));
		assert.equal(filed.length, 1);
		assert.equal(filed[0]!.key, KEY_VALUE);
		assert.equal(filed[0]!.body.external_id, question.conversationId, "the ticket is keyed by the conversation");
		assert.equal(filed[0]!.body.priority, "none");
		assert.deepEqual(filed[0]!.body.labels, ["lbl-1"]);
		assert.ok(!/"event":"bash"/.test(logs.get(service)!));
	});
});

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
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

/** The health ports of one agent, answering what an agent answers. */
let agent: Server;
let agentUrl: string;
const agentRequests: string[] = [];
before(async () => {
	agent = createServer((req, res) => {
		agentRequests.push(`${req.method} ${req.url}`);
		const body = req.url === "/profile" ? { role: "reviewer", version: "ci-1a2b3c4d5e6f" } : req.url === "/ready" ? { ready: true, failed: [], handlers: 1 } : { handlers: 1 };
		res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
	});
	await new Promise<void>((resolve) => agent.listen(0, "127.0.0.1", resolve));
	agentUrl = `http://127.0.0.1:${(agent.address() as { port: number }).port}`;
});
after(() => void agent.close());

/**
 * The real service process (the role's main.ts) with a real domain, a real sandbox daemon, a fake agent health port and a scripted model. `ssh` is not on its
 * PATH: whatever the model asks of a host, nothing can reach one, and the one command here that would is destructive and is denied.
 */
describe("the service process", { skip: existsSync(binary) ? false : `no domain binary at ${binary}: set SOMEWORK_BIN` }, () => {
	it("boots with its tools, reads the health of an agent, and a destructive command waits for the approver and does not run when denied", async () => {
		const domain = await startDomain({ cardFile: join(here, "../card.json") });
		cleanups.push(() => domain.stop());
		const dir = mkdtempSync(join(tmpdir(), "cluster-proc-"));
		const workspaces = join(dir, "workspaces");
		const state = join(dir, "state");
		const keys = join(dir, "ssh");
		const bin = join(dir, "bin");
		for (const path of [workspaces, state, keys, bin]) mkdirSync(path);
		symlinkSync(process.execPath, join(bin, "node"));
		writeFileSync(join(keys, "agents"), "not a real key", { mode: 0o600 });
		writeFileSync(join(keys, "known_hosts"), "# none\n");
		const tokenFile = join(dir, "sandbox-token");
		writeFileSync(tokenFile, "s".repeat(48));
		const env = { PATH: bin, HOME: dir };
		const sandboxPort = await freePort();
		const sandbox = run(join(here, "../../../packages/agent-kit/src/sandbox/main.ts"), { ...env, SANDBOX_TOKEN_FILE: tokenFile, SANDBOX_ROOT: workspaces, SANDBOX_PORT: String(sandboxPort), SANDBOX_HOST: "127.0.0.1" });
		cleanups.push(() => void sandbox.kill("SIGKILL"));
		await until("the sandbox", async () => (await fetch(`http://127.0.0.1:${sandboxPort}/healthz`)).ok);

		const healthPort = await freePort();
		const command = "docker system prune -af";
		const service = run(join(here, "../src/main.ts"), {
			...env,
			SOMEWORK_URL: domain.url,
			SOMEWORK_KEY_FILE: join(domain.dir, "worker.key.json"),
			PI_STATE_DIR: state,
			PI_PROVIDER: "faux",
			PI_FAUX_PLAN: JSON.stringify(["call:deploy_status:{}", `call:host_exec:${JSON.stringify({ host: "agents", command })}`, "final:The cluster is up; I did not prune anything because you said no."]),
			SANDBOX_URL: `http://127.0.0.1:${sandboxPort}`,
			SANDBOX_TOKEN_FILE: tokenFile,
			SANDBOX_WORKSPACES: workspaces,
			HEALTH_PORT: String(healthPort),
			SOMEWORK_LEASE_SECONDS: "5",
			CLUSTER_DEV_REPOSITORY: "https://example.test/o/r",
			CLUSTER_DEV_HOSTS: "agents=js@127.0.0.1",
			CLUSTER_DEV_SSH_KEY_DIR: keys,
			CLUSTER_DEV_AGENT_URLS: `reviewer=${agentUrl}`,
			APPROVERS: "agent/ts-author",
			CHAT_BUSY_AFTER_SECONDS: "60",
		});
		cleanups.push(() => void service.kill("SIGKILL"));
		const status = async () => (await (await fetch(`http://127.0.0.1:${healthPort}/status`)).json()) as any;
		await until("the service to report chat", async () => (await status()).chat?.mode === "threads");
		await sleep(500); // a service that has never run baselines the domain's inbox when it starts: ask after that
		const ready = await fetch(`http://127.0.0.1:${healthPort}/ready`);
		assert.equal(ready.ok, true, await ready.text());
		const profile = (await (await fetch(`http://127.0.0.1:${healthPort}/profile`)).json()) as any;
		assert.equal(profile.role, "cluster-dev");
		for (const tool of ["host_exec", "git_push", "ci_pipelines", "ci_logs", "deploy_status"]) assert.ok(profile.tools.allowed.includes(tool), tool);
		assert.deepEqual([...profile.tools.toolApprovals].sort(), ["bash", "edit", "host_exec", "read", "write"], "the classifier's gate covers bash, host_exec and the file tools");
		assert.deepEqual(profile.tools.commandApprovals, [], "no pattern list: the classifier decides");
		assert.equal(profile.concurrency, 1);
		assert.deepEqual([profile.repository.push, profile.repository.pullRequest, profile.repository.branchPrefix], [true, true, "cluster"]);
		assert.deepEqual(profile.capabilities.map((c: any) => c.id), ["code.cluster"]);

		const inbox = async () => ((await domain.author.get("/v1/inbox?limit=200")).messages ?? []) as any[];
		const text = (message: any): string => (typeof message.content?.data === "string" ? message.content.data : JSON.stringify(message.content?.data));
		await domain.author.post("/v1/messages", { recipients: [{ kind: "agent", id: "agent/ts-worker" }], content: { mediaType: "text/plain", data: "check the cluster and clean up docker" }, triggerMode: "directed" });

		// the destructive command is asked about, with the command itself, and nobody is asked about anything else
		const question = await until("the approval question", async () => (await inbox()).find((message) => message.labels?.chatApprovalRequest));
		assert.match(text(question), /Approval needed/);
		assert.ok(text(question).includes(`host_exec on agents: ${command} [data: docker system prune removes unused data for good]`), text(question));
		assert.equal((await inbox()).filter((message) => message.labels?.chatApprovalRequest).length, 1);
		await domain.author.post("/v1/messages", { recipients: [{ kind: "agent", id: "agent/ts-worker" }], content: { mediaType: "text/plain", data: "deny" }, conversationId: question.conversationId, labels: { chatApprovalDecision: question.labels.chatApprovalRequest } });

		const reply = await until("the reply", async () => (await inbox()).find((message) => message.labels?.chatReply === "true" && !message.labels?.chatApprovalRequest && /did not prune/.test(text(message))), 60_000);
		assert.match(text(reply), /The cluster is up/);
		assert.deepEqual([...new Set(agentRequests.map((request) => request.split(" ")[1]))].sort(), ["/profile", "/ready", "/status"], "deploy_status read the agent's health port");
		assert.ok(!/"event":"host_exec"/.test(logs.get(service)!), "the denied command never reached ssh");
	});
});

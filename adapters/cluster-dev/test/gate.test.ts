import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { approvalPolicy, PiDurableRuntime, type AgentRequest, type ApprovalRequest, type RunHooks } from "@somework/agent-kit";
import { scriptedModels } from "@somework/agent-kit/providers/faux";
import { createGuard } from "../src/approvals.ts";
import { profile } from "../src/profile.ts";
import { createClusterTools } from "../src/tools/index.ts";
import { boundary, fakeSpawn, settingsFor } from "./support.ts";

// the profile's approval functions read the settings of the process, as the service does
Object.assign(process.env, {
	CLUSTER_DEV_HOSTS: "agents=js@10.10.10.20,pve-host=root@10.10.10.1",
	CLUSTER_DEV_SSH_KEY_DIR: "/keys",
	CLUSTER_DEV_REPOSITORY: "https://github.com/acme/somework",
	CLUSTER_DEV_ASK_IN_SANDBOX: "1",
	CLUSTER_DEV_CONFIRM: "1",
});
const settings = settingsFor({ CLUSTER_DEV_HOSTS: process.env.CLUSTER_DEV_HOSTS!, CLUSTER_DEV_ASK_IN_SANDBOX: "1", CLUSTER_DEV_CONFIRM: "1" });

const open: PiDurableRuntime[] = [];
afterEach(async () => {
	for (const runtime of open.splice(0)) await runtime.close();
});

interface Run {
	approvals: ApprovalRequest[];
	spawned: string[][];
	results: string[];
	workspace: string;
	status: string;
}

/** The real runtime with the role's policy, tools and guard, a scripted model, and an owner who answers `answer` to every question. */
async function run(plan: string[], options: { answer?: boolean; gated?: boolean; setup?: (workspace: string) => void } = {}): Promise<Run> {
	const dir = mkdtempSync(join(tmpdir(), "cluster-gate-"));
	const workspace = join(dir, "work");
	mkdirSync(workspace);
	options.setup?.(workspace);
	const { spawn, calls } = fakeSpawn({ stdout: "ran\n" });
	const tools = createClusterTools({ settings, spawn, secrets: () => [], boundary });
	const seen: any[] = [];
	const fake = scriptedModels(plan, (context) => seen.push(context));
	const runtime = new PiDurableRuntime({
		storagePath: join(dir, "pi.sqlite"),
		models: fake.models,
		model: fake.model,
		env: (cwd) => new NodeExecutionEnv({ cwd: cwd ?? dir }),
		...(options.gated === false ? {} : { policy: approvalPolicy([], profile.approvalPatterns, profile.toolApprovals) }),
		instructions: profile.systemPrompt,
		allowedTools: profile.allowedTools,
		extensions: [tools.extension, createGuard(settings)],
	});
	await runtime.start();
	open.push(runtime);
	const approvals: ApprovalRequest[] = [];
	const hooks: RunHooks = {
		signal: new AbortController().signal,
		onProgress: () => undefined,
		requestApproval: async (request) => {
			approvals.push(request);
			return options.answer === false ? { approved: false, reason: "no" } : { approved: true };
		},
	};
	const request: AgentRequest = { requestId: `job-${Math.random().toString(36).slice(2)}`, agentKey: "k", instruction: "do it", workspace, budget: { maxTokens: 1_000_000, maxMinutes: 5 } };
	const outcome = await runtime.execute(request, hooks);
	const last = seen.at(-1)?.messages ?? [];
	const results = last.filter((message: any) => message.role === "toolResult").map((message: any) => (Array.isArray(message.content) ? message.content.map((part: any) => part.text ?? "").join("\n") : String(message.content)));
	return { approvals, spawned: calls.map((call) => call.args), results, workspace, status: outcome.status };
}

const hostCall = (host: string, command: string): string => `call:host_exec:${JSON.stringify({ host, command })}`;

describe("the approval gate and host_exec", () => {
	it("lets a harmless command through without asking", async () => {
		const result = await run([hostCall("agents", "docker ps"), "final:done"]);
		assert.equal(result.status, "done");
		assert.deepEqual(result.approvals, []);
		assert.equal(result.spawned.length, 1);
		assert.match(result.results[0]!, /ran/);
	});

	it("asks the owner about a destructive command with the exact command, runs it when approved, and the tool sees that approval", async () => {
		const result = await run([hostCall("agents", "docker volume rm somework_state"), "final:done"], { answer: true });
		assert.equal(result.approvals.length, 1);
		assert.equal(result.approvals[0]!.tool, "host_exec");
		assert.match(result.approvals[0]!.summary, /^host_exec on agents: docker volume rm somework_state \[data: /);
		assert.equal(result.spawned.length, 1, "approved: it ran");
		assert.match(result.spawned[0]!.at(-1)!, /docker volume rm somework_state/);
	});

	it("does not run a destructive command the owner denied", async () => {
		const result = await run([hostCall("agents", "docker system prune -af"), "final:done"], { answer: false });
		assert.equal(result.approvals.length, 1);
		assert.equal(result.spawned.length, 0);
		assert.match(result.results[0]!, /denied by the requester/);
	});

	it("does not run a destructive command at all when the approval gate is missing: the tool checks for the owner's answer itself", async () => {
		const result = await run([hostCall("agents", "docker system prune -af"), "final:done"], { gated: false });
		assert.equal(result.spawned.length, 0);
		assert.match(result.results[0]!, /the owner has not approved it/);
	});

	it("asks about everything on the hypervisor", async () => {
		const result = await run([hostCall("pve-host", "qm list"), "final:done"], { answer: false });
		assert.equal(result.approvals.length, 1);
		assert.match(result.approvals[0]!.summary, /host_exec on pve-host: qm list \[hypervisor:/);
		assert.equal(result.spawned.length, 0);
	});

	it("never asks about, and never runs, a push anywhere but the organisation remote", async () => {
		const result = await run([hostCall("agents", "cd ~/repo && git push origin main"), "final:done"], { answer: true });
		assert.deepEqual(result.approvals, []);
		assert.equal(result.spawned.length, 0);
		assert.match(result.results[0]!, /never allowed/);
	});
});

describe("the approval gate and bash", () => {
	it("runs the developer's everyday commands without asking", async () => {
		const result = await run(["bash:echo hello > out.txt && cat out.txt", "final:done"]);
		assert.deepEqual(result.approvals, []);
		assert.ok(existsSync(join(result.workspace, "out.txt")));
	});

	it("asks before a destructive command, with the command and the reason, and runs it only when approved", async () => {
		const victim = mkdtempSync(join(tmpdir(), "victim-"));
		writeFileSync(join(victim, "data"), "x");
		const refused = await run([`bash:rm -rf ${victim}`, "final:done"], { answer: false });
		assert.equal(refused.approvals.length, 1);
		assert.equal(refused.approvals[0]!.tool, "bash");
		assert.ok(refused.approvals[0]!.summary.startsWith(`bash: rm -rf ${victim} [data: rm removes files outside the workspace`), refused.approvals[0]!.summary);
		assert.match(refused.results[0]!, /denied by the requester/);
		assert.ok(existsSync(join(victim, "data")), "denied: nothing was removed");
		const approved = await run([`bash:rm -rf ${victim}`, "final:done"], { answer: true });
		assert.equal(approved.approvals.length, 1);
		assert.ok(!existsSync(victim), "approved: removed");
	});

	it("refuses a push to origin without asking anybody", async () => {
		const result = await run(["bash:touch ran.txt && git push origin main", "final:done"], { answer: true });
		assert.deepEqual(result.approvals, []);
		assert.ok(!existsSync(join(result.workspace, "ran.txt")), "nothing of the command ran");
		assert.match(result.results[0]!, /git push may only go to the organisation remote "org".*never allowed/);
	});

	it("refuses a destructive command too long to show the owner", async () => {
		const long = `rm -rf ${"/srv/some/long/path ".repeat(50)}`;
		const result = await run([`bash:${long}`, "final:done"], { answer: true });
		assert.deepEqual(result.approvals, []);
		assert.match(result.results[0]!, /too long to show the owner/);
	});

	it("asks before reading a file that holds secrets, and not before reading code", async () => {
		const secret = await run(["read:/run/secrets/git-token", "final:done"], { answer: false });
		assert.equal(secret.approvals.length, 1);
		assert.match(secret.approvals[0]!.summary, /^read: \/run\/secrets\/git-token \[secrets: a secrets directory\]$/);
		const plain = await run(["read:package.json", "final:done"], { answer: false, setup: (workspace) => writeFileSync(join(workspace, "package.json"), "{}") });
		assert.deepEqual(plain.approvals, []);
	});

	it("asks before writing key material", async () => {
		const result = await run(["write:server.key:abc", "final:done"], { answer: false });
		assert.equal(result.approvals.length, 1);
		assert.match(result.approvals[0]!.summary, /^write: server\.key \[secrets: key material\]$/);
		assert.ok(!existsSync(join(result.workspace, "server.key")));
	});
});

describe("what the profile hands the gate", () => {
	it("covers bash, host_exec and the file tools, and lets people only answer", () => {
		assert.deepEqual(Object.keys(profile.toolApprovals!).sort(), ["bash", "edit", "host_exec", "read", "write"]);
		assert.deepEqual(profile.chat?.approvers, ["kind:human"]);
		assert.deepEqual(profile.approvalPatterns, [], "the classifier decides, not a pattern list");
	});
});

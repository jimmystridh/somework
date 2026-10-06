import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { PiDurableRuntime } from "../src/pi-runtime.ts";
import type { AgentRequest, RunHooks } from "../src/runtime.ts";
import { scriptedModels } from "../src/providers/faux.ts";

const open: PiDurableRuntime[] = [];
afterEach(async () => {
	for (const runtime of open.splice(0)) await runtime.close();
});

const info = defineExtension({
	name: "info",
	tools: [defineTool({ name: "role_info", description: "role facts", parameters: Type.Object({}), replay: "safe", async execute() { return { content: [{ type: "text" as const, text: "the facts" }] }; } })],
});

async function runtimeFor(plan: string[], allowedTools?: string[]) {
	const dir = mkdtempSync(join(tmpdir(), "chat-runtime-"));
	const offered: string[][] = [];
	const system: string[] = [];
	const fake = scriptedModels(plan, (context: any) => {
		const systems = (context.messages ?? []).filter((message: { role: string }) => message.role === "system");
		offered.push(systems.flatMap((message: any) => (message.toolsAdded ?? []).map((tool: { name: string }) => tool.name)));
		system.push(systems.map((message: any) => String(message.sections?.instructions ?? "")).join("\n"));
	});
	const runtime = new PiDurableRuntime({ storagePath: join(dir, "state.sqlite"), models: fake.models, model: fake.model, env: (cwd) => new NodeExecutionEnv({ cwd: cwd ?? dir }), instructions: "You are the normal agent.", allowedTools, extensions: [info] });
	await runtime.start();
	open.push(runtime);
	const workspace = join(dir, "w");
	mkdirSync(workspace, { recursive: true });
	writeFileSync(join(workspace, "notes.txt"), "hello");
	return { runtime, workspace, offered, system, dir };
}

const hooks = (): RunHooks => ({ signal: new AbortController().signal, onProgress: () => undefined, requestApproval: async () => ({ approved: true }) });
const request = (workspace: string, over: Partial<AgentRequest>): AgentRequest => ({ requestId: "r1", agentKey: "k1", instruction: "go", workspace, budget: { maxTokens: 1_000_000, maxMinutes: 5 }, ...over });

describe("a request's own tools and instructions (chat sessions)", () => {
	it("offers a chat session exactly its tools and its own instructions, and the normal agent keeps its list", async () => {
		const { runtime, workspace, offered, system } = await runtimeFor(["final:ok"], ["read", "write", "edit", "bash"]);
		await runtime.execute(request(workspace, { requestId: "ask", agentKey: "chat:1", tools: ["read", "role_info"], instructions: "You answer questions." }), hooks());
		await runtime.execute(request(workspace, { requestId: "task", agentKey: "task:1" }), hooks());
		assert.deepEqual(offered[0]!.sort(), ["read", "role_info"]);
		assert.deepEqual(offered[1]!.sort(), ["bash", "edit", "read", "write"]);
		assert.match(system[0]!, /You answer questions\./);
		assert.ok(!system[0]!.includes("normal agent"));
		assert.match(system[1]!, /normal agent/);
	});

	it("blocks a writing tool the model asks for anyway, even though the runtime knows it", async () => {
		const { runtime, workspace } = await runtimeFor(["write:planted.txt:evil", "bash:touch planted-by-bash", "final:could not"]);
		const outcome = await runtime.execute(request(workspace, { agentKey: "chat:2", tools: ["read"] }), hooks());
		assert.equal(outcome.status, "done");
		assert.ok(!existsSync(join(workspace, "planted.txt")));
		assert.ok(!existsSync(join(workspace, "planted-by-bash")));
	});

	it("lets the session use the read-only tools it was given", async () => {
		const { runtime, workspace } = await runtimeFor(["call:role_info:{}", "read:notes.txt", "final:read it"]);
		const outcome = await runtime.execute(request(workspace, { agentKey: "chat:3", tools: ["read", "role_info"] }), hooks());
		assert.equal(outcome.status === "done" && outcome.answer, "read it");
	});

	it("refuses a request that names a tool the runtime does not have", async () => {
		const { runtime, workspace } = await runtimeFor(["final:ok"]);
		await assert.rejects(runtime.execute(request(workspace, { agentKey: "chat:4", tools: ["read", "teleport"] }), hooks()), /do not exist|does not exist/);
	});

	it("knows its tools, for the startup check", async () => {
		const { runtime } = await runtimeFor(["final:ok"]);
		assert.ok(runtime.knownTools().includes("role_info") && runtime.knownTools().includes("bash"));
	});
});

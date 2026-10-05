import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { createGateway } from "../src/gateway.ts";
import { Notifications, TaskTracker } from "../src/notifier.ts";
import { defaultPolicy } from "../src/policy.ts";
import { ManagerService } from "../src/service.ts";
import { registerSomeworkTools } from "../extension/tools.ts";
import { FakeDomain } from "./helpers.ts";

const TOKEN = "t".repeat(40);

async function start(options: { logs?: unknown[] } = {}) {
	const domain = new FakeDomain();
	const told: string[] = [];
	const tracker = new TaskTracker(domain, {}, async () => {}, new Notifications());
	const service = new ManagerService({ domain, policy: defaultPolicy, owner: { tell: async (text) => (told.push(text), told.length) }, tracker });
	const server: Server = createGateway({ service, token: TOKEN, log: (event, fields) => options.logs?.push({ event, ...fields }) });
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	const call = (method: string, path: string, body?: unknown, token: string | null = TOKEN) =>
		fetch(`${url}${path}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
	return { domain, told, url, call, close: () => (server.closeAllConnections(), server.close()) };
}

test("requests without the token, or with a wrong one, are rejected before anything runs", async () => {
	const { call, domain, close } = await start();
	for (const token of [null, "", "wrong", `${TOKEN}x`, TOKEN.slice(1)]) {
		const response = await call("POST", "/v1/tasks", { capability: { id: "code.review", version: "2" } }, token);
		assert.equal(response.status, 401);
	}
	assert.equal((await call("GET", "/v1/catalog?query=x", undefined, "wrong")).status, 401);
	assert.equal(domain.submitted.length, 0);
	assert.equal((await call("GET", "/healthz", undefined, null)).status, 200, "health needs no token and reveals nothing");
	close();
});

test("catalog, read-only submit and task lookup work through the gateway", async () => {
	const { call, domain, close } = await start();
	const catalog: any = await (await call("GET", "/v1/catalog?query=review")).json();
	assert.equal(catalog.results[0].agentId, "agent/reviewer");
	assert.equal(catalog.results[0].capability.sideEffects, "read");
	const submitted: any = await (await call("POST", "/v1/tasks", { capability: { id: "code.review", version: "2" }, input: { text: "echo hi" } })).json();
	assert.equal(submitted.status, "submitted");
	domain.tasks[submitted.taskId] = { taskId: submitted.taskId, state: "succeeded", result: { verdict: "approve" } };
	const task: any = await (await call("GET", `/v1/tasks/${submitted.taskId}`)).json();
	assert.deepEqual(task.result, { verdict: "approve" });
	close();
});

test("a write submit answers awaiting_approval and the gateway cannot approve it", async () => {
	const { call, domain, told, close } = await start();
	const answer: any = await (await call("POST", "/v1/tasks", { capability: { id: "code.agent", version: "1" }, input: { instruction: "fix" } })).json();
	assert.equal(answer.status, "awaiting_approval");
	assert.equal(domain.submitted.length, 0);
	assert.equal(told.length, 1);
	const status: any = await (await call("GET", `/v1/tasks/${answer.approvalId}`)).json();
	assert.equal(status.status, "pending");
	for (const path of [`/v1/approvals/${answer.approvalId}/approve`, `/v1/tasks/${answer.approvalId}/approve`]) {
		assert.equal((await call("POST", path, {})).status, 404);
	}
	assert.equal(domain.submitted.length, 0);
	close();
});

test("policy refusals keep their status and code; garbage and oversized bodies are rejected", async () => {
	const { call, close, url } = await start();
	const budget = await call("POST", "/v1/tasks", { capability: { id: "code.agent", version: "1" }, input: { budget: { maxTokens: 9e9, maxMinutes: 1 } } });
	assert.equal(budget.status, 422);
	assert.equal(((await budget.json()) as any).error.code, "budget_above_ceiling");
	assert.equal((await call("POST", "/v1/tasks", { capability: { id: "nope", version: "1" } })).status, 404);
	const garbage = await fetch(`${url}/v1/tasks`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` }, body: "{not json" });
	assert.equal(garbage.status, 400);
	const huge = await call("POST", "/v1/messages", { to: "agent/x", text: "x".repeat(300_000) });
	assert.equal(huge.status, 413);
	assert.equal((await call("GET", "/v1/nope")).status, 404);
	close();
});

test("messages and the inbox go through the gateway", async () => {
	const { call, domain, close } = await start();
	domain.unread = [{ messageId: "m1", from: "agent/reviewer", text: "done", type: "chat.message" }];
	const sent: any = await (await call("POST", "/v1/messages", { to: "agent/reviewer", text: "hello" })).json();
	assert.equal(sent.messageId, "msg_1");
	assert.equal(domain.sentMessages[0].to, "agent/reviewer");
	const inbox: any = await (await call("GET", "/v1/inbox")).json();
	assert.equal(inbox.messages[0].text, "done");
	close();
});

test("logs carry routes, statuses and sizes, never payload content or the token", async () => {
	const logs: unknown[] = [];
	const { call, close } = await start({ logs });
	await call("POST", "/v1/tasks", { capability: { id: "code.review", version: "2" }, input: { text: "TOP-SECRET-PAYLOAD" } });
	await call("GET", "/v1/catalog?query=TOP-SECRET-QUERY", undefined, "wrong-token-value");
	const text = JSON.stringify(logs);
	assert.match(text, /gateway_request/);
	assert.doesNotMatch(text, /TOP-SECRET|wrong-token-value|tttttttt/);
	close();
});

test("the Pi extension registers six tools that call the gateway with the token", async () => {
	const { url, domain, close } = await start();
	const tools = new Map<string, any>();
	const Type = new Proxy({}, { get: (_t, kind) => (value?: unknown) => ({ kind, value }) });
	registerSomeworkTools({ registerTool: (tool) => tools.set(tool.name as string, tool) }, Type, { MANAGER_GATEWAY_URL: url, MANAGER_GATEWAY_TOKEN: TOKEN });
	assert.deepEqual([...tools.keys()].sort(), ["somework_cancel", "somework_catalog", "somework_inbox", "somework_message", "somework_submit", "somework_task"]);
	const catalog = await tools.get("somework_catalog").execute("1", { query: "review" });
	assert.match(catalog.content[0].text, /agent\/reviewer/);
	const submitted = await tools.get("somework_submit").execute("2", { capabilityId: "code.agent", capabilityVersion: "1", input: { instruction: "fix" } });
	assert.match(submitted.content[0].text, /awaiting_approval/);
	assert.equal(domain.submitted.length, 0);

	const unconfigured = new Map<string, any>();
	registerSomeworkTools({ registerTool: (tool) => unconfigured.set(tool.name as string, tool) }, Type, {});
	await assert.rejects(unconfigured.get("somework_task").execute("3", { id: "task_1" }), /not configured/);
	const wrongToken = new Map<string, any>();
	registerSomeworkTools({ registerTool: (tool) => wrongToken.set(tool.name as string, tool) }, Type, { MANAGER_GATEWAY_URL: url, MANAGER_GATEWAY_TOKEN: "nope" });
	assert.match((await wrongToken.get("somework_task").execute("4", { id: "task_1" })).content[0].text, /unauthorized/);
	close();
});

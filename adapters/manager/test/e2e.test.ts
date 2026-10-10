import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { startDomain, type Domain } from "../../../sdk/typescript/test/harness.ts";
import { TelegramBridge } from "../src/bridge.ts";
import { ChatSessions } from "../src/chat.ts";
import { RestDomain } from "../src/domain.ts";
import { ensureJobSubscription } from "../src/event-intake.ts";
import { createGateway } from "../src/gateway.ts";
import { InboxReader, Notifications, PollingFeed } from "../src/notifier.ts";
import { defaultPolicy } from "../src/policy.ts";
import { ManagerService } from "../src/service.ts";
import { message, recordingApi, stubRpc } from "./helpers.ts";

const here = dirname(fileURLToPath(import.meta.url));
const TOKEN = "e".repeat(40);

async function until<T>(read: () => T | undefined | false, what: string, ms = 30_000): Promise<T> {
	const deadline = Date.now() + ms;
	for (;;) {
		const value = read();
		if (value) return value;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

async function untilAsync<T>(read: () => Promise<T | undefined | false>, what: string, ms = 30_000): Promise<T> {
	const deadline = Date.now() + ms;
	for (;;) {
		const value = await read().catch(() => undefined);
		if (value) return value;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

describe("the Manager against a real domain", () => {
	let domain: Domain;
	let server: Server;
	let url: string;
	const stop = new AbortController();
	const telegram = recordingApi();
	const state: any = { allowedUserId: 42, chatId: 42 };
	let bridge: TelegramBridge;
	let service: ManagerService;
	let rest: RestDomain;
	const running: Promise<void>[] = [];

	const call = (method: string, path: string, body?: unknown) =>
		fetch(`${url}${path}`, { method, headers: { authorization: `Bearer ${TOKEN}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
	const say = (text: string, extra: Record<string, unknown> = {}) => bridge.handleUpdate({ message: message(text, 42, extra) });
	const messages = () => telegram.texts();
	const workerInbox = async (): Promise<any[]> => ((await domain.worker().get("/v1/inbox?limit=100")) as any).messages ?? [];
	const agentSays = (text: string, extra: Record<string, unknown> = {}) =>
		domain.worker().post("/v1/messages", { recipients: [{ kind: "agent", id: "agent/ts-author" }], content: { mediaType: "text/plain", data: text }, triggerMode: "directed", ...extra });

	before(async () => {
		domain = await startDomain({ cardFile: join(here, "fixtures", "manager-card.json") });
		rest = new RestDomain(domain.author);
		const notifications = new Notifications();
		bridge = new TelegramBridge({ state, api: telegram.api, rpc: stubRpc().rpc, save: async () => {}, notifications });
		const chats = new ChatSessions({ domain: rest, owner: bridge, state, save: async () => {}, knownAgents: () => service.knownAgentIds() });
		service = new ManagerService({ domain: rest, policy: defaultPolicy, owner: bridge, chats });
		bridge.service = service;
		server = createGateway({ service, token: TOKEN });
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		running.push(new PollingFeed(new InboxReader(rest, notifications), { inboxIntervalMs: 150, maxBackoffMs: 500 }).run(stop.signal));
	});

	after(async () => {
		stop.abort();
		await Promise.race([Promise.allSettled(running), new Promise((resolve) => setTimeout(resolve, 5000))]);
		server.closeAllConnections();
		server.close();
		await (domain.close ?? domain.stop)();
	});

	it("finds the agent in the real catalog and lists what it advertises", async () => {
		const catalog: any = await (await call("GET", "/v1/catalog?query=echo%20text")).json();
		const echo = catalog.results.find((r: any) => r.capability.id === "code.echo");
		assert.ok(echo, JSON.stringify(catalog));
		assert.equal(echo.agentId, "agent/ts-worker");
		assert.ok(echo.capability.inputSchema);
		assert.ok(!("sideEffects" in echo.capability));
		await say("/agents");
		assert.match(messages().at(-1)!, /agent\/ts-worker .*code\.echo@1/);
	});

	it("asks an agent in plain words and shows its answer to the owner on Telegram", async () => {
		await say("/ask ts-worker please echo ping");
		const asked = await untilAsync(async () => (await workerInbox()).find((m: any) => m.content?.data === "please echo ping"), "the agent to get the message");
		assert.equal(asked.sender.id, "agent/ts-author");
		await agentSays("echo: ping", { conversationId: asked.conversationId, replyTo: asked.messageId });
		await until(() => messages().find((t) => t.includes("agent/ts-worker replied") && t.includes("echo: ping")), "the answer on Telegram");
	});

	it("forwards a message from another agent to the owner, and sends the Manager's messages through the gateway", async () => {
		await agentSays("the review queue is empty");
		await until(() => messages().find((t) => t.includes("the review queue is empty")), "the forwarded message");
		const sent: any = await (await call("POST", "/v1/messages", { to: "agent/ts-worker", text: "thanks" })).json();
		assert.ok(sent.messageId, JSON.stringify(sent));
		const inbox: any = await domain.worker().get("/v1/inbox?unread=true&limit=20");
		assert.ok(inbox.messages.some((m: any) => m.content?.data === "thanks"));
	});

	it("relays an agent's approval question to the owner and sends the decision back in the same conversation, labelled", async () => {
		const asked: any = await agentSays("Approval needed (agent/ts-worker): bash: git push origin main", { labels: { chatReply: "true", chatApprovalRequest: "0a1b2c3d4e5f" } });
		const question = await until(() => messages().find((t) => t.includes("asks for your approval of a step") && t.includes("git push origin main")), "the approval question on Telegram");
		assert.match(question, /\/chatapprove 0a1b2c3d4e5f/);
		await say("/chatapprove 0a1b2c3d4e5f");
		const decision = await untilAsync(async () => (await workerInbox()).find((m: any) => m.labels?.chatApprovalDecision === "0a1b2c3d4e5f"), "the decision to reach the agent");
		assert.equal(decision.content.data, "approve");
		assert.equal(decision.conversationId, asked.conversationId);
	});

	it("subscribes to the job-finished events of every agent, once", async () => {
		await ensureJobSubscription(rest, state, async () => {});
		const subscriptions = ((await domain.author.get("/v1/subscriptions")) as any).subscriptions ?? [];
		assert.equal(subscriptions.filter((s: any) => s.selector === "agent.*.job.finished").length, 1, JSON.stringify(subscriptions));
		assert.equal(state.jobSubscription, true);
		state.jobSubscription = false;
		await ensureJobSubscription(rest, state, async () => {});
		assert.equal((((await domain.author.get("/v1/subscriptions")) as any).subscriptions ?? []).filter((s: any) => s.selector === "agent.*.job.finished").length, 1, "no second subscription");
	});
});

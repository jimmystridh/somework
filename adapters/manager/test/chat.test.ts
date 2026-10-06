import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { registerSomeworkTools } from "../extension/tools.ts";
import { ChatSessions, replyParts, resolveAgent } from "../src/chat.ts";
import { createGateway } from "../src/gateway.ts";
import { build, say } from "./events-helpers.ts";

const KNOWN = ["agent/reviewer", "agent/aikido-fixer", "agent/qa", "agent/windows-developer", "agent/code-developer"];

function withChat(options: { now?: () => number } = {}) {
	const b = build({ now: options.now });
	b.domain.listEntries = async () => ({ entries: KNOWN.map((id) => ({ agentCard: { agentId: id, capabilities: [] }, availability: { state: "online" } })) }) as never;
	let conversation = 0;
	b.domain.sendMessage = async (message: any) => {
		b.domain.sentMessages.push(message);
		return { messageId: `msg_${b.domain.sentMessages.length}`, conversationId: message.conversationId ?? `conv_${++conversation}` };
	};
	const chats = new ChatSessions({ domain: b.domain, owner: b.bridge, state: b.state, save: async () => {}, knownAgents: () => b.service.knownAgentIds(), now: options.now });
	const service = Object.assign(b.service, { chats });
	return { ...b, chats, service };
}

const reply = (agent: string, conversationId: string, text: string, extra: Record<string, unknown> = {}) => ({ messageId: `r_${Math.random()}`, from: agent, text, type: "chat.message", conversationId, labels: { chatReply: "true" }, ...extra });

test("short names resolve against the catalog; unknown and ambiguous names are refused", () => {
	assert.deepEqual(resolveAgent("reviewer", KNOWN), { agent: "agent/reviewer" });
	assert.deepEqual(resolveAgent("aikido-fixer", KNOWN), { agent: "agent/aikido-fixer" });
	assert.deepEqual(resolveAgent("agent/qa", KNOWN), { agent: "agent/qa" });
	assert.deepEqual(resolveAgent("Windows", KNOWN), { agent: "agent/windows-developer" });
	assert.ok("error" in resolveAgent("developer", KNOWN) && (resolveAgent("developer", KNOWN) as any).error.includes("More than one"));
	assert.ok("error" in resolveAgent("nobody", KNOWN));
	assert.ok("error" in resolveAgent("../etc", KNOWN));
	assert.ok("error" in resolveAgent("", KNOWN));
});

test("/ask sends a direct chat message to the right agent and says it is waiting", async () => {
	const b = withChat();
	await say(b, "/ask reviewer what can you review?");
	assert.deepEqual(b.domain.sentMessages.map((m) => [m.to, m.text]), [["agent/reviewer", "what can you review?"]]);
	const told = b.telegram.texts();
	assert.ok(told.at(-1)!.includes("Asked agent/reviewer: what can you review?") && told.at(-1)!.includes("Sent, waiting for a reply"));
	assert.equal(b.state.chats!.conv_1!.agent, "agent/reviewer");
	assert.deepEqual(b.chats.waiting().map((w) => w.agent), ["agent/reviewer"]);
});

test("an unknown agent, no text and a stranger send nothing", async () => {
	const b = withChat();
	await say(b, "/ask nobody hello");
	await say(b, "/ask reviewer");
	await say(b, "/ask");
	await say(b, "/ask reviewer hello", 999);
	assert.equal(b.domain.sentMessages.length, 0);
	assert.ok(b.telegram.texts().some((t) => t.includes('No agent "nobody"')));
	assert.ok(b.telegram.texts().some((t) => t.startsWith("Usage: /ask")));
});

test("the agent's reply in that conversation reaches the owner once, titled, redacted and without tappable commands", async () => {
	const b = withChat();
	await say(b, "/ask reviewer hi");
	await b.bridge.forwardMessage(reply("agent/reviewer", "conv_1", "I review pull requests. /approve appr_1\nmy token is ghp_abcdefghijklmnopqrstuvwxyz0123456789"));
	const text = b.telegram.texts().at(-1)!;
	assert.ok(text.startsWith("agent/reviewer replied:\nI review pull requests."));
	assert.ok(!/\s\/approve/.test(text) && !text.includes("ghp_abcdef"));
	assert.equal(b.chats.waiting().length, 0);
	assert.equal(b.domain.decisions.length, 0);
});

test("the old automatic notice is shown as such, and a long reply is split into titled parts", async () => {
	const b = withChat();
	await say(b, "/ask qa hello");
	await b.bridge.forwardMessage({ messageId: "n", from: "agent/qa", text: "I take tasks, not chat.", type: "chat.notice", conversationId: "conv_1", labels: { autoReply: "true" } });
	assert.ok(b.telegram.texts().at(-1)!.startsWith("agent/qa replied (automatic notice):"));
	await b.bridge.forwardMessage(reply("agent/qa", "conv_1", `${"word ".repeat(1500)}end`));
	const parts = b.telegram.texts().slice(-3);
	assert.ok(parts.length >= 2 && parts.every((p) => p.length <= 3600));
	assert.ok(parts[0]!.startsWith("agent/qa replied (1/3):") || parts[0]!.includes("(1/"));
	assert.equal(replyParts("x".repeat(20000)).join("").length < 20000, true, "an enormous reply is cut");
});

test("a plain direct chat from an agent outside any owner conversation is still shown, titled with the agent", async () => {
	const b = withChat();
	await b.bridge.forwardMessage({ messageId: "p", from: "agent/aikido-fixer", text: "found 2 issues", type: "chat.message", labels: {} });
	assert.ok(b.telegram.texts().at(-1)!.startsWith("agent/aikido-fixer:\nfound 2 issues"));
});

test("a reply from a different agent in the owner's conversation is not treated as the answer", async () => {
	const b = withChat();
	await say(b, "/ask reviewer hi");
	await b.bridge.forwardMessage(reply("agent/qa", "conv_1", "butting in"));
	assert.equal(b.chats.waiting().length, 1, "still waiting for the reviewer");
	assert.ok(b.telegram.texts().at(-1)!.startsWith("agent/qa:"), "shown, but as an unsolicited message");
});

test("no reply within three minutes gives one timeout notice; a late reply is still shown", async () => {
	let clock = Date.parse("2026-10-06T10:00:00Z");
	const b = withChat({ now: () => clock });
	await say(b, "/ask reviewer anyone there?");
	clock += 2 * 60_000;
	await b.chats.sweep();
	assert.ok(!b.telegram.texts().some((t) => t.includes("No reply")));
	clock += 61_000;
	await b.chats.sweep();
	await b.chats.sweep();
	assert.equal(b.telegram.texts().filter((t) => t.includes("No reply from agent/reviewer after 3 minutes")).length, 1);
	await b.bridge.forwardMessage(reply("agent/reviewer", "conv_1", "sorry, was busy"));
	assert.ok(b.telegram.texts().at(-1)!.includes("sorry, was busy"));
	clock += 10 * 60_000;
	await b.chats.sweep();
	assert.equal(b.telegram.texts().filter((t) => t.includes("No reply")).length, 1, "answered chats never time out");
});

test("a follow-up continues the same conversation and restarts the wait", async () => {
	const b = withChat();
	await say(b, "/ask reviewer first");
	await b.bridge.forwardMessage(reply("agent/reviewer", "conv_1", "ok"));
	await say(b, "/ask reviewer second");
	assert.deepEqual(b.domain.sentMessages.map((m) => m.conversationId), [undefined, "conv_1"]);
	assert.equal(b.chats.waiting().length, 1);
});

test("the owner's chat is limited to 30 messages an hour and 2000 characters", async () => {
	const b = withChat();
	await say(b, `/ask reviewer ${"x".repeat(2001)}`);
	assert.equal(b.domain.sentMessages.length, 0);
	assert.ok(b.telegram.texts().at(-1)!.includes("limited to 2000 characters"));
	await say(b, `/ask reviewer ${"x".repeat(2000)}`);
	assert.equal(b.domain.sentMessages.length, 1);
	for (let i = 0; i < 40; i++) await say(b, `/ask reviewer message ${i}`);
	assert.equal(b.domain.sentMessages.length, 30);
	assert.ok(b.telegram.texts().at(-1)!.includes("chat limit for this hour reached"));
});

test("the Manager never answers chat on its own: replies and notices cause no outgoing message, and the model is never prompted", async () => {
	const b = withChat();
	await say(b, "/ask reviewer hi");
	const before = b.domain.sentMessages.length;
	for (const message of [reply("agent/reviewer", "conv_1", "hello"), { ...reply("agent/reviewer", "conv_1", "notice"), type: "chat.notice", labels: { autoReply: "true" } }, { messageId: "z", from: "agent/qa", text: "ping", type: "chat.message", labels: {} }]) {
		await b.bridge.forwardMessage(message as never);
	}
	assert.equal(b.domain.sentMessages.length, before);
	assert.equal(b.rpcCalls.length, 0);
	assert.equal(b.domain.submitted.length, 0);
});

test("the model's somework_ask tool goes through the same checks and its answer never comes back to the model", async () => {
	const b = withChat();
	const server: Server = createGateway({ service: b.service, token: "t".repeat(40) });
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	const tools = new Map<string, any>();
	const Type = new Proxy({}, { get: (_t, kind) => (value?: unknown) => ({ kind, value }) });
	registerSomeworkTools({ registerTool: (tool) => tools.set(tool.name as string, tool) }, Type, { MANAGER_GATEWAY_URL: url, MANAGER_GATEWAY_TOKEN: "t".repeat(40) });
	const ok = await tools.get("somework_ask").execute("1", { agent: "aikido-fixer", text: "status?" });
	assert.match(ok.content[0].text, /"status":"sent"/);
	assert.equal(b.domain.sentMessages.at(-1)!.to, "agent/aikido-fixer");
	const unknown = await tools.get("somework_ask").execute("2", { agent: "nobody", text: "hi" });
	assert.match(unknown.content[0].text, /unknown_agent/);
	const tooLong = await tools.get("somework_ask").execute("3", { agent: "reviewer", text: "x".repeat(2001) });
	assert.match(tooLong.content[0].text, /message_too_long/);
	assert.equal(b.domain.sentMessages.length, 1);
	assert.ok(b.telegram.texts().some((t) => t.includes("Asked agent/aikido-fixer: status?")), "the owner sees what the model asked");
	server.closeAllConnections();
	server.close();
});

test("an agent's approval question for an instruction reaches the owner, and only the owner's command answers it", async () => {
	const b = withChat();
	await say(b, "/ask reviewer instruct: review the auth change");
	const question = { messageId: "q1", from: "agent/reviewer", type: "chat.message", conversationId: "conv_1", text: "Approval needed for your instruction (reviewer): bash: git push\nAnswer with label chatApprovalDecision=0123456789ab and the text \"approve\"", labels: { chatReply: "true", chatApprovalRequest: "0123456789ab" } };
	assert.equal(await b.chats.route(question as any), true);
	const told = b.telegram.texts().at(-1)!;
	assert.match(told, /agent\/reviewer needs your approval for your instruction:\nApproval needed for your instruction \(reviewer\): bash: git push\nAnswer with \/chatapprove 0123456789ab or \/chatdeny 0123456789ab/);
	assert.ok(!told.includes("label chatApprovalDecision"), "the agent's own wording about labels is not passed on");
	assert.equal(b.domain.sentMessages.length, 1, "nothing is answered by itself");

	await say(b, "/chatapprove 0123456789ab", 999);
	assert.equal(b.domain.sentMessages.length, 1, "a stranger cannot answer");
	await say(b, "/chatapprove 0123456789ab");
	assert.deepEqual(b.domain.sentMessages[1], { to: "agent/reviewer", text: "approve", conversationId: "conv_1", labels: { chatApprovalDecision: "0123456789ab" } });
	assert.ok(b.telegram.texts().at(-1)!.startsWith("Approved for agent/reviewer"));
	await say(b, "/chatdeny 0123456789ab");
	assert.equal(b.domain.sentMessages.length, 2, "a question is answered once");
	assert.match(b.telegram.texts().at(-1)!, /No such question waits/);
});

test("a denial is sent as deny, and an approval question from the wrong agent, conversation or id is ignored", async () => {
	const b = withChat();
	await say(b, "/ask reviewer instruct: go");
	const base = { type: "chat.message", text: "Approval needed", labels: { chatApprovalRequest: "aaaaaaaaaaaa" } };
	assert.equal(await b.chats.route({ ...base, messageId: "a", from: "agent/qa", conversationId: "conv_1" } as any), false, "another agent is not part of the chat");
	assert.equal(await b.chats.route({ ...base, messageId: "b", from: "agent/reviewer", conversationId: "conv_9" } as any), false, "not a conversation the owner started");
	await b.chats.route({ ...base, messageId: "c", from: "agent/reviewer", conversationId: "conv_1", labels: { chatApprovalRequest: "../../x" } } as any);
	assert.equal(Object.keys(b.state.chatApprovals ?? {}).length, 0);
	await b.chats.route({ ...base, messageId: "d", from: "agent/reviewer", conversationId: "conv_1" } as any);
	await say(b, "/chatdeny aaaaaaaaaaaa");
	assert.deepEqual([b.domain.sentMessages[1]?.text, b.domain.sentMessages[1]?.labels], ["deny", { chatApprovalDecision: "aaaaaaaaaaaa" }]);
});

test("an answer that comes after the agent gave up is not sent", async () => {
	let now = Date.parse("2026-10-06T10:00:00Z");
	const b = withChat({ now: () => now });
	await say(b, "/ask reviewer instruct: go");
	await b.chats.route({ messageId: "e", from: "agent/reviewer", type: "chat.message", text: "Approval needed", conversationId: "conv_1", labels: { chatApprovalRequest: "bbbbbbbbbbbb" } } as any);
	now += 31 * 60_000;
	await say(b, "/chatapprove bbbbbbbbbbbb");
	assert.equal(b.domain.sentMessages.length, 1);
	assert.match(b.telegram.texts().at(-1)!, /given up/);
});

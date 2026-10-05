import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { sleep } from "@somework/sdk";
import { startDomain, type Domain } from "../../../sdk/typescript/test/harness.ts";
import { AUTO_REPLY_LABEL, decideReply, defaultReplyText, ReplyLimiter, runChatResponder, type InboundMessage } from "../src/chat.ts";
import { DEFAULT_APPROVAL_PATTERNS } from "../src/policy.ts";
import { validateProfile, type AgentProfile } from "../src/profile.ts";

const T0 = Date.parse("2026-10-05T12:00:00.000Z");
const message = (over: Partial<InboundMessage> = {}): InboundMessage => ({
	messageId: "msg_1",
	type: "chat.message",
	sender: { kind: "agent", id: "agent/requester" },
	conversationId: "conv_1",
	createdAt: new Date(T0 - 1000).toISOString(),
	...over,
});
const state = (over: Partial<Parameters<typeof decideReply>[1]> = {}) => ({ self: "agent/me", now: T0, maxAgeMs: 5 * 60_000, limiter: new ReplyLimiter(), ...over });

describe("when a chat message is answered", () => {
	it("answers a fresh direct chat message", () => {
		assert.deepEqual(decideReply(message(), state()), { reply: true });
	});

	it("never answers itself", () => {
		assert.deepEqual(decideReply(message({ sender: { kind: "agent", id: "agent/me" } }), state()), { reply: false, reason: "own_message" });
	});

	it("only answers plain chat messages: not notices, task status, events or approvals", () => {
		for (const type of ["chat.notice", "task.status", "task.result", "event.notification", "approval.request", "context.offer", "catalog.changed", "policy.denied"]) {
			assert.deepEqual(decideReply(message({ type }), state()), { reply: false, reason: "not_a_chat_message" }, type);
		}
	});

	it("ignores anything carrying the auto-reply marker, even if it claims to be a chat message", () => {
		assert.deepEqual(decideReply(message({ labels: { [AUTO_REPLY_LABEL]: "true" } }), state()), { reply: false, reason: "auto_reply" });
		assert.deepEqual(decideReply(message({ labels: { [AUTO_REPLY_LABEL]: "" } }), state()), { reply: false, reason: "auto_reply" });
		assert.deepEqual(decideReply(message({ labels: { other: "x" } }), state()), { reply: true });
	});

	it("does not answer a backlog: old messages (by their own timestamp) and messages without one are skipped", () => {
		const old = message({ createdAt: new Date(T0 - 5 * 60_000 - 1).toISOString() });
		assert.deepEqual(decideReply(old, state()), { reply: false, reason: "stale" });
		assert.deepEqual(decideReply(message({ createdAt: new Date(T0 - 5 * 60_000).toISOString() }), state()), { reply: true }, "exactly at the limit is still fresh");
		assert.deepEqual(decideReply(message({ createdAt: undefined }), state()), { reply: false, reason: "no_timestamp" });
		assert.deepEqual(decideReply(message({ createdAt: "not a date" }), state()), { reply: false, reason: "no_timestamp" });
	});
});

describe("how often", () => {
	it("allows one reply per sender and conversation per window, then again after it", () => {
		const limiter = new ReplyLimiter(10 * 60_000, 30);
		let now = T0;
		assert.equal(decideReply(message(), state({ limiter, now })).reply, true);
		limiter.record("agent/requester", "conv_1", now);
		now += 9 * 60_000 + 59_000;
		assert.deepEqual(decideReply(message({ createdAt: new Date(now - 1000).toISOString() }), state({ limiter, now })), { reply: false, reason: "rate_limited_sender" });
		now += 2000;
		assert.equal(decideReply(message({ createdAt: new Date(now - 1000).toISOString() }), state({ limiter, now })).reply, true, "the window passed");
	});

	it("treats another sender or another conversation separately", () => {
		const limiter = new ReplyLimiter();
		limiter.record("agent/requester", "conv_1", T0);
		assert.equal(decideReply(message({ sender: { kind: "agent", id: "agent/other" } }), state({ limiter })).reply, true);
		assert.equal(decideReply(message({ conversationId: "conv_2" }), state({ limiter })).reply, true);
		assert.equal(decideReply(message(), state({ limiter })).reply, false);
	});

	it("caps the replies per hour overall and recovers as they age out", () => {
		const limiter = new ReplyLimiter(10 * 60_000, 3);
		for (let i = 0; i < 3; i++) limiter.record(`agent/s${i}`, "c", T0 + i * 1000);
		assert.deepEqual(decideReply(message({ sender: { kind: "agent", id: "agent/fresh" } }), state({ limiter, now: T0 + 5000 })), { reply: false, reason: "rate_limited_total" });
		const later = T0 + 3_600_000 + 500;
		assert.equal(decideReply(message({ sender: { kind: "agent", id: "agent/fresh" }, createdAt: new Date(later - 1000).toISOString() }), state({ limiter, now: later })).reply, true);
	});
});

describe("the notice text", () => {
	it("names the agent, says it is automatic and lists the capabilities", () => {
		const text = defaultReplyText({ agentId: "agent/me", role: "tester", capabilities: [{ id: "code.review", version: "3" }, { id: "code.agent", version: "1" }], sender: { kind: "agent", id: "agent/requester" } });
		for (const needle of ["agent/me", "tester", "tasks, not chat", "code.review@3", "code.agent@1", "automatic"]) assert.ok(text.includes(needle), needle);
		assert.ok(!text.includes("agent/requester"), "nothing the sender sent or is called is echoed back");
	});
});

describe("the profile switch", () => {
	const base: AgentProfile = {
		id: "tester",
		capabilities: [{ id: "code.review", version: "2" }],
		approvalPatterns: DEFAULT_APPROVAL_PATTERNS,
		defaultBudget: { maxTokens: 1000, maxMinutes: 1 },
		git: { push: false, pullRequest: false, branchPrefix: "agent" },
		skills: { allow: [] },
	};
	it("accepts chat settings and refuses nonsense", () => {
		assert.equal(validateProfile({ ...base, chat: { autoReply: false } }).chat?.autoReply, false);
		assert.equal(validateProfile({ ...base, chat: { replyTemplate: () => "hi" } }).id, "tester");
		assert.throws(() => validateProfile({ ...base, chat: { autoReply: "no" as unknown as boolean } }), /chat.autoReply/);
		assert.throws(() => validateProfile({ ...base, chat: { replyTemplate: "text" as unknown as () => string } }), /chat.replyTemplate/);
	});
	it("does nothing when the role turned the responder off", async () => {
		const controller = new AbortController();
		await runChatResponder({ client: undefined as never, agentId: "agent/x", role: "t", capabilities: [], signal: controller.signal, log: () => {}, config: { autoReply: false } });
	});
});

describe("against a real domain", () => {
	let domain: Domain;
	const stop = new AbortController();
	const events: { event: string; fields?: Record<string, unknown> }[] = [];
	const log = (_level: string, event: string, fields?: Record<string, unknown>) => void events.push({ event, fields });
	const poll = { mode: "poll" as const, pollEveryMs: 100 };

	before(async () => {
		domain = await startDomain();
	});
	after(async () => {
		stop.abort();
		await sleep(300);
		await domain.close();
	});

	/** Every message in the principal's inbox (read or not); `notices` are the automatic answers only. */
	const inbox = async (client: Domain["author"]) => ((await client.get("/v1/inbox?limit=200")).messages ?? []) as any[];
	const notices = async (client: Domain["author"], from: string) => (await inbox(client)).filter((m) => m.type === "chat.notice" && m.labels?.[AUTO_REPLY_LABEL] === "true" && m.sender?.id === from);
	const untilCount = async (client: Domain["author"], from: string, count: number, ms = 15_000) => {
		const deadline = Date.now() + ms;
		while (Date.now() < deadline) {
			const found = await notices(client, from);
			if (found.length >= count) return found;
			await sleep(100);
		}
		return notices(client, from);
	};
	const sendChat = (client: Domain["author"], to: string, data: string, extra: Record<string, unknown> = {}) =>
		client.post("/v1/messages", { recipients: [{ kind: "agent", id: to }], content: { mediaType: "text/plain", data }, triggerMode: "directed", ...extra });

	it("sends exactly one notice per window to a sender, in the same conversation, and never answers a notice", async () => {
		void runChatResponder({
			client: domain.worker(),
			agentId: "agent/ts-worker",
			role: "tester",
			capabilities: [{ id: "code.review", version: "2" }],
			signal: stop.signal,
			log,
			wake: poll,
		});
		const sent: any = await sendChat(domain.author, "agent/ts-worker", "are you there? SECRET-TEXT-1");
		const first = await untilCount(domain.author, "agent/ts-worker", 1);
		assert.equal(first.length, 1, "one notice arrived");
		const notice = first[0]!;
		assert.equal(notice.labels?.[AUTO_REPLY_LABEL], "true");
		assert.equal(notice.triggerMode ?? "never", "never", "the notice wakes nobody");
		assert.equal(notice.conversationId, sent.conversationId ?? notice.conversationId, "same conversation as the question");
		assert.equal(notice.replyTo ?? sent.messageId, sent.messageId);
		const body = typeof notice.content?.data === "string" ? notice.content.data : JSON.stringify(notice.content?.data);
		assert.ok(body.includes("agent/ts-worker") && body.includes("code.review@2"), body);
		assert.ok(!body.includes("SECRET-TEXT-1"), "the sender's words are not echoed");

		await sendChat(domain.author, "agent/ts-worker", "hello again, second question");
		await sleep(1500);
		assert.equal((await notices(domain.author, "agent/ts-worker")).length, 1, "a second message inside the window gets no second notice");

		await domain.author.post("/v1/messages", { type: "chat.notice", recipients: [{ kind: "agent", id: "agent/ts-worker" }], content: { mediaType: "text/plain", data: "fyi" }, triggerMode: "never" });
		await sleep(1200);
		assert.equal((await notices(domain.author, "agent/ts-worker")).length, 1, "a notice sent to the agent is not answered");
	});

	it("logs what happened without the message text", () => {
		const received = events.filter((e) => e.event === "chat_message_received");
		assert.ok(received.some((e) => e.fields?.replied === true), "a reply was logged");
		assert.ok(events.some((e) => e.event === "chat_reply_sent"));
		assert.ok(!JSON.stringify(events).includes("SECRET-TEXT-1"), "the text never reaches the log");
	});

	it("two agents on the kit that message each other end after one notice each", async () => {
		void runChatResponder({
			client: domain.author,
			agentId: "agent/ts-author",
			role: "other",
			capabilities: [{ id: "code.agent", version: "1" }],
			signal: stop.signal,
			log,
			wake: poll,
		});
		await sendChat(domain.worker(), "agent/ts-author", "hello author, from the worker");
		const answered = await untilCount(domain.worker(), "agent/ts-author", 1);
		assert.equal(answered.length, 1, "the author's agent answered the worker once");
		await sleep(2500);
		const all = async (client: Domain["author"]) => (await inbox(client)).filter((m) => m.type === "chat.notice" || m.type === "chat.message").length;
		const before = [await all(domain.author), await all(domain.worker())];
		await sleep(2500);
		assert.deepEqual([await all(domain.author), await all(domain.worker())], before, "no ping-pong: the message counts stay fixed");
		assert.equal((await notices(domain.worker(), "agent/ts-author")).length, 1);
		assert.equal((await notices(domain.author, "agent/ts-worker")).length, 1);
	});
});

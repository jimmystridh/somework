import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { sleep, type Job, type Outcome } from "@somework/sdk";
import {
	askToolNames,
	buildState,
	ChatApprovals,
	DEFAULT_CHAT_MODEL,
	finishReply,
	frameChat,
	instructionOf,
	instructToolNames,
	ModelChatResponder,
	repositoryTarget,
	resolveChatMode,
	resolveChatModel,
	senderMatches,
	takeOptions,
	validateChatConfig,
	type ChatModelSettings,
	type ModelChatDeps,
} from "../src/chat-model.ts";
import { AUTO_REPLY_LABEL, CHAT_APPROVAL_DECISION_LABEL, CHAT_APPROVAL_REQUEST_LABEL, CHAT_REPLY_LABEL, type InboundMessage } from "../src/chat.ts";
import { JobGate } from "../src/gate.ts";
import { describeOutcome, JobJournal } from "../src/journal.ts";
import { DailyLedger } from "../src/ledger.ts";

const T0 = Date.parse("2026-10-05T12:00:00.000Z");
const MANAGER = { kind: "agent", id: "agent/manager" };
const HUMAN = { kind: "human", id: "human/jimmy" };
const STRANGER = { kind: "agent", id: "agent/stranger" };

/** A person asking: the per-sender wait applies to askers; the manager (an instructor, the owner's proxy) is exempt, see below. */
const askerIncoming = (over: Partial<InboundMessage> = {}): InboundMessage => incoming({ sender: HUMAN, ...over });
const incoming = (over: Partial<InboundMessage> = {}): InboundMessage => ({
	messageId: `msg_${Math.random().toString(36).slice(2, 8)}`,
	type: "chat.message",
	sender: MANAGER,
	conversationId: "conv_1",
	createdAt: new Date(T0 - 1000).toISOString(),
	text: "how are you?",
	...over,
});

interface Posted {
	path: string;
	body: any;
}

function harness(over: Partial<ModelChatDeps> = {}, settings: Partial<ChatModelSettings> = {}) {
	const posts: Posted[] = [];
	const requests: any[] = [];
	const jobs: { job: Job; control: any }[] = [];
	const dir = mkdtempSync(join(tmpdir(), "chat-model-"));
	const ledger = new DailyLedger(join(dir, "ledger.json"), 1_000_000, undefined, { share: 0.2 }, { share: 0.1 });
	const history: any[] = [];
	const client = {
		async get(path: string): Promise<any> {
			if (path.includes("/messages?")) return { messages: history };
			return { message: { content: { data: "from the domain" } } };
		},
		async post(path: string, body: any): Promise<any> {
			posts.push({ path, body });
			return {};
		},
	};
	const runtime = {
		answer: "all fine",
		tokens: 500,
		failWith: undefined as string | undefined,
		async execute(request: any) {
			requests.push(request);
			if (runtime.failWith) throw new Error(runtime.failWith);
			return { status: "done" as const, answer: runtime.answer, usage: { inputTokens: 1, outputTokens: 1, totalTokens: runtime.tokens, costUsd: 0 } };
		},
	};
	const approvals = new ChatApprovals({ client, log: () => undefined, timeoutMinutes: 0.01 });
	const gate = new JobGate(1);
	const handlerResult: { outcome: Outcome; hold?: Promise<void>; seen: Job[] } = { outcome: { type: "completed", result: { outcome: "pr_opened", summary: "fixed it", prUrl: "https://github.test/pr/1", branch: "agent/x" } } as Outcome, seen: [] };
	const handler = async (job: Job, control: any): Promise<Outcome> => {
		jobs.push({ job, control });
		handlerResult.seen.push(job);
		await handlerResult.hold;
		return handlerResult.outcome;
	};
	const deps: ModelChatDeps = {
		client: client as any,
		agentId: "agent/me",
		role: "tester",
		settings: { ...DEFAULT_CHAT_MODEL, busyAfterSeconds: 0.05, ...settings },
		ledger,
		ask: { runtime: runtime as any, tools: ["read", "agent_status"], instructions: "You are the tester.", state: async () => "state: all good", fallbackWorkspace: dir },
		instruct: {
			handler: handler as any,
			input: (text) => (text.includes("nonsense") ? { refuse: "that is not something I do" } : { capability: { id: "do.it", version: "1" }, input: { what: text, budget: { maxTokens: 999_999_999, maxMinutes: 9999 } } }),
			gate,
			approvals,
		},
		log: () => undefined,
		now: () => T0,
		boundary: () => "BOUNDARY",
		...over,
	};
	const responder = new ModelChatResponder(deps);
	return { responder, posts, requests, jobs, runtime, ledger, history, approvals, gate, handlerResult, deps, dir };
}

const replies = (posts: Posted[]) => posts.filter((post) => post.body.labels?.[CHAT_REPLY_LABEL] !== undefined && post.body.labels?.[CHAT_APPROVAL_REQUEST_LABEL] === undefined).map((post) => post.body.content.data as string);

describe("chat mode and settings from the environment", () => {
	it("is the model unless the role says notice, and CHAT_MODE wins", () => {
		assert.equal(resolveChatMode(undefined, {}), "model");
		assert.equal(resolveChatMode({ mode: "notice" }, {}), "notice");
		assert.equal(resolveChatMode({ mode: "notice" }, { CHAT_MODE: "model" }), "model");
		assert.equal(resolveChatMode(undefined, { CHAT_MODE: "notice" }), "notice");
		assert.throws(() => resolveChatMode(undefined, { CHAT_MODE: "yes" }), /CHAT_MODE/);
	});

	it("applies the environment and never lets a cap pass the hard cap", () => {
		const settings = resolveChatModel(undefined, { CHAT_TOKEN_CAP: "999999", CHAT_HARD_TOKEN_CAP: "50000", CHAT_INSTRUCT_TOKENS: "900000", CHAT_ALLOWED_SENDERS: "agent/a, kind:human", CHAT_INSTRUCTORS: "agent/a" });
		assert.equal(settings.tokenCap, 50_000);
		assert.equal(settings.instructBudget.maxTokens, 50_000);
		assert.deepEqual(settings.askers, ["agent/a", "kind:human"]);
		assert.deepEqual(settings.instructors, ["agent/a"]);
		assert.deepEqual(resolveChatModel(undefined, {}).instructors, ["agent/manager"]);
	});

	it("refuses nonsense values, and a share above one", () => {
		assert.throws(() => resolveChatModel(undefined, { CHAT_TOKEN_CAP: "0" }), /CHAT_TOKEN_CAP/);
		assert.throws(() => resolveChatModel(undefined, { CHAT_MAX_MINUTES: "abc" }), /CHAT_MAX_MINUTES/);
		assert.throws(() => resolveChatModel(undefined, { CHAT_TOKEN_SHARE: "2" }), /at most 1/);
	});

	it("validates the profile: no writing tool for the ask tier, positive numbers, known modes", () => {
		assert.doesNotThrow(() => validateChatConfig("x", undefined));
		assert.doesNotThrow(() => validateChatConfig("x", { tools: { ask: ["read"], instruct: ["read", "bash"] } }));
		assert.throws(() => validateChatConfig("x", { tools: { ask: ["read", "bash"] } }), /ask tier may not offer bash/);
		for (const tool of ["edit", "write"]) assert.throws(() => validateChatConfig("x", { tools: { ask: [tool] } }), /may not offer/);
		assert.throws(() => validateChatConfig("x", { mode: "loud" as any }), /chat.mode/);
		assert.throws(() => validateChatConfig("x", { tokenCap: -1 }), /tokenCap/);
		assert.throws(() => validateChatConfig("x", { instructBudget: { maxTokens: 0, maxMinutes: 1 } }), /instructBudget/);
	});
});

describe("the tool sets of the two tiers", () => {
	it("gives the ask tier read, agent_status and the role's read-only tools, never a writing tool", () => {
		assert.deepEqual(askToolNames(undefined, undefined), ["read", "agent_status"]);
		assert.deepEqual(askToolNames(undefined, { askToolNames: ["aikido_lookup", "read"] }), ["read", "agent_status", "aikido_lookup"]);
		assert.deepEqual(askToolNames({ tools: { ask: ["read"] } }, { askToolNames: ["x"] }), ["read"]);
		assert.throws(() => askToolNames({ tools: { ask: ["write"] } }, undefined), /may not offer/);
	});

	it("gives the instruct tier what the profile lists, else the role's normal tools", () => {
		assert.deepEqual(instructToolNames(undefined, ["read", "bash", "read"]), ["read", "bash"]);
		assert.deepEqual(instructToolNames({ tools: { instruct: ["read"] } }, ["read", "bash"]), ["read"]);
		assert.deepEqual(instructToolNames(undefined, undefined), ["read", "write", "edit", "bash"]);
	});
});

describe("the small helpers", () => {
	it("matches senders by id or by kind", () => {
		assert.ok(senderMatches(["agent/manager"], MANAGER));
		assert.ok(senderMatches(["kind:human"], HUMAN));
		assert.ok(!senderMatches(["agent/manager", "kind:human"], STRANGER));
		assert.ok(!senderMatches([], MANAGER));
	});

	it("reads an instruction only after the prefix, in any case, and a question otherwise", () => {
		assert.equal(instructionOf("instruct: fix it", "instruct:"), "fix it");
		assert.equal(instructionOf("  INSTRUCT:fix it", "instruct:"), "fix it");
		assert.equal(instructionOf("instruct:", "instruct:"), "");
		assert.equal(instructionOf("please instruct: fix it", "instruct:"), undefined);
		assert.equal(instructionOf("what is instruct: ?", "instruct:"), undefined);
	});

	it("takes only the named option lines at the top, once each", () => {
		const parsed = takeOptions("repo: https://github.com/a/b\nref: main\nrepo: other\nfix it", ["repo", "ref"]);
		assert.deepEqual(parsed.options, { repo: "https://github.com/a/b", ref: "main" });
		assert.equal(parsed.rest, "repo: other\nfix it");
		assert.deepEqual(takeOptions("unknown: x\nfix", ["repo"]), { options: {}, rest: "unknown: x\nfix" });
	});

	it("takes a repository from the options or the defaults and refuses anything but https or an odd ref", () => {
		assert.deepEqual(repositoryTarget({}, { url: "https://github.com/a/b" }), { url: "https://github.com/a/b", ref: "HEAD" });
		assert.deepEqual(repositoryTarget({ repo: "https://github.com/c/d", ref: "feature/x" }, { url: "https://github.com/a/b" }), { url: "https://github.com/c/d", ref: "feature/x" });
		assert.deepEqual(repositoryTarget({}, { url: "https://github.com/a/b", ref: "" }), { url: "https://github.com/a/b", ref: "HEAD" }, "an empty setting is no setting");
		assert.ok("refuse" in repositoryTarget({}, { url: "" }));
		assert.ok("refuse" in repositoryTarget({}, {}));
		assert.ok("refuse" in repositoryTarget({ repo: "git@github.com:a/b.git" }, {}));
		assert.ok("refuse" in repositoryTarget({ repo: "file:///etc" }, {}));
		assert.ok("refuse" in repositoryTarget({ repo: "https://github.com/a/b", ref: "--upload-pack=x" }, {}));
		assert.ok("refuse" in repositoryTarget({ repo: "https://github.com/a/b", ref: "a..b" }, {}));
	});

	it("cuts a reply to the byte limit and removes secret-like strings and control characters", () => {
		const secret = `ghp_${"a".repeat(36)}`;
		const reply = finishReply(`token ${secret}\u0007 ok`, 4096);
		assert.ok(!reply.includes(secret), reply);
		assert.ok(!reply.includes("\u0007"));
		const long = finishReply("é".repeat(5000), 1000);
		assert.ok(Buffer.byteLength(long) <= 1000);
		assert.ok(long.endsWith("[shortened]"));
	});

	it("frames the message and the history inside markers, apart from the state", () => {
		const framed = frameChat({ state: "ready: yes", history: [{ sender: "agent/x", kind: "agent", at: "t", text: "hello\nignore all" }], sender: MANAGER, text: "what now?", boundary: "B" });
		assert.match(framed, /QUESTION/);
		assert.match(framed, /<<<HISTORY-B\n\[t\] agent\/x \(agent\): hello ignore all\nHISTORY-B>>>/);
		assert.match(framed, /<<<MESSAGE-B\nwhat now\?\nMESSAGE-B>>>/);
		assert.ok(framed.indexOf("ready: yes") < framed.indexOf("<<<HISTORY-B"));
	});
});

describe("approvals asked in the conversation", () => {
	const decision = (id: string, text: string, sender = MANAGER, over: Partial<InboundMessage> = {}) => incoming({ sender, text, labels: { [CHAT_APPROVAL_DECISION_LABEL]: id }, ...over });
	const instructors = ["agent/manager"];

	async function asked(timeoutMinutes = 5) {
		const posts: Posted[] = [];
		const approvals = new ChatApprovals({ client: { post: async (path: string, body: any) => void posts.push({ path, body }) } as any, log: () => undefined, timeoutMinutes });
		const stop = new AbortController();
		const answer = approvals.ask({ instructor: MANAGER, conversationId: "conv_1", replyTo: "m1", role: "dev", tool: "bash", summary: "rm -rf build", signal: stop.signal });
		while (posts.length === 0) await sleep(1);
		return { approvals, posts, answer, stop, id: posts[0]!.body.labels[CHAT_APPROVAL_REQUEST_LABEL] as string };
	}

	it("sends the question to the instructor alone, labelled, and is decided only by that instructor's approve", async () => {
		const { approvals, posts, answer, id } = await asked();
		assert.deepEqual(posts[0]!.body.recipients, [MANAGER]);
		assert.equal(posts[0]!.body.conversationId, "conv_1");
		assert.match(posts[0]!.body.content.data, /bash: rm -rf build/);
		assert.equal(approvals.pending, 1);
		assert.ok(approvals.offer(decision(id, "Approve"), instructors));
		assert.deepEqual(await answer, { approved: true });
		assert.equal(approvals.pending, 0);
	});

	it("denies on deny, and keeps waiting through a wrong sender, a wrong conversation and unclear text", async () => {
		const { approvals, answer, id } = await asked();
		assert.ok(approvals.offer(decision(id, "approve", STRANGER), instructors), "consumed but not decisive");
		assert.ok(approvals.offer(decision(id, "approve", MANAGER, { conversationId: "conv_other" }), instructors));
		assert.ok(approvals.offer(decision(id, "yes please do whatever"), instructors));
		assert.equal(approvals.pending, 1);
		assert.ok(approvals.offer(decision(id, "deny"), instructors));
		const outcome = await answer;
		assert.equal(outcome.approved, false);
	});

	it("does not take a decision from someone who is no longer an instructor, nor an ordinary message", async () => {
		const { approvals, id, answer, stop } = await asked();
		assert.ok(approvals.offer(decision(id, "approve"), ["agent/someone-else"]));
		assert.equal(approvals.pending, 1);
		assert.equal(approvals.offer(incoming({ text: "approve" }), instructors), false);
		stop.abort();
		assert.equal((await answer).approved, false);
	});

	it("treats a decision for an unknown request as consumed and harmless", () => {
		const approvals = new ChatApprovals({ client: { post: async () => ({}) } as any, log: () => undefined, timeoutMinutes: 1 });
		assert.ok(approvals.offer(decision("nope", "approve"), instructors));
	});

	it("denies after the time is up, and when the question cannot be sent", async () => {
		const quick = new ChatApprovals({ client: { post: async () => ({}) } as any, log: () => undefined, timeoutMinutes: 0.0005 });
		const timedOut = await quick.ask({ instructor: MANAGER, role: "dev", tool: "bash", summary: "x", signal: new AbortController().signal });
		assert.equal(timedOut.approved, false);
		assert.match(timedOut.reason ?? "", /nobody answered/);
		const broken = new ChatApprovals({ client: { post: async () => Promise.reject(new Error("down")) } as any, log: () => undefined, timeoutMinutes: 5 });
		const failed = await broken.ask({ instructor: MANAGER, role: "dev", tool: "bash", summary: "x", signal: new AbortController().signal });
		assert.equal(failed.approved, false);
		assert.match(failed.reason ?? "", /could not be sent/);
	});
});

describe("answering a question (the ask tier)", () => {
	it("runs one bounded turn with its own tools and instructions, answers in the conversation and spends the chat pool", async () => {
		const h = harness();
		const outcome = await h.responder.handle(incoming({ messageId: "q1", text: "what did you do today?" }));
		assert.deepEqual(outcome, { answered: true });
		assert.equal(h.requests.length, 1);
		const request = h.requests[0];
		assert.deepEqual(request.tools, ["read", "agent_status"]);
		assert.equal(request.instructions, "You are the tester.");
		assert.equal(request.requestId, "chat:q1");
		assert.ok(request.budget.maxTokens <= DEFAULT_CHAT_MODEL.tokenCap);
		assert.match(request.instruction, /state: all good/);
		assert.match(request.instruction, /<<<MESSAGE-BOUNDARY\nwhat did you do today\?\nMESSAGE-BOUNDARY>>>/);
		assert.deepEqual(replies(h.posts), ["all fine"]);
		const post = h.posts[0]!;
		assert.deepEqual(post.body.recipients, [MANAGER]);
		assert.equal(post.body.replyTo, "q1");
		assert.equal(post.body.conversationId, "conv_1");
		assert.equal(post.body.triggerMode, "directed");
		assert.equal(h.ledger.chatRemaining(), 100_000 - 500);
		assert.equal(h.jobs.length, 0, "a question never starts a job");
	});

	it("answers a human too, as the default askers say", async () => {
		const h = harness();
		assert.deepEqual(await h.responder.handle(incoming({ sender: HUMAN })), { answered: true });
	});

	it("never answers a question with a secret-like string, and cuts a long answer", async () => {
		const h = harness();
		h.runtime.answer = `here: ghp_${"b".repeat(36)} ${"x".repeat(9000)}`;
		await h.responder.handle(incoming());
		const [reply] = replies(h.posts);
		assert.ok(!reply!.includes("ghp_"), "redacted");
		assert.ok(Buffer.byteLength(reply!) <= DEFAULT_CHAT_MODEL.replyMaxBytes);
	});

	it("shows the model the earlier messages of the conversation, trimmed in number and length, without approval traffic", async () => {
		const h = harness({}, { historyMessages: 3, messageChars: 20 });
		for (let i = 0; i < 6; i++) h.history.push({ type: "chat.message", messageId: `h${i}`, sender: MANAGER, createdAt: `2026-10-05T11:0${i}:00Z`, content: { data: `message number ${i} ${"y".repeat(40)}` } });
		h.history.push({ type: "chat.message", messageId: "ap", sender: MANAGER, content: { data: "approve" }, labels: { [CHAT_APPROVAL_DECISION_LABEL]: "z" } });
		await h.responder.handle(incoming({ messageId: "now" }));
		const lines = (h.requests[0].instruction as string).split("\n").filter((line) => line.startsWith("[2026-10-05T11:"));
		assert.equal(lines.length, 3);
		assert.ok(lines.every((line) => line.endsWith("...")), "each line is cut");
		assert.ok(!h.requests[0].instruction.includes(": approve"), "approval traffic is not history");
		assert.match(lines[2]!, /message number 5/);
	});

	it("halves the cap when the pool is throttled and never exceeds what is left of it", async () => {
		const h = harness({}, { tokenCap: 40_000 });
		h.ledger.record(85_000, "chat");
		await h.responder.handle(incoming({ messageId: "t1" }));
		assert.equal(h.requests[0].budget.maxTokens, 15_000, "remaining 15000 is below half the cap");
		const g = harness({}, { tokenCap: 8_000 });
		g.ledger.record(85_000, "chat");
		await g.responder.handle(incoming());
		assert.equal(g.requests[0].budget.maxTokens, 4_000);
	});

	it("answers with a notice when the chat pool is used up, without calling the model", async () => {
		const h = harness();
		h.ledger.record(100_000, "chat");
		const outcome = await h.responder.handle(incoming());
		assert.equal(outcome.answered, false);
		assert.equal(!outcome.answered && outcome.reason, "pool_stopped");
		assert.match(!outcome.answered ? outcome.fallback?.text ?? "" : "", /chat budget/);
		assert.equal(h.requests.length, 0);
	});

	it("falls back to a notice when the model fails or says nothing", async () => {
		const h = harness();
		h.runtime.failWith = "provider exploded";
		const failed = await h.responder.handle(incoming());
		assert.equal(!failed.answered && failed.reason, "model_failed");
		assert.ok(!failed.answered && failed.fallback);
		h.runtime.failWith = undefined;
		h.runtime.answer = "   ";
		const empty = await h.responder.handle(incoming({ sender: HUMAN }));
		assert.equal(!empty.answered && empty.reason, "empty_answer");
	});

	it("uses the read-only checkout as the workspace when there is one, and the fallback when it fails", async () => {
		const h = harness();
		h.deps.ask.checkout = async () => "/srv/checkout";
		await h.responder.handle(incoming());
		assert.equal(h.requests[0].workspace, "/srv/checkout");
		const g = harness();
		g.deps.ask.checkout = async () => Promise.reject(new Error("no network"));
		await g.responder.handle(incoming());
		assert.equal(g.requests[0].workspace, g.dir);
	});

	it("refuses every approval the ask session asks for", async () => {
		const h = harness();
		h.deps.ask.runtime = {
			async execute(request: any, hooks: any) {
				const decision = await hooks.requestApproval({ tool: "bash", summary: "rm" });
				return { status: "done", answer: decision.approved ? "approved?!" : "refused", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 10, costUsd: 0 } };
			},
		} as any;
		await h.responder.handle(incoming());
		assert.deepEqual(replies(h.posts), ["refused"]);
	});
});

describe("who may talk to the agent, and what is not answered", () => {
	it("gives a sender who is not allowed a notice and no model turn", async () => {
		const h = harness();
		const outcome = await h.responder.handle(incoming({ sender: STRANGER }));
		assert.equal(!outcome.answered && outcome.reason, "sender_not_allowed");
		assert.match(!outcome.answered ? outcome.fallback?.text ?? "" : "", /manager and from people/);
		assert.equal(h.requests.length, 0);
		assert.equal(h.posts.length, 0, "the caller sends the notice");
	});

	it("ignores its own messages, replies, auto-replies, other message types, stale and duplicate messages, silently", async () => {
		const h = harness();
		const cases: [Partial<InboundMessage>, string][] = [
			[{ sender: { kind: "agent", id: "agent/me" } }, "own_message"],
			[{ type: "chat.notice" }, "not_a_chat_message"],
			[{ labels: { [AUTO_REPLY_LABEL]: "true" } }, "auto_reply"],
			[{ labels: { [CHAT_REPLY_LABEL]: "true" } }, "chat_reply"],
			[{ createdAt: undefined }, "no_timestamp"],
			[{ createdAt: new Date(T0 - 6 * 60_000).toISOString() }, "stale"],
		];
		for (const [over, reason] of cases) {
			const outcome = await h.responder.handle(incoming(over));
			assert.equal(!outcome.answered && outcome.reason, reason);
			assert.ok(!outcome.answered && outcome.fallback === undefined, `${reason} gets no notice either`);
		}
		await h.responder.handle(incoming({ messageId: "dup" }));
		const again = await h.responder.handle(incoming({ messageId: "dup" }));
		assert.equal(!again.answered && again.reason, "duplicate");
		assert.equal(h.requests.length, 1);
	});

	it("allows one answer per sender and conversation per window, and a number per hour", async () => {
		const h = harness({}, { senderWindowMs: 15_000, hourlyLimit: 2 });
		await h.responder.handle(askerIncoming());
		const second = await h.responder.handle(askerIncoming());
		assert.equal(!second.answered && second.reason, "rate_limited_sender");
		await h.responder.handle(askerIncoming({ conversationId: "conv_2" }));
		const third = await h.responder.handle(askerIncoming({ conversationId: "conv_3" }));
		assert.equal(!third.answered && third.reason, "rate_limited_total");
		assert.equal(h.requests.length, 2);
	});

	it("does not make the manager wait between messages, but still counts them against the hourly cap", async () => {
		const h = harness({}, { senderWindowMs: 15_000, hourlyLimit: 3 });
		const first = await h.responder.handle(incoming());
		const second = await h.responder.handle(incoming());
		assert.ok(first.answered && second.answered, "a follow-up from the manager is answered at once");
		await h.responder.handle(incoming());
		const fourth = await h.responder.handle(incoming());
		assert.equal(!fourth.answered && fourth.reason, "rate_limited_total");
	});

	it("reads the text from the domain when the message does not carry it", async () => {
		const h = harness();
		await h.responder.handle(incoming({ text: undefined }));
		assert.match(h.requests[0].instruction, /from the domain/);
	});
});

describe("a message that comes too soon", () => {
	const notices = (posts: Posted[]) => posts.filter((post) => post.body.type === "chat.notice");

	it("gets one deterministic notice per window, labelled autoReply, that wakes nobody, and never a second in the same window", async () => {
		const clock = { now: T0 };
		const h = harness({ now: () => clock.now }, { senderWindowMs: 15_000, instructors: [] });
		await h.responder.handle(incoming({ messageId: "first", createdAt: new Date(T0 - 500).toISOString() }));
		clock.now = T0 + 4_000;
		const second = await h.responder.handle(incoming({ messageId: "second", createdAt: new Date(T0 + 3_500).toISOString() }));
		assert.equal(!second.answered && second.reason, "rate_limited_sender");
		const [notice] = notices(h.posts);
		assert.ok(notice, "the sender is told");
		assert.equal(notice!.body.triggerMode, "never");
		assert.equal(notice!.body.labels[AUTO_REPLY_LABEL], "true");
		assert.deepEqual(notice!.body.recipients, [MANAGER]);
		assert.equal(notice!.body.conversationId, "conv_1");
		assert.equal(notice!.body.replyTo, "second");
		assert.match(notice!.body.content.data, /I answered you 4 seconds ago; send your next message after 11 seconds\./);
		clock.now = T0 + 6_000;
		await h.responder.handle(incoming({ messageId: "third", createdAt: new Date(T0 + 5_500).toISOString() }));
		await h.responder.handle(incoming({ messageId: "fourth", createdAt: new Date(T0 + 5_900).toISOString() }));
		assert.equal(notices(h.posts).length, 1, "not repeated within the window");
		assert.equal(h.requests.length, 1, "none of them reached the model");
	});

	it("tells the next window's early message again, and another sender or conversation separately", async () => {
		const clock = { now: T0 };
		const h = harness({ now: () => clock.now }, { senderWindowMs: 15_000, instructors: [] });
		const send = (id: string, over: Partial<InboundMessage> = {}) => h.responder.handle(incoming({ messageId: id, createdAt: new Date(clock.now - 200).toISOString(), ...over }));
		await send("a1");
		clock.now += 1_000;
		await send("a2");
		clock.now += 20_000;
		await send("a3");
		clock.now += 1_000;
		await send("a4");
		assert.equal(notices(h.posts).length, 2, "one per window");
		clock.now += 20_000;
		await send("h1", { sender: HUMAN });
		await send("h2", { sender: HUMAN, conversationId: "conv_2" });
		await send("h3", { sender: HUMAN });
		assert.equal(notices(h.posts).filter((post) => post.body.recipients[0].id === HUMAN.id).length, 1);
	});

	it("says so when the previous message was still being worked on, and still never answers notices or its own messages", async () => {
		const clock = { now: T0 };
		const h = harness({ now: () => clock.now }, { senderWindowMs: 15_000, instructors: [] });
		let free!: () => void;
		const blocker = new Promise<void>((resolve) => (free = resolve));
		const original = h.runtime.execute.bind(h.runtime);
		let entered = false;
		h.runtime.execute = async (request: any) => {
			entered = true;
			await blocker;
			return original(request);
		};
		const one = h.responder.handle(incoming({ messageId: "w1" }));
		while (!entered) await sleep(1);
		const two = h.responder.handle(incoming({ messageId: "w2" }));
		clock.now = T0 + 2_000;
		free();
		await Promise.all([one, two]);
		assert.match(notices(h.posts)[0]!.body.content.data, /one message at a time; your previous one was still being worked on/);
		const before = h.posts.length;
		await h.responder.handle(incoming({ type: "chat.notice", sender: STRANGER }));
		await h.responder.handle(incoming({ labels: { [AUTO_REPLY_LABEL]: "true" } }));
		await h.responder.handle(incoming({ sender: { kind: "agent", id: "agent/me" } }));
		assert.equal(h.posts.length, before);
	});
});

describe("giving an instruction (the instruct tier)", () => {
	it("runs the role's own handler as a job with the role's capability and a budget the message cannot change", async () => {
		const h = harness();
		const outcome = await h.responder.handle(incoming({ messageId: "i1", text: "instruct: fix the thing" }));
		assert.deepEqual(outcome, { answered: true });
		assert.equal(h.requests.length, 0, "no ask session");
		const { job } = h.jobs[0]!;
		assert.equal(job.taskId, "chat-i1");
		assert.deepEqual(job.capability, { id: "do.it", version: "1" });
		const input = job.input as any;
		assert.equal(input.what, "fix the thing");
		assert.deepEqual(input.budget, { maxTokens: 100_000, maxMinutes: DEFAULT_CHAT_MODEL.instructBudget.maxMinutes }, "clamped to the chat pool and the profile, not the input's own");
		const [reply] = replies(h.posts);
		assert.match(reply!, /Done \(pr_opened\)/);
		assert.match(reply!, /Pull request: https:\/\/github.test\/pr\/1/);
		assert.match(reply!, /Branch: agent\/x/);
	});

	it("tells a human who instructs that only the instructors may, and does nothing", async () => {
		const h = harness();
		const outcome = await h.responder.handle(incoming({ sender: HUMAN, text: "instruct: fix the thing" }));
		assert.equal(!outcome.answered && outcome.reason, "instruct_not_allowed");
		assert.equal(h.jobs.length, 0);
		assert.equal(h.requests.length, 0);
		assert.match(replies(h.posts)[0]!, /Only agent\/manager can give me instructions/);
	});

	it("says why an instruction is outside the contract, and an empty one, without running anything", async () => {
		const h = harness();
		await h.responder.handle(incoming({ text: "instruct: some nonsense" }));
		await sleep(1);
		const empty = harness();
		await empty.responder.handle(incoming({ text: "instruct:" }));
		assert.match(replies(h.posts)[0]!, /cannot do that as an instruction: that is not something I do/);
		assert.match(replies(empty.posts)[0]!, /nothing after instruct:/);
		assert.equal(h.jobs.length + empty.jobs.length, 0);
	});

	it("refuses instructions when the role takes none", async () => {
		const h = harness({ instruct: undefined });
		const outcome = await h.responder.handle(incoming({ text: "instruct: do it" }));
		assert.equal(!outcome.answered && outcome.reason, "no_instruct_tier");
		assert.match(replies(h.posts)[0]!, /do not take instructions in chat/);
	});

	it("reports a failed job in words, and says when the contract was the problem", async () => {
		const h = harness();
		h.handlerResult.outcome = { type: "failed", failure: { code: "invalid_input", message: "ticket is required", retryable: false } } as Outcome;
		await h.responder.handle(incoming({ text: "instruct: go" }));
		assert.match(replies(h.posts)[0]!, /could not do that \(invalid_input\): ticket is required\. This is outside what I can do/);
	});

	it("asks the instructor for an approval and relays the answer back to the job", async () => {
		const h = harness();
		h.handlerResult.hold = Promise.resolve();
		const done = h.responder.handle(incoming({ messageId: "i2", text: "instruct: go" }));
		while (h.jobs.length === 0) await sleep(1);
		const approval = h.jobs[0]!.control.requestInput({ tool: "bash", summary: "git push" });
		while (!h.posts.some((post) => post.body.labels?.[CHAT_APPROVAL_REQUEST_LABEL])) await sleep(1);
		const request = h.posts.find((post) => post.body.labels?.[CHAT_APPROVAL_REQUEST_LABEL])!;
		assert.deepEqual(request.body.recipients, [MANAGER]);
		assert.ok(h.responder.offerDecision(incoming({ text: "approve", labels: { [CHAT_APPROVAL_DECISION_LABEL]: request.body.labels[CHAT_APPROVAL_REQUEST_LABEL] } })));
		assert.deepEqual(await approval, { approved: true });
		await done;
	});

	it("denies an approval nobody answers", async () => {
		const h = harness();
		await h.responder.handle(incoming({ text: "instruct: go" }));
		const answer = await h.jobs[0]!.control.requestInput({ tool: "bash", summary: "x" });
		assert.equal(answer.approved, false, "no answer within the (tiny) approval time");
	});

	it("does not start the instruction when the chat pool is used up", async () => {
		const h = harness();
		h.ledger.record(100_000, "chat");
		const outcome = await h.responder.handle(incoming({ text: "instruct: go" }));
		assert.equal(!outcome.answered && outcome.reason, "pool_stopped");
		assert.equal(h.jobs.length, 0);
	});

	it("waits for a free slot behind a task, says it is queued and then runs", async () => {
		const h = harness();
		const release = await h.gate.acquire("task");
		const done = h.responder.handle(incoming({ messageId: "i3", text: "instruct: go" }));
		await sleep(150);
		assert.equal(h.jobs.length, 0, "the task has the slot");
		assert.ok(replies(h.posts).some((text) => /busy with a task/.test(text)), replies(h.posts).join("|"));
		release();
		await done;
		assert.equal(h.jobs.length, 1);
	});
});

describe("one turn at a time", () => {
	it("answers messages in order and says so when a message had to wait", async () => {
		const h = harness();
		let free!: () => void;
		const blocker = new Promise<void>((resolve) => (free = resolve));
		const original = h.runtime.execute.bind(h.runtime);
		let first = true;
		h.runtime.execute = async (request: any) => {
			if (first) {
				first = false;
				await blocker;
			}
			return original(request);
		};
		const one = h.responder.handle(incoming({ messageId: "a", conversationId: "c1" }));
		const two = h.responder.handle(incoming({ messageId: "b", conversationId: "c2" }));
		await sleep(150);
		assert.ok(replies(h.posts).some((text) => /busy with another turn/.test(text)));
		free();
		await Promise.all([one, two]);
		assert.deepEqual(h.requests.map((request) => request.requestId), ["chat:a", "chat:b"]);
	});
});

describe("the gate that shares the job slots", () => {
	it("runs at most its capacity and gives a waiting task the slot before a waiting chat", async () => {
		const gate = new JobGate(1);
		const order: string[] = [];
		const release = await gate.acquire("task");
		const chat = gate.run("chat", async () => void order.push("chat"));
		const task = gate.run("task", async () => void order.push("task"));
		assert.deepEqual(gate.waiting, { tasks: 1, chat: 1 });
		assert.equal(gate.chatCanStart, false);
		release();
		await Promise.all([chat, task]);
		assert.deepEqual(order, ["task", "chat"]);
		assert.equal(gate.running, 0);
		assert.ok(gate.chatCanStart);
	});

	it("lets a waiting chat instruction be stopped without taking a slot, and releases only once", async () => {
		const gate = new JobGate(1);
		const release = await gate.acquire("task");
		const stop = new AbortController();
		const waiting = gate.acquire("chat", stop.signal);
		stop.abort();
		await assert.rejects(waiting, /stopped while waiting/);
		release();
		release();
		assert.equal(gate.running, 0);
	});
});

describe("the job journal and the state summary", () => {
	it("keeps the latest jobs, replaces a record of the same job and describes outcomes without secrets", () => {
		const dir = mkdtempSync(join(tmpdir(), "journal-"));
		const journal = new JobJournal(join(dir, "journal.json"), 3);
		for (let i = 0; i < 4; i++) journal.record({ taskId: `t${i}`, capability: "do.it", source: "task", state: "completed", at: `2026-10-05T10:0${i}:00Z`, ms: 1 });
		journal.record({ taskId: "t3", capability: "do.it", source: "task", state: "failed", at: "2026-10-05T10:09:00Z", ms: 2, outcome: "job_error", summary: `boom ghp_${"c".repeat(36)}` });
		const recent = journal.recent();
		assert.deepEqual(recent.map((job) => job.taskId), ["t3", "t2", "t1"]);
		assert.equal(recent[0]!.state, "failed");
		assert.ok(!journal.lines().join("\n").includes("ghp_"));
		assert.match(journal.lines()[0]!, /task do.it t3: failed \(job_error\)/);
		assert.equal(describeOutcome({ type: "detach" } as Outcome), undefined);
		assert.deepEqual(describeOutcome({ type: "completed", result: { verdict: "pass", usage: { totalTokens: 7 } } } as Outcome), { state: "completed", outcome: "pass", summary: undefined, prUrl: undefined, branch: undefined, tokens: 7 });
	});

	it("survives an unreadable journal file", () => {
		const dir = mkdtempSync(join(tmpdir(), "journal-"));
		writeFileSync(join(dir, "j.json"), "{not json");
		assert.deepEqual(new JobJournal(join(dir, "j.json")).recent(), []);
	});

	it("builds the state from the service's own records, with the role's facts, redacted", async () => {
		const dir = mkdtempSync(join(tmpdir(), "state-"));
		const ledger = new DailyLedger(join(dir, "ledger.json"), 1_000_000, undefined, { share: 0.2 }, { share: 0.1 });
		const journal = new JobJournal(join(dir, "journal.json"));
		journal.record({ taskId: "t1", capability: "do.it", source: "chat", state: "completed", at: "2026-10-05T10:00:00Z", ms: 1, outcome: "pr_opened" });
		const state = await buildState({ agentId: "agent/me", role: "tester", capabilities: [{ id: "do.it", version: "1" }], ledger, journal, roleContext: () => `facts ghp_${"d".repeat(36)}`, now: () => new Date(T0), health: () => ({ ready: false, reason: "no model" }) });
		assert.match(state, /agent: agent\/me \(role tester\); capabilities: do.it@1/);
		assert.match(state, /ready: no \(no model\)/);
		assert.match(state, /chat 0\/100000 tokens/);
		assert.match(state, /chat do.it t1: completed \(pr_opened\)/);
		assert.ok(!state.includes("ghp_"));
	});
});

describe("the chat token pool in the ledger", () => {
	it("is a share of the daily limit, comes off what tasks may use and has its own throttle and stop", () => {
		const dir = mkdtempSync(join(tmpdir(), "pool-"));
		const ledger = new DailyLedger(join(dir, "l.json"), 1_000_000, undefined, { share: 0.2 }, { share: 0.1, throttleAt: 0.5 });
		assert.equal(ledger.chatLimit, 100_000);
		assert.equal(ledger.chatState(), "ok");
		ledger.record(60_000, "chat");
		assert.equal(ledger.chatState(), "throttled");
		assert.equal(ledger.chatRemaining(), 40_000);
		ledger.record(40_000, "chat");
		assert.equal(ledger.chatState(), "stopped");
		assert.equal(ledger.chatRemaining(), 0);
		assert.equal(ledger.spent(), 0, "chat spend is not task spend");
		assert.ok(ledger.usage().chat?.stopped);
	});

	it("has no chat pool when the role does not answer with a model", () => {
		const dir = mkdtempSync(join(tmpdir(), "pool-"));
		const ledger = new DailyLedger(join(dir, "l.json"), 1_000_000);
		assert.equal(ledger.chatLimit, 0);
		assert.equal(ledger.chatRemaining(), 0);
		assert.equal(ledger.usage().chat, undefined);
	});
});

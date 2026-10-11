import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { JobGate } from "../src/gate.ts";
import { Approvals } from "../src/threads/approvals.ts";
import { ThreadEngine } from "../src/threads/engine.ts";
import { JobManager, type JobEntry } from "../src/threads/jobs.ts";
import { MessageSender, type InboundMessage } from "../src/threads/message.ts";
import { ResourceRegistry } from "../src/threads/resources.ts";
import { DEFAULT_THREAD_SETTINGS, type ThreadSettings } from "../src/threads/settings.ts";
import { DurableInbox, DurableTable } from "../src/threads/store.ts";
import type { Handler } from "../src/job-types.ts";
import type { AgentOutcome, AgentRequest, RunHooks } from "../src/runtime.ts";

const ME = "agent/qa";
const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: 0 };
const tick = (ms = 5): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface Sent {
	recipients: { kind: string; id: string }[];
	conversationId?: string;
	causationId?: string;
	text: string;
}

function world(options: { jobHandler?: Handler; settings?: Partial<ThreadSettings>; answer?: (request: AgentRequest, text: string) => Promise<string> | string; dir?: string; now?: () => number; intercept?: (message: InboundMessage) => Promise<boolean>; setupKey?: () => string } = {}) {
	const dir = options.dir ?? mkdtempSync(join(tmpdir(), "threads-"));
	const messages = new Map<string, any>();
	const sent: Sent[] = [];
	const requests: AgentRequest[] = [];
	const read = new Set<string>();
	const client = {
		get: async (path: string): Promise<any> => {
			if (path.startsWith("/v1/inbox")) return { messages: [...messages.values()].filter((message) => !read.has(message.messageId)) };
			const id = decodeURIComponent(path.split("/v1/messages/")[1] ?? "");
			if (path.startsWith("/v1/messages/")) {
				const message = messages.get(id);
				if (!message) throw new Error("not found");
				return message;
			}
			return { messages: [] };
		},
		post: async (path: string, body: any): Promise<any> => {
			if (path === "/v1/messages/read") return void body.messageIds.forEach((id: string) => read.add(id));
			sent.push({ recipients: body.recipients, conversationId: body.conversationId, causationId: body.causationId, text: body.content.data });
			return {};
		},
	};
	const settings: ThreadSettings = { ...DEFAULT_THREAD_SETTINGS, busyAfterSeconds: 3600, ...options.settings };
	const inbox = new DurableInbox(join(dir, "inbox.json"));
	const jobs = new JobManager({
		handler: options.jobHandler ?? (async () => ({ type: "completed", result: {} })),
		resources: new ResourceRegistry(),
		gate: new JobGate(2),
		store: new DurableTable<JobEntry>(join(dir, "jobs.json")),
		reporter: { waiting: async () => undefined, started: async () => undefined, finished: async () => undefined },
		takeArtifacts: () => [],
		steer: async () => true,
		approve: async () => ({ approved: true }),
		budget: { maxTokens: 1000, maxMinutes: 1 },
	});
	const notes: string[] = [];
	const originalNote = jobs.note.bind(jobs);
	jobs.note = async (id, text) => (notes.push(`${id}: ${text}`), originalNote(id, text));
	const stop = new AbortController();
	const answerWith = options.answer ?? (() => "ok");
	const engine = new ThreadEngine({
		client,
		agentId: ME,
		runtime: {
			execute: async (request: AgentRequest, _hooks: RunHooks): Promise<AgentOutcome> => {
				requests.push(request);
				return { status: "done", answer: await answerWith(request, request.instruction), usage };
			},
		},
		jobs,
		inbox,
		approvals: new Approvals({ client, log: () => undefined, timeoutMinutes: 1, approvers: settings.approvers }),
		sender: new MessageSender(client),
		settings,
		tools: ["read"],
		instructions: "be useful",
		state: async () => "state: fine",
		workspace: async (key) => `/work/${key}`,
		ledger: { chatRemaining: () => 100_000, chatState: () => "ok", record: () => undefined },
		signal: stop.signal,
		boundary: () => "B",
		...(options.now ? { now: options.now } : {}),
		...(options.intercept ? { intercept: options.intercept } : {}),
		...(options.setupKey ? { setupKey: options.setupKey } : {}),
	});
	const put = (id: string, extra: Partial<{ sender: any; recipients: any[]; conversationId: string; text: string; createdAt: string; type: string; labels: Record<string, string> }> = {}): void => {
		messages.set(id, {
			messageId: id,
			type: extra.type ?? "chat.message",
			sender: extra.sender ?? { kind: "human", id: "user/jimmy" },
			recipients: extra.recipients ?? [{ kind: "agent", id: ME }],
			conversationId: extra.conversationId ?? `conv_${id}`,
			createdAt: extra.createdAt ?? new Date().toISOString(),
			content: { mediaType: "text/plain", data: extra.text ?? `hello from ${id}` },
			...(extra.labels ? { labels: extra.labels } : {}),
		});
	};
	return { engine, put, sent, requests, inbox, jobs, notes, dir, stop, read };
}

describe("threads", () => {
	it("answers a message with a model run of its own and sends the answer to the sender", async () => {
		const w = world({ answer: () => "Hi Jimmy" });
		w.put("m1", { conversationId: "c1" });
		await w.engine.accept("m1");
		await w.engine.idle();
		assert.equal(w.requests.length, 1);
		assert.equal(w.requests[0]!.requestId, "thread:m1");
		assert.match(w.requests[0]!.instruction, /hello from m1/);
		assert.match(w.requests[0]!.instruction, /state: fine/);
		assert.deepEqual(w.sent, [{ recipients: [{ kind: "human", id: "user/jimmy" }], conversationId: "c1", causationId: "m1", text: "Hi Jimmy" }]);
		assert.equal(w.inbox.unfinished().length, 0);
	});

	it("handles a message once, even when it is announced twice", async () => {
		const w = world();
		w.put("m1");
		await w.engine.accept("m1");
		await w.engine.accept("m1");
		await w.engine.idle();
		assert.equal(w.requests.length, 1);
	});

	it("says nothing when the model answers NO_REPLY, and ignores its own messages and other message types", async () => {
		const w = world({ answer: () => "NO_REPLY" });
		w.put("m1");
		w.put("mine", { sender: { kind: "agent", id: ME } });
		w.put("notice", { type: "chat.notice" });
		for (const id of ["m1", "mine", "notice"]) await w.engine.accept(id);
		await w.engine.idle();
		assert.equal(w.requests.length, 1);
		assert.deepEqual(w.sent, []);
	});

	it("sends the answer to everybody in a group conversation, not to itself", async () => {
		const w = world({ answer: () => "Both of you: done." });
		w.put("m1", { conversationId: "group", sender: { kind: "agent", id: "agent/manager" }, recipients: [{ kind: "agent", id: ME }, { kind: "agent", id: "agent/reviewer" }] });
		await w.engine.accept("m1");
		await w.engine.idle();
		assert.deepEqual(w.sent[0]!.recipients.map((party) => party.id), ["agent/manager", "agent/reviewer"]);
		assert.match(w.requests[0]!.instruction, /in a conversation with agent\/manager \(agent\), agent\/reviewer \(agent\)/);
	});

	it("runs different conversations at the same time but one message at a time within a conversation", async () => {
		let running = 0;
		let peak = 0;
		const order: string[] = [];
		const w = world({
			answer: async (request) => {
				running += 1;
				peak = Math.max(peak, running);
				order.push(request.requestId);
				await tick(30);
				running -= 1;
				return "ok";
			},
		});
		w.put("a1", { conversationId: "A" });
		w.put("a2", { conversationId: "A" });
		w.put("b1", { conversationId: "B" });
		for (const id of ["a1", "a2", "b1"]) await w.engine.accept(id);
		await w.engine.idle();
		assert.equal(peak, 2);
		assert.ok(order.indexOf("thread:a1") < order.indexOf("thread:a2"));
	});

	it("keeps no more than the configured number of conversations going and queues the rest", async () => {
		let running = 0;
		let peak = 0;
		const w = world({
			settings: { maxConversations: 2 },
			answer: async () => {
				running += 1;
				peak = Math.max(peak, running);
				await tick(20);
				running -= 1;
				return "ok";
			},
		});
		for (const id of ["a", "b", "c", "d"]) {
			w.put(id);
			await w.engine.accept(id);
		}
		await w.engine.idle();
		assert.equal(peak, 2);
		assert.equal(w.requests.length, 4);
	});

	it("works through a backlog one at a time, people first, and tells the model how long each message waited", async () => {
		const now = Date.parse("2026-10-10T12:00:00Z");
		const before = world({ now: () => now });
		const backlog: [string, any, string][] = [
			["agent-old", { kind: "agent", id: "agent/reviewer" }, "2026-10-10T09:00:00Z"],
			["human-new", { kind: "human", id: "user/jimmy" }, "2026-10-10T11:00:00Z"],
			["human-old", { kind: "human", id: "user/jimmy" }, "2026-10-10T10:00:00Z"],
		];
		for (const [id, sender, createdAt] of backlog) before.inbox.add({ id, sender, sentAt: createdAt, conversationId: `conv_${id}` });

		let running = 0;
		let peak = 0;
		const order: string[] = [];
		const w = world({
			dir: before.dir,
			now: () => now,
			answer: async (request) => {
				running += 1;
				peak = Math.max(peak, running);
				order.push(request.requestId);
				await tick(10);
				running -= 1;
				return "ok";
			},
		});
		for (const [id, sender, createdAt] of backlog) w.put(id, { sender, createdAt });
		assert.equal(w.engine.start(), 3);
		await w.engine.idle();
		assert.deepEqual(order, ["thread:human-old", "thread:human-new", "thread:agent-old"]);
		assert.equal(peak, 1);
		const oldest = w.requests.find((request) => request.requestId === "thread:human-old")!;
		assert.match(oldest.instruction, /sent 2 hours ago/);
	});

	it("does not make a message that arrives now wait for the backlog", async () => {
		const now = Date.parse("2026-10-10T12:00:00Z");
		const order: string[] = [];
		const w = world({
			now: () => now,
			settings: { maxConversations: 2 },
			answer: async (request) => {
				order.push(request.requestId);
				await tick(30);
				return "ok";
			},
		});
		w.put("old1", { createdAt: "2026-10-10T08:00:00Z" });
		w.put("old2", { createdAt: "2026-10-10T08:01:00Z" });
		w.put("live", { createdAt: "2026-10-10T11:59:59Z" });
		await w.engine.accept("old1");
		await w.engine.accept("old2");
		await w.engine.accept("live");
		await w.engine.idle();
		assert.deepEqual(order.slice(0, 2), ["thread:old1", "thread:live"]);
	});

	it("takes up what a restart left unfinished, from the disk", async () => {
		const first = world({ answer: () => new Promise(() => undefined) });
		first.put("m1");
		void first.engine.accept("m1");
		await tick(30);
		assert.equal(first.inbox.unfinished().length, 1);

		const second = world({ dir: first.dir });
		second.put("m1");
		assert.equal(second.engine.start(), 1);
		await second.engine.idle();
		assert.equal(second.requests.length, 1);
		assert.equal(second.requests[0]!.requestId, "thread:m1");
		assert.equal(second.inbox.unfinished().length, 0);
	});

	it("hands a message in a conversation with a running job to the job as a note, and still lets the run answer", async () => {
		let open: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => (open = resolve));
		const w = world({ jobHandler: async () => (await gate, { type: "completed", result: {} }) });
		const entry = w.jobs.start({ capability: { id: "x", version: "1" }, input: {}, label: "verify SAD-1", requestedBy: { kind: "human", id: "user/jimmy" }, conversationId: "c1", source: "message" });
		await tick();
		w.put("m1", { conversationId: "c1", text: "also check the footer" });
		await w.engine.accept("m1");
		await w.engine.idle();
		open();
		assert.ok(w.notes.some((note) => note.startsWith(entry.id) && note.includes("also check the footer")));
		assert.equal(w.requests.length, 1);
	});

	it("passes the run context to the tools and the scratch directory of the conversation", async () => {
		const w = world();
		w.put("m1", { conversationId: "conv/odd name" });
		await w.engine.accept("m1");
		await w.engine.idle();
		const request = w.requests[0]!;
		assert.deepEqual(request.context, { conversationId: "conv/odd name", messageId: "m1", sender: { kind: "human", id: "user/jimmy" }, audience: [{ kind: "human", id: "user/jimmy" }] });
		assert.equal(request.workspace, "/work/conv_odd_name");
		assert.deepEqual(request.tools, ["read"]);
	});

	it("marks a message read once it is safely in the inbox", async () => {
		const w = world();
		w.put("m1");
		await w.engine.accept("m1");
		assert.ok(w.read.has("m1"));
		await w.engine.idle();
	});

	it("takes in what the domain holds unread that no wake announced, once", async () => {
		const first = world();
		first.engine.start();
		await first.engine.sweep();
		const w = world({ dir: first.dir });
		w.put("missed", { conversationId: "c_missed" });
		assert.equal(await w.engine.sweep(), 1);
		await w.engine.idle();
		assert.equal(w.requests.length, 1);
		assert.equal(await w.engine.sweep(), 0, "it is read now, and known");
	});

	it("treats what the domain holds for an agent that never had an inbox as history, not as a backlog", async () => {
		const w = world();
		assert.equal(w.inbox.fresh, true);
		w.put("old1");
		w.put("old2");
		assert.equal(await w.engine.sweep(), 0);
		await w.engine.idle();
		assert.equal(w.requests.length, 0);
		assert.ok(w.read.has("old1") && w.read.has("old2"));
		const restarted = new DurableInbox(join(w.dir, "inbox.json"));
		assert.equal(restarted.fresh, false, "the next start is a real one: whatever came while it was down is a backlog");
	});
});

describe("setup notices and the conversation key", () => {
	const setupLabels = { "setup.kind": "override", "setup.revision": "2", "setup.sha256": "x" };

	it("hands a setup notice to the intercept and never makes a conversation of it", async () => {
		const seen: string[] = [];
		const w = world({ intercept: async (message) => (message.labels?.["setup.kind"] !== undefined ? (seen.push(`${message.sender.kind}:${message.sender.id}`), true) : false) });
		w.put("setup", { type: "chat.notice", sender: { kind: "service", id: "operations" }, labels: setupLabels });
		await w.engine.accept("setup");
		await w.engine.idle();
		assert.deepEqual(seen, ["service:operations"]);
		assert.equal(w.requests.length, 0);
		assert.deepEqual(w.sent, []);
		assert.ok(w.read.has("setup"), "it is marked read");
		assert.equal(w.inbox.has("setup"), false, "it never enters the inbox of conversations");
	});

	it("does not make a conversation of a setup notice even when nothing intercepts it, and still ignores other notices", async () => {
		const w = world();
		w.put("setup", { type: "chat.notice", sender: { kind: "service", id: "operations" }, labels: setupLabels });
		w.put("plain", { type: "chat.notice" });
		await w.engine.accept("setup");
		await w.engine.accept("plain");
		await w.engine.idle();
		assert.equal(w.requests.length, 0);
		assert.ok(w.read.has("setup") && w.read.has("plain"));
	});

	it("never offers the plain notices of other agents to the setup intercept", async () => {
		let asked = 0;
		const w = world({ intercept: async () => (asked += 1, false) });
		w.put("plain", { type: "chat.notice" });
		await w.engine.accept("plain");
		assert.equal(asked, 0);
	});

	it("keeps the conversation key as it was when no setup shapes the conversation, and adds the suffix when one does", async () => {
		let suffix = "";
		const w = world({ setupKey: () => suffix });
		w.put("m1");
		await w.engine.accept("m1");
		await w.engine.idle();
		suffix = "#setup-abc123";
		w.put("m2");
		await w.engine.accept("m2");
		await w.engine.idle();
		assert.deepEqual(w.requests.map((request) => [request.requestId, request.agentKey]), [["thread:m1", "thread:m1"], ["thread:m2", "thread:m2#setup-abc123"]]);
	});

	it("takes a run up again after a restart under the key its first run used, whatever the setup is by then", async () => {
		const dir = mkdtempSync(join(tmpdir(), "threads-"));
		const interrupted = new DurableInbox(join(dir, "inbox.json"));
		interrupted.add({ id: "m1", conversationId: "conv_m1", sender: { kind: "human", id: "user/jimmy" } });
		interrupted.start("m1", "#setup-one");
		const w = world({ dir, setupKey: () => "#setup-two" });
		w.put("m1");
		w.engine.start();
		await w.engine.idle();
		assert.equal(w.requests[0]!.agentKey, "thread:m1#setup-one");
	});
});

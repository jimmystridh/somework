import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { JobGate } from "../src/gate.ts";
import type { Handler } from "../src/job-types.ts";
import type { AgentOutcome, AgentRequest } from "../src/runtime.ts";
import { isPrivateUserMessage, parseUpdate, resolveTelegram, RoutedSender, TelegramChannel, telegramApi, telegramApprovals, TelegramSender, TelegramStore, telegramSettingsFrom, textChunks, type TelegramApi } from "../src/telegram/index.ts";
import { Approvals } from "../src/threads/approvals.ts";
import { ThreadEngine } from "../src/threads/engine.ts";
import { JobManager, type JobEntry } from "../src/threads/jobs.ts";
import { MessageSender, type OutgoingMessage, type Sender } from "../src/threads/message.ts";
import { createJobReporter } from "../src/threads/reporter.ts";
import { ResourceRegistry } from "../src/threads/resources.ts";
import { DEFAULT_THREAD_SETTINGS } from "../src/threads/settings.ts";
import { DurableInbox, DurableTable } from "../src/threads/store.ts";

const ME = "agent/qa";
const OWNER = 4242;
const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: 0 };
const tick = (ms = 5): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const update = (id: number, text: string | undefined, extra: Record<string, unknown> = {}, from = OWNER) => ({
	update_id: id,
	message: { message_id: id, date: Math.floor(Date.now() / 1000), chat: { id: from, type: "private" }, from: { id: from, is_bot: false }, ...(text === undefined ? {} : { text }), ...extra },
});

describe("telegram updates", () => {
	const allowed = new Set([OWNER]);

	it("serves a private text message of an allowed person", () => {
		const parsed = parseUpdate(update(7, "  hello  "), allowed);
		assert.deepEqual(parsed && parsed.kind === "text" ? [parsed.updateId, parsed.userId, parsed.chatId, parsed.text] : parsed, [7, OWNER, OWNER, "hello"]);
	});

	it("ignores everyone else without an answer: strangers, bots, groups and updates that are not messages", () => {
		assert.deepEqual(parseUpdate(update(1, "hi", {}, 99), allowed), { kind: "ignored", updateId: 1, reason: "not_allowed" });
		assert.deepEqual(parseUpdate({ update_id: 2, message: { chat: { id: OWNER, type: "private" }, from: { id: OWNER, is_bot: true }, text: "x" } }, allowed), { kind: "ignored", updateId: 2, reason: "bot" });
		assert.deepEqual(parseUpdate({ update_id: 3, message: { chat: { id: -100, type: "group" }, from: { id: OWNER, is_bot: false }, text: "x" } }, allowed), { kind: "ignored", updateId: 3, reason: "not_private" });
		assert.deepEqual(parseUpdate({ update_id: 4, edited_message: {} }, allowed), { kind: "ignored", updateId: 4, reason: "not_a_message" });
		assert.equal(parseUpdate({ message: { text: "no id" } }, allowed), undefined);
		assert.equal(isPrivateUserMessage({ chat: { type: "private", id: 5 }, from: { id: 6, is_bot: false } }), false);
	});

	it("says that it reads text only to an allowed person who sends something else, and cuts a long text", () => {
		assert.deepEqual(parseUpdate(update(5, undefined, { photo: [{}] }), allowed), { kind: "unsupported", updateId: 5, chatId: OWNER });
		const long = parseUpdate(update(6, "x".repeat(5000)), allowed);
		assert.equal(long?.kind === "text" && long.text.length, 4000);
	});

	it("cuts replies into chunks that Telegram accepts, without splitting a character", () => {
		assert.deepEqual(textChunks("abcdef", 4), ["abcd", "ef"]);
		assert.equal(textChunks("😀".repeat(3), 4).join(""), "😀".repeat(3));
		assert.deepEqual(textChunks(""), []);
	});
});

describe("telegram settings", () => {
	const env = (extra: Record<string, string>) => telegramSettingsFrom(extra);

	it("is off without a token, and says nothing about it", () => {
		assert.deepEqual(resolveTelegram(env({})), { enabled: false });
	});

	it("refuses to start with a token and no usable list of people, and says why", () => {
		assert.match((resolveTelegram(env({ TELEGRAM_BOT_TOKEN: "t" })) as any).reason, /TELEGRAM_ALLOWED_USER_IDS is required/);
		assert.match((resolveTelegram(env({ TELEGRAM_BOT_TOKEN: "t", TELEGRAM_ALLOWED_USER_IDS: "12,@jimmy" })) as any).reason, /numeric/);
		assert.match((resolveTelegram(env({ TELEGRAM_BOT_TOKEN_FILE: "/nope" }), () => { throw new Error("ENOENT"); }) as any).reason, /could not be read/);
	});

	it("starts with a token from a file and a list of ids", () => {
		const dir = mkdtempSync(join(tmpdir(), "tg-settings-"));
		writeFileSync(join(dir, "token"), "123:abc\n");
		const started = resolveTelegram(env({ TELEGRAM_BOT_TOKEN_FILE: join(dir, "token"), TELEGRAM_ALLOWED_USER_IDS: "12, 34" }));
		assert.ok(started.enabled);
		if (started.enabled) assert.deepEqual([started.token, [...started.allowed]], ["123:abc", [12, 34]]);
		assert.throws(() => env({ TELEGRAM_MESSAGES_PER_HOUR: "0" }), /positive integer/);
	});
});

describe("telegram api", () => {
	it("keeps the token out of what it sends and out of its errors", async () => {
		const bodies: string[] = [];
		const ok = telegramApi("SECRET:token", (async (_url: string, init: any) => (bodies.push(init.body), { json: async () => ({ ok: true, result: 1 }) })) as any);
		await ok("sendMessage", { chat_id: 1, text: "the token is SECRET:token" });
		assert.doesNotMatch(bodies[0]!, /SECRET:token/);
		const broken = telegramApi("SECRET:token", (async () => { throw new Error("connect ECONNREFUSED https://api.telegram.org/botSECRET:token/x"); }) as any);
		await assert.rejects(broken("getMe"), (error: Error) => error.message === "Telegram request failed");
		const refused = telegramApi("t", (async () => ({ json: async () => ({ ok: false, error_code: 409 }) })) as any);
		await assert.rejects(refused("getUpdates"), /Telegram API error 409/);
	});
});

describe("telegram store", () => {
	it("keeps messages and the read position across a restart, and gives the history before a message", () => {
		const dir = mkdtempSync(join(tmpdir(), "tg-store-"));
		const store = new TelegramStore(dir, ME);
		assert.equal(store.offset(), undefined);
		const human = { kind: "human", id: "telegram/4242" };
		assert.ok(store.record({ id: "tg:1", conversationId: "tg:4242", sender: human, text: "first", at: "2026-10-10T10:00:00.000Z" }));
		assert.ok(store.record({ id: "tg:out:1", conversationId: "tg:4242", sender: { kind: "agent", id: ME }, text: "answer", at: "2026-10-10T10:00:05.000Z" }));
		assert.ok(store.record({ id: "tg:2", conversationId: "tg:4242", sender: human, text: "second", at: "2026-10-10T10:01:00.000Z" }));
		assert.equal(store.record({ id: "tg:2", conversationId: "tg:4242", sender: human, text: "second", at: "2026-10-10T10:01:00.000Z" }), false, "an update read twice adds nothing");
		store.saveOffset(3);

		const reopened = new TelegramStore(dir, ME);
		assert.equal(reopened.offset(), 3);
		assert.deepEqual(reopened.history("tg:4242", "tg:2", 10, 100).map((line) => [line.sender, line.text]), [["telegram/4242", "first"], [ME, "answer"]]);
		assert.deepEqual(reopened.message("tg:2"), { messageId: "tg:2", type: "chat.message", sender: human, recipients: [{ kind: "agent", id: ME }], conversationId: "tg:4242", createdAt: "2026-10-10T10:01:00.000Z", text: "second" });
		assert.equal(reopened.message("tg:out:1"), undefined, "the agent's own lines are not messages to answer");
		assert.ok(reopened.owns("tg:4242") && !reopened.owns("conv_1") && !reopened.owns(undefined));
		assert.ok(reopened.record({ id: "tg:3", conversationId: "tg:4242", sender: human, text: "third", at: "2026-10-10T10:02:00.000Z" }));
		assert.equal(reopened.history("tg:4242", "tg:3", 1, 100)[0]!.text, "second");
	});
});

/** An agent with its channel, a fake Telegram and a fake domain: nothing here touches a network. */
function world(options: { answer?: (request: AgentRequest) => Promise<string> | string; jobHandler?: Handler; dir?: string; allowed?: number[]; messagesPerHour?: number; now?: () => number } = {}) {
	const dir = options.dir ?? mkdtempSync(join(tmpdir(), "tg-world-"));
	const calls: { method: string; payload: any }[] = [];
	const said = (): string[] => calls.filter((call) => call.method === "sendMessage").map((call) => call.payload.text);
	const queue: any[][] = [];
	const api: TelegramApi = async (method, payload) => {
		calls.push({ method, payload });
		return method === "getUpdates" ? (queue.shift() ?? []) : { message_id: calls.length };
	};
	const domainPosts: any[] = [];
	const client = {
		get: async (): Promise<any> => ({ messages: [] }),
		post: async (path: string, body: any): Promise<any> => void domainPosts.push({ path, body }),
	};
	const store = new TelegramStore(join(dir, "telegram"), ME);
	const telegramSender = new TelegramSender({ api, store, agentId: ME });
	const sender: Sender = new RoutedSender(new MessageSender(client), telegramSender, store);
	const approvals = new Approvals({ client, log: () => undefined, timeoutMinutes: 1, approvers: DEFAULT_THREAD_SETTINGS.approvers, channel: telegramApprovals(store, telegramSender) });
	const requests: AgentRequest[] = [];
	const events: string[] = [];
	const reporter = createJobReporter({ sender, agentId: ME, publish: async (state, payload) => void events.push(`${state}:${payload.conversationId ?? "-"}`) });
	const jobs = new JobManager({
		handler: options.jobHandler ?? (async () => ({ type: "completed", result: { summary: "all green" } })),
		resources: new ResourceRegistry(),
		gate: new JobGate(2),
		store: new DurableTable<JobEntry>(join(dir, "jobs.json")),
		reporter,
		takeArtifacts: () => [{ artifactId: "art-1", filename: "run.mp4" }],
		steer: async () => true,
		approve: async () => ({ approved: true }),
		budget: { maxTokens: 1000, maxMinutes: 1 },
	});
	const stop = new AbortController();
	const engine = new ThreadEngine({
		client,
		agentId: ME,
		runtime: {
			execute: async (request: AgentRequest): Promise<AgentOutcome> => {
				requests.push(request);
				return { status: "done", answer: await (options.answer ?? (() => "ok"))(request), usage };
			},
		},
		jobs,
		inbox: new DurableInbox(join(dir, "inbox.json")),
		approvals,
		sender,
		settings: { ...DEFAULT_THREAD_SETTINGS, busyAfterSeconds: 3600 },
		tools: ["read"],
		instructions: "be useful",
		state: async () => "state: fine",
		workspace: async (key) => `/work/${key}`,
		ledger: { chatRemaining: () => 100_000, chatState: () => "ok", record: () => undefined },
		local: store,
		signal: stop.signal,
		boundary: () => "B",
	});
	const channel = new TelegramChannel({
		api,
		store,
		allowed: new Set(options.allowed ?? [OWNER]),
		agentId: ME,
		accept: (message) => engine.acceptLocal(message),
		about: () => `I am ${ME}.`,
		status: async () => "ready: yes",
		jobs,
		approvals,
		messagesPerHour: options.messagesPerHour ?? 30,
		pollSeconds: 0,
		...(options.now ? { now: options.now } : {}),
		sleep: async () => undefined,
	});
	return { api, calls, said, queue, domainPosts, store, engine, channel, jobs, requests, events, dir, stop, approvals, sender };
}

describe("telegram channel and the thread engine", () => {
	it("answers a message with a model run of its own and sends the answer to the chat, not to the domain", async () => {
		const w = world({ answer: () => "Hi Jimmy" });
		await w.channel.handleUpdate(update(10, "hello"));
		await w.engine.idle();
		assert.equal(w.requests.length, 1);
		assert.equal(w.requests[0]!.requestId, "thread:tg:10");
		assert.match(w.requests[0]!.instruction, /telegram\/4242 \(human\)/);
		assert.match(w.requests[0]!.instruction, /hello/);
		assert.deepEqual(w.said(), ["Hi Jimmy"]);
		assert.equal(w.calls.find((call) => call.method === "sendMessage")!.payload.chat_id, OWNER);
		assert.deepEqual(w.domainPosts, []);
	});

	it("gives the model the earlier lines of the chat as history, and sends nothing for NO_REPLY", async () => {
		let answer = "first answer";
		const w = world({ answer: () => answer });
		await w.channel.handleUpdate(update(10, "one"));
		await w.engine.idle();
		answer = "NO_REPLY";
		await w.channel.handleUpdate(update(11, "thanks"));
		await w.engine.idle();
		assert.match(w.requests[1]!.instruction, /telegram\/4242 \(human\): one/);
		assert.match(w.requests[1]!.instruction, /agent\/qa \(agent\): first answer/);
		assert.deepEqual(w.said(), ["first answer"]);
	});

	it("handles an update once, even when Telegram sends it twice", async () => {
		const w = world();
		await w.channel.handleUpdate(update(10, "hello"));
		await w.channel.handleUpdate(update(10, "hello"));
		await w.engine.idle();
		assert.equal(w.requests.length, 1);
	});

	it("takes up a message that was not answered when the agent stopped, from its own store", async () => {
		const first = world({ answer: () => new Promise<string>(() => undefined) });
		await first.channel.handleUpdate(update(10, "do the thing"));
		await tick();
		const second = world({ dir: first.dir, answer: () => "done it" });
		assert.equal(second.engine.start(), 1);
		await second.engine.idle();
		assert.match(second.requests[0]!.instruction, /do the thing/);
		assert.deepEqual(second.said(), ["done it"]);
	});

	it("serves nobody else: strangers get no answer and no model run", async () => {
		const w = world();
		await w.channel.handleUpdate(update(10, "hello", {}, 99));
		await w.channel.handleUpdate({ update_id: 11, message: { chat: { id: -5, type: "group" }, from: { id: OWNER, is_bot: false }, text: "hi" } });
		await w.engine.idle();
		assert.equal(w.requests.length, 0);
		assert.deepEqual(w.calls, []);
	});

	it("limits what one person can send in an hour, and says so once", async () => {
		let now = Date.parse("2026-10-10T10:00:00Z");
		const w = world({ messagesPerHour: 2, now: () => now });
		for (const id of [1, 2, 3, 4]) await w.channel.handleUpdate({ ...update(id, `m${id}`), message: { ...update(id, `m${id}`).message, date: Math.floor(now / 1000) } });
		await w.engine.idle();
		assert.equal(w.requests.length, 2);
		assert.equal(w.said().filter((text) => /more than 2 messages an hour/.test(text)).length, 1);
		now += 3_700_000;
		await w.channel.handleUpdate({ ...update(5, "again"), message: { ...update(5, "again").message, date: Math.floor(now / 1000) } });
		await w.engine.idle();
		assert.equal(w.requests.length, 3);
	});

	it("reports the end of a job started in the chat back into the chat, and still publishes its events to the domain", async () => {
		const w = world();
		const entry = w.jobs.start({ capability: { id: "qa.verify", version: "1" }, input: {}, label: "verify SAD-1", requestedBy: { kind: "human", id: "telegram/4242" }, conversationId: "tg:4242", audience: [{ kind: "human", id: "telegram/4242" }], source: "message" });
		await w.jobs.idle();
		const told = w.said().find((text) => text.includes(entry.id));
		assert.match(told ?? "", /all green/);
		assert.match(told ?? "", /1 attachment\(s\) are kept in the domain.*run\.mp4 \(art-1\)/);
		assert.deepEqual(w.domainPosts, []);
		assert.deepEqual(w.events, ["started:tg:4242", "finished:tg:4242"]);
	});

	it("sends what concerns other conversations through the domain as before", async () => {
		const w = world();
		const out: OutgoingMessage = { recipients: [{ kind: "agent", id: "agent/reviewer" }], conversationId: "conv_9", text: "hello", key: "k" };
		await w.sender.send(out);
		assert.equal(w.domainPosts.length, 1);
		assert.equal(w.domainPosts[0].path, "/v1/messages");
		assert.deepEqual(w.said(), []);
	});

	it("answers the commands without a model run", async () => {
		const w = world();
		await w.channel.handleUpdate(update(1, "/help"));
		await w.channel.handleUpdate(update(2, "/status@my_bot"));
		await w.channel.handleUpdate(update(3, "/jobs"));
		await w.channel.handleUpdate(update(4, "/stop"));
		await w.channel.handleUpdate(update(5, "/stop job-none"));
		await w.channel.handleUpdate(update(6, "/frobnicate"));
		assert.equal(w.requests.length, 0);
		const said = w.said();
		assert.match(said[0]!, /I am agent\/qa\.[\s\S]*Commands:/);
		assert.equal(said[1], "ready: yes");
		assert.match(said[2]!, /Active \(0\):/);
		assert.match(said[3]!, /Say which job/);
		assert.equal(said[4], "I have no such job.");
		assert.match(said[5]!, /I do not know \/frobnicate/);
	});

	it("stops a job from the chat as a signal", async () => {
		let open: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => (open = resolve));
		const w = world({ jobHandler: async () => (await gate, { type: "completed", result: {} }) });
		const entry = w.jobs.start({ capability: { id: "qa.verify", version: "1" }, input: {}, label: "long", requestedBy: { kind: "human", id: "telegram/4242" }, conversationId: "tg:4242", source: "message" });
		await tick();
		await w.channel.handleUpdate(update(1, `/stop ${entry.id}`));
		assert.match(w.said()[0]!, /The job was told/);
		open();
		await w.jobs.idle();
	});

	it("asks for an approval on the chat and takes the answer from /approve and /deny, from the person asked only", async () => {
		const w = world();
		const asked = w.approvals.ask({ approver: { kind: "human", id: "telegram/4242" }, conversationId: "tg:4242", agent: ME, tool: "bash", summary: "run the migration", signal: new AbortController().signal });
		await tick();
		const question = w.said()[0]!;
		const id = /\/approve ([0-9a-f]+)/.exec(question)![1]!;
		assert.match(question, /Approval needed \(agent\/qa\): bash: run the migration/);
		assert.deepEqual(w.domainPosts, []);
		assert.equal(w.approvals.decide(id, { kind: "human", id: "telegram/777" }, "tg:4242", true), "rejected");
		await w.channel.handleUpdate(update(1, `/approve ${id}`));
		assert.deepEqual(await asked, { approved: true });
		await w.channel.handleUpdate(update(2, `/deny ${id}`));
		assert.match(w.said().at(-1)!, /no open question/);
	});

	it("takes a denial from the chat", async () => {
		const w = world();
		const asked = w.approvals.ask({ approver: { kind: "human", id: "telegram/4242" }, conversationId: "tg:4242", agent: ME, tool: "bash", summary: "x", signal: new AbortController().signal });
		await tick();
		const id = /\/deny ([0-9a-f]+)/.exec(w.said()[0]!)![1]!;
		await w.channel.handleUpdate(update(1, `/deny ${id}`));
		assert.deepEqual(await asked, { approved: false, reason: "denied by the approver" });
	});

	it("asks an approver outside the chat through the domain, in a conversation of its own", async () => {
		const w = world();
		const asked = w.approvals.ask({ approver: { kind: "agent", id: "agent/manager" }, conversationId: "tg:4242", agent: ME, tool: "bash", summary: "x", signal: AbortSignal.timeout(50) });
		await tick();
		assert.equal(w.domainPosts.length, 1);
		assert.equal(w.domainPosts[0].body.conversationId, undefined);
		assert.deepEqual(w.said(), []);
		assert.equal((await asked).approved, false);
	});
});

describe("telegram polling", () => {
	it("reads updates in batches, keeps the position, and starts from it after a restart", async () => {
		const w = world({ answer: () => "ok" });
		const stop = new AbortController();
		const seen: unknown[] = [];
		const original = w.api;
		w.queue.push([update(20, "one"), update(21, "two")]);
		const channel = new TelegramChannel({
			api: async (method, payload, signal) => {
				if (method === "getUpdates") {
					seen.push(payload);
					if (seen.length > 1) stop.abort();
				}
				return original(method, payload, signal);
			},
			store: w.store,
			allowed: new Set([OWNER]),
			agentId: ME,
			accept: (message) => w.engine.acceptLocal(message),
			about: () => "",
			status: async () => "",
			jobs: w.jobs,
			approvals: w.approvals,
			pollSeconds: 0,
			sleep: async () => undefined,
		});
		await channel.run(stop.signal);
		await w.engine.idle();
		assert.equal(w.requests.length, 2);
		assert.equal((seen[0] as any).offset, undefined);
		assert.equal((seen[1] as any).offset, 22);
		assert.equal(new TelegramStore(join(w.dir, "telegram"), ME).offset(), 22);
	});

	it("waits and tries again when Telegram cannot be reached, without losing its place", async () => {
		const w = world();
		const stop = new AbortController();
		let polls = 0;
		const sleeps: number[] = [];
		const channel = new TelegramChannel({
			api: async (method) => {
				if (method !== "getUpdates") return {};
				polls += 1;
				if (polls < 3) throw new Error("Telegram request failed");
				stop.abort();
				return [];
			},
			store: w.store,
			allowed: new Set([OWNER]),
			agentId: ME,
			accept: async () => undefined,
			about: () => "",
			status: async () => "",
			jobs: w.jobs,
			approvals: w.approvals,
			sleep: async (ms) => void sleeps.push(ms),
		});
		await channel.run(stop.signal);
		assert.deepEqual(sleeps, [1000, 2000]);
	});

	it("does not move past an update that the engine could not take, so that it is read again", async () => {
		const w = world();
		const stop = new AbortController();
		let failing = true;
		const channel = new TelegramChannel({
			api: async (method) => {
				if (method !== "getUpdates") return {};
				if (!failing) return void stop.abort() ?? [];
				failing = false;
				return [update(30, "hello")];
			},
			store: w.store,
			allowed: new Set([OWNER]),
			agentId: ME,
			accept: async () => {
				throw new Error("disk full");
			},
			about: () => "",
			status: async () => "",
			jobs: w.jobs,
			approvals: w.approvals,
			sleep: async () => undefined,
		});
		await channel.run(stop.signal);
		assert.equal(w.store.offset(), undefined);
	});
});

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { JobGate } from "../src/gate.ts";
import type { Handler } from "../src/job-types.ts";
import type { AgentOutcome, AgentRequest } from "../src/runtime.ts";
import { cleanSlackText, parseSlackEvent, resolveSlack, SlackChannel, slackApi, slackApprovals, SlackSender, slackSettingsFrom, slackSocketUrl, SlackStore, slackTargetOf, type SlackApi, type SlackSocket } from "../src/slack/index.ts";
import { TelegramChannel, telegramApprovals, TelegramSender, TelegramStore, type TelegramApi } from "../src/telegram/index.ts";
import { Approvals } from "../src/threads/approvals.ts";
import { combinedLocal, RoutedSender } from "../src/threads/channels.ts";
import { ThreadEngine } from "../src/threads/engine.ts";
import { JobManager, type JobEntry } from "../src/threads/jobs.ts";
import { MessageSender, type OutgoingMessage, type Sender } from "../src/threads/message.ts";
import { createJobReporter } from "../src/threads/reporter.ts";
import { ResourceRegistry } from "../src/threads/resources.ts";
import { DEFAULT_THREAD_SETTINGS } from "../src/threads/settings.ts";
import { DurableInbox, DurableTable } from "../src/threads/store.ts";

const ME = "agent/qa";
const BOT = "U0BOTBOT1";
const OWNER = "U0OWNER01";
const STRANGER = "U0STRANGER";
const DM = "D0123ABCD";
const CHANNEL = "C0123ABCD";
const BOT_TOKEN = "xoxb-111-222-botsecret";
const APP_TOKEN = "xapp-1-A0123-333-appsecret";
const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: 0 };
const tick = (ms = 5): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const base = Math.floor(Date.now() / 1000);
const ts = (n: number): string => `${base}.${String(n).padStart(6, "0")}`;

const payload = (n: number, event: Record<string, unknown>, eventId = `Ev${n}`) => ({ type: "event_callback", event_id: eventId, authorizations: [{ user_id: BOT, is_bot: true }], event: { ts: ts(n), ...event } });
const dm = (n: number, text: string | undefined, extra: Record<string, unknown> = {}, user = OWNER, eventId?: string) =>
	payload(n, { type: "message", channel_type: "im", channel: DM, user, ...(text === undefined ? {} : { text }), ...extra }, eventId);
const mention = (n: number, text: string, extra: Record<string, unknown> = {}, user = OWNER, channel = CHANNEL) => payload(n, { type: "app_mention", channel, user, text, ...extra });
const envelope = (id: string, body: unknown, type = "events_api") => ({ type, envelope_id: id, accepts_response_payload: false, payload: body });

const allowed = { users: new Set([OWNER]), channels: new Set([CHANNEL]) };

describe("slack events", () => {
	it("serves a DM of an allowed person", () => {
		const parsed = parseSlackEvent(dm(7, "  hello  "), allowed);
		assert.ok(parsed?.kind === "text");
		assert.deepEqual([parsed.eventKey, parsed.userId, parsed.target, parsed.conversationId, parsed.text, parsed.keys], ["Ev7", OWNER, { channel: DM }, `slack:${DM}`, "hello", ["Ev7", `${DM}:${ts(7)}`]]);
		assert.equal(parsed.sentAt, new Date(base * 1000).toISOString());
	});

	it("serves a mention in an allowed channel in a thread of that message, or of the thread it is in", () => {
		const first = parseSlackEvent(mention(8, `<@${BOT}> what is up?`), allowed);
		assert.ok(first?.kind === "text");
		assert.deepEqual([first.text, first.target, first.conversationId], ["what is up?", { channel: CHANNEL, threadTs: ts(8) }, `slack:${CHANNEL}:${ts(8)}`]);
		const inThread = parseSlackEvent(mention(9, `<@${BOT}> and now?`, { thread_ts: ts(1) }), allowed);
		assert.ok(inThread?.kind === "text");
		assert.deepEqual([inThread.target, inThread.conversationId], [{ channel: CHANNEL, threadTs: ts(1) }, `slack:${CHANNEL}:${ts(1)}`]);
	});

	it("takes the mention of the bot off the front and undoes Slack's escapes, and nothing else", () => {
		assert.equal(cleanSlackText(`<@${BOT}> hello`, BOT), "hello");
		assert.equal(cleanSlackText(`<@${BOT}|qa>: hello`, BOT), "hello");
		assert.equal(cleanSlackText(`ask <@${BOT}> about it`, BOT), `ask <@${BOT}> about it`);
		assert.equal(cleanSlackText("<@U0OTHER001> hello", BOT), "<@U0OTHER001> hello");
		assert.equal(cleanSlackText("a &lt; b &amp;&amp; b &gt; c &amp;lt;"), "a < b && b > c &lt;");
		assert.equal(cleanSlackText("<@U0OTHER001> hello"), "hello", "without a known bot id the leading mention is the bot's");
	});

	it("ignores everyone else without an answer: strangers, bots, other channels, edits, deletions, threads broadcast and other events", () => {
		const ignored = (parsed: unknown, reason: string) => assert.deepEqual(parsed, { kind: "ignored", reason });
		ignored(parseSlackEvent(dm(1, "hi", {}, STRANGER), allowed), "not_allowed");
		ignored(parseSlackEvent(mention(2, "hi", {}, STRANGER), allowed), "not_allowed");
		ignored(parseSlackEvent(mention(3, "hi", {}, OWNER, "C0OTHER001"), allowed), "channel_not_allowed");
		ignored(parseSlackEvent(dm(4, "hi", { bot_id: "B0123" }), allowed), "bot");
		ignored(parseSlackEvent(dm(5, "hi", { user: BOT }), allowed), "bot");
		ignored(parseSlackEvent(dm(6, "hi", { subtype: "bot_message" }), allowed), "bot");
		ignored(parseSlackEvent(dm(7, "hi", { subtype: "message_changed" }), allowed), "subtype");
		ignored(parseSlackEvent(dm(8, "hi", { subtype: "message_deleted" }), allowed), "subtype");
		ignored(parseSlackEvent(dm(9, "hi", { subtype: "thread_broadcast" }), allowed), "subtype");
		ignored(parseSlackEvent(dm(10, "hi", { edited: { user: OWNER, ts: ts(11) } }), allowed), "subtype");
		ignored(parseSlackEvent(dm(11, "hi", { channel_type: "channel", channel: CHANNEL }), allowed), "not_private");
		ignored(parseSlackEvent(payload(12, { type: "reaction_added", user: OWNER }), allowed), "not_a_message");
		ignored(parseSlackEvent(dm(13, "hi", { ts: "yesterday" }), allowed), "not_a_message");
		assert.equal(parseSlackEvent(undefined, allowed), undefined);
	});

	it("ignores a mention in a channel when no channel is allowed, but still serves DMs", () => {
		const dmsOnly = { users: new Set([OWNER]), channels: new Set<string>() };
		assert.deepEqual(parseSlackEvent(mention(1, "hi"), dmsOnly), { kind: "ignored", reason: "channel_not_allowed" });
		assert.equal(parseSlackEvent(dm(2, "hi"), dmsOnly)?.kind, "text");
	});

	it("says that it reads text only to an allowed person who sends a file or nothing, and cuts a long text", () => {
		assert.equal(parseSlackEvent(dm(1, "look", { subtype: "file_share", files: [{ id: "F1" }] }), allowed)?.kind, "unsupported");
		assert.equal(parseSlackEvent(dm(2, undefined, { files: [{ id: "F1" }] }), allowed)?.kind, "unsupported");
		assert.deepEqual(parseSlackEvent(mention(3, `<@${BOT}>`), allowed), { kind: "unsupported", keys: ["Ev3", `${CHANNEL}:${ts(3)}`], target: { channel: CHANNEL, threadTs: ts(3) } });
		const long = parseSlackEvent(dm(4, "x".repeat(5000)), allowed);
		assert.equal(long?.kind === "text" && long.text.length, 4000);
	});

	it("reads the channel and thread back out of a conversation id", () => {
		assert.deepEqual(slackTargetOf(`slack:${DM}`), { channel: DM });
		assert.deepEqual(slackTargetOf(`slack:${CHANNEL}:${ts(1)}`), { channel: CHANNEL, threadTs: ts(1) });
		for (const other of ["tg:42", "conv_1", "slack:", "slack:C1:nope", undefined]) assert.equal(slackTargetOf(other), undefined);
	});
});

describe("slack settings", () => {
	const settings = (extra: Record<string, string>) => slackSettingsFrom(extra);
	const reason = (extra: Record<string, string>, read?: (path: string) => string): string | undefined => (resolveSlack(settings(extra), read) as any).reason;
	const tokens = { SLACK_BOT_TOKEN: BOT_TOKEN, SLACK_APP_TOKEN: APP_TOKEN };

	it("is off without tokens, and says nothing about it", () => {
		assert.deepEqual(resolveSlack(settings({})), { enabled: false });
		assert.deepEqual(resolveSlack(settings({ SLACK_ALLOWED_USER_IDS: OWNER })), { enabled: false });
	});

	it("treats empty token files as not configured, which is what mounting /dev/null gives", () => {
		assert.deepEqual(resolveSlack(settings({ SLACK_BOT_TOKEN_FILE: "/dev/null", SLACK_APP_TOKEN_FILE: "/dev/null" })), { enabled: false });
		assert.deepEqual(resolveSlack(settings({ SLACK_BOT_TOKEN_FILE: "/dev/null", SLACK_APP_TOKEN_FILE: "/dev/null", SLACK_ALLOWED_USER_IDS: OWNER })), { enabled: false });
	});

	it("needs both tokens and names the one that is missing or empty", () => {
		assert.match(reason({ SLACK_BOT_TOKEN: BOT_TOKEN })!, /app token is missing or empty.*SLACK_APP_TOKEN/);
		assert.match(reason({ SLACK_APP_TOKEN: APP_TOKEN })!, /bot token is missing or empty.*SLACK_BOT_TOKEN/);
		const files = (token: string) => (path: string) => (path === "/bot" ? token : "");
		assert.match(reason({ SLACK_BOT_TOKEN_FILE: "/bot", SLACK_APP_TOKEN_FILE: "/dev/null" }, files(BOT_TOKEN))!, /app token is missing or empty/);
		assert.match(reason({ SLACK_BOT_TOKEN_FILE: "/dev/null", SLACK_APP_TOKEN_FILE: "/app" }, (path) => (path === "/app" ? APP_TOKEN : ""))!, /bot token is missing or empty/);
		assert.match(reason({ SLACK_BOT_TOKEN_FILE: "/nope", SLACK_APP_TOKEN: APP_TOKEN }, () => { throw new Error("ENOENT"); })!, /SLACK_BOT_TOKEN_FILE could not be read/);
		assert.match(reason({ SLACK_BOT_TOKEN: BOT_TOKEN, SLACK_APP_TOKEN_FILE: "/nope" }, () => { throw new Error("ENOENT"); })!, /SLACK_APP_TOKEN_FILE could not be read/);
	});

	it("checks what kind of token each is, and never repeats one in the reason", () => {
		const wrongBot = reason({ ...tokens, SLACK_BOT_TOKEN: "xoxp-111-222-usersecret", SLACK_ALLOWED_USER_IDS: OWNER })!;
		assert.match(wrongBot, /xoxb-/);
		assert.match(reason({ ...tokens, SLACK_APP_TOKEN: "xoxb-111-222-botsecret", SLACK_ALLOWED_USER_IDS: OWNER })!, /xapp-/);
		assert.match(reason({ ...tokens, SLACK_BOT_TOKEN: "xoxb-has space", SLACK_ALLOWED_USER_IDS: OWNER })!, /xoxb-/);
		for (const text of [wrongBot, reason({ ...tokens, SLACK_APP_TOKEN: "nope-secret", SLACK_ALLOWED_USER_IDS: OWNER })!]) assert.doesNotMatch(text, /secret/);
	});

	it("refuses to start with tokens and no usable list of people, and says why", () => {
		assert.match(reason(tokens)!, /SLACK_ALLOWED_USER_IDS is required/);
		assert.match(reason({ ...tokens, SLACK_ALLOWED_USER_IDS: " , " })!, /SLACK_ALLOWED_USER_IDS is required/);
		assert.match(reason({ ...tokens, SLACK_ALLOWED_USER_IDS: "U0OWNER01,@jimmy" })!, /member ids like U0123ABCD/);
		assert.match(reason({ ...tokens, SLACK_ALLOWED_USER_IDS: "u0owner01" })!, /member ids/);
		assert.match(reason({ ...tokens, SLACK_ALLOWED_USER_IDS: OWNER, SLACK_ALLOWED_CHANNELS: "general" })!, /SLACK_ALLOWED_CHANNELS must be Slack channel ids/);
	});

	it("starts with tokens from files, a list of members and, optionally, channels", () => {
		const dir = mkdtempSync(join(tmpdir(), "slack-settings-"));
		writeFileSync(join(dir, "bot"), `${BOT_TOKEN}\n`);
		writeFileSync(join(dir, "app"), `${APP_TOKEN}\n`);
		const started = resolveSlack(settings({ SLACK_BOT_TOKEN_FILE: join(dir, "bot"), SLACK_APP_TOKEN_FILE: join(dir, "app"), SLACK_ALLOWED_USER_IDS: "U0OWNER01, W0ENTERP01", SLACK_ALLOWED_CHANNELS: "C0123ABCD,G0PRIVATE1" }));
		assert.ok(started.enabled);
		if (started.enabled) assert.deepEqual([started.botToken, started.appToken, [...started.allowedUsers], [...started.allowedChannels]], [BOT_TOKEN, APP_TOKEN, [OWNER, "W0ENTERP01"], [CHANNEL, "G0PRIVATE1"]]);
		const direct = resolveSlack(settings({ ...tokens, SLACK_ALLOWED_USER_IDS: OWNER }));
		assert.ok(direct.enabled && direct.allowedChannels.size === 0, "no channel means DMs only");
	});

	it("limits messages per hour to 30 unless told otherwise", () => {
		assert.equal(settings({}).messagesPerHour, 30);
		assert.equal(settings({ SLACK_MESSAGES_PER_HOUR: "5" }).messagesPerHour, 5);
		assert.throws(() => settings({ SLACK_MESSAGES_PER_HOUR: "0" }), /positive integer/);
		assert.throws(() => settings({ SLACK_MESSAGES_PER_HOUR: "many" }), /positive integer/);
	});
});

const reply = (body: unknown, status = 200, headers: Record<string, string> = {}) => ({ status, headers: { get: (name: string) => headers[name.toLowerCase()] ?? null }, json: async () => body });

describe("slack api", () => {
	it("keeps both tokens out of what it sends and out of its errors", async () => {
		const sent: { url: string; init: any }[] = [];
		const api = slackApi({ botToken: BOT_TOKEN, appToken: APP_TOKEN }, (async (url: string, init: any) => (sent.push({ url, init }), reply({ ok: true }))) as any);
		await api("chat.postMessage", { channel: DM, text: `the tokens are ${BOT_TOKEN} and ${APP_TOKEN}` });
		assert.equal(sent[0]!.url, "https://slack.com/api/chat.postMessage");
		assert.equal(sent[0]!.init.headers.authorization, `Bearer ${BOT_TOKEN}`);
		assert.doesNotMatch(sent[0]!.init.body, /botsecret|appsecret/);
		const broken = slackApi({ botToken: BOT_TOKEN }, (async () => { throw new Error(`connect ECONNREFUSED https://slack.com/api/x ${BOT_TOKEN}`); }) as any);
		await assert.rejects(broken("chat.postMessage", { text: "x" }), (error: Error) => error.message === "Slack request failed");
		const refused = slackApi({ botToken: BOT_TOKEN }, (async () => reply({ ok: false, error: "channel_not_found" })) as any);
		await assert.rejects(refused("chat.postMessage", { text: "x" }), (error: Error) => error.message === "Slack API error channel_not_found");
		const odd = slackApi({ botToken: BOT_TOKEN }, (async () => reply({ ok: false, error: `bad ${BOT_TOKEN}` })) as any);
		await assert.rejects(odd("chat.postMessage", { text: "x" }), (error: Error) => error.message === "Slack API error unknown");
		const html = slackApi({ botToken: BOT_TOKEN }, (async () => ({ status: 502, headers: { get: () => null }, json: async () => { throw new Error("<html>"); } })) as any);
		await assert.rejects(html("chat.postMessage", { text: "x" }), (error: Error) => error.message === "Slack request failed");
	});

	it("waits out a 429 once, as Slack says, and then gives up", async () => {
		const waits: number[] = [];
		const answers = [reply({}, 429, { "retry-after": "3" }), reply({ ok: true, ts: "1.2" })];
		const api = slackApi({ botToken: BOT_TOKEN }, (async () => answers.shift()) as any, async (ms) => void waits.push(ms));
		assert.deepEqual(await api("chat.postMessage", { text: "x" }), { ok: true, ts: "1.2" });
		assert.deepEqual(waits, [3000]);
		const limited = slackApi({ botToken: BOT_TOKEN }, (async () => reply({}, 429, { "retry-after": "999" })) as any, async (ms) => void waits.push(ms));
		await assert.rejects(limited("chat.postMessage", { text: "x" }), (error: Error) => error.message === "Slack API error ratelimited");
		assert.deepEqual(waits, [3000, 60_000], "one wait, and never longer than a minute");
	});

	it("asks for the address of a connection with the app token, and keeps the address out of its errors", async () => {
		const sent: { url: string; init: any }[] = [];
		const open = slackSocketUrl(APP_TOKEN, (async (url: string, init: any) => (sent.push({ url, init }), reply({ ok: true, url: "wss://wss-primary.slack.com/link/?ticket=secret-ticket" }))) as any);
		assert.equal(await open(), "wss://wss-primary.slack.com/link/?ticket=secret-ticket");
		assert.equal(sent[0]!.url, "https://slack.com/api/apps.connections.open");
		assert.equal(sent[0]!.init.headers.authorization, `Bearer ${APP_TOKEN}`);
		await assert.rejects(slackSocketUrl(APP_TOKEN, (async () => reply({ ok: false, error: "invalid_auth" })) as any)(), /Slack API error invalid_auth/);
		await assert.rejects(slackSocketUrl(APP_TOKEN, (async () => reply({ ok: true, url: "https://example.com/secret-ticket" })) as any)(), (error: Error) => !/secret-ticket/.test(error.message));
		await assert.rejects(slackSocketUrl(APP_TOKEN, (async () => { throw new Error(`failed ${APP_TOKEN}`); }) as any)(), (error: Error) => error.message === "Slack request failed");
	});
});

describe("slack store", () => {
	it("keeps messages and the events taken in across a restart, and gives the history before a message", () => {
		const dir = mkdtempSync(join(tmpdir(), "slack-store-"));
		const store = new SlackStore(dir, ME);
		const human = { kind: "human", id: `slack/${OWNER}` };
		const conversationId = `slack:${DM}`;
		assert.ok(store.record({ id: "slack:Ev1", conversationId, sender: human, text: "first", at: "2026-10-10T10:00:00.000Z" }));
		assert.ok(store.record({ id: "slack:out:1", conversationId, sender: { kind: "agent", id: ME }, text: "answer", at: "2026-10-10T10:00:05.000Z" }));
		assert.ok(store.record({ id: "slack:Ev2", conversationId, sender: human, text: "second", at: "2026-10-10T10:01:00.000Z" }));
		assert.ok(store.record({ id: "slack:Ev3", conversationId: `slack:${CHANNEL}:${ts(1)}`, sender: human, text: "elsewhere", at: "2026-10-10T10:01:30.000Z" }));
		assert.equal(store.record({ id: "slack:Ev2", conversationId, sender: human, text: "second", at: "2026-10-10T10:01:00.000Z" }), false, "an event delivered twice adds nothing");
		assert.ok(store.claim(["Ev2", `${DM}:${ts(2)}`]));
		assert.equal(store.claim(["Ev9", `${DM}:${ts(2)}`]), false, "the same message under another event id is the same message");
		assert.ok(store.claim(["Ev9", `${DM}:${ts(9)}`]), "nothing was noted of Ev9 by the refused claim");
		store.release(["Ev9", `${DM}:${ts(9)}`]);

		const reopened = new SlackStore(dir, ME);
		assert.equal(reopened.claim(["Ev2"]), false);
		assert.ok(reopened.claim(["Ev9"]));
		assert.deepEqual(reopened.history(conversationId, "slack:Ev2", 10, 100).map((line) => [line.sender, line.text]), [[`slack/${OWNER}`, "first"], [ME, "answer"]]);
		assert.deepEqual(reopened.history(conversationId, "slack:Ev2", 10, 100).map((line) => line.messageId), ["slack:Ev1", "slack:out:1"]);
		assert.deepEqual(reopened.message("slack:Ev2"), { messageId: "slack:Ev2", type: "chat.message", sender: human, recipients: [{ kind: "agent", id: ME }], conversationId, createdAt: "2026-10-10T10:01:00.000Z", text: "second" });
		assert.equal(reopened.message("slack:out:1"), undefined, "the agent's own lines are not messages to answer");
		assert.ok(reopened.owns(conversationId) && reopened.owns(`slack:${CHANNEL}:${ts(1)}`) && !reopened.owns("tg:1") && !reopened.owns("conv_1") && !reopened.owns(undefined));
	});
});

/** A WebSocket that the test drives: Slack's side is `receive`, `drop` and `fail`. */
class FakeSocket extends EventTarget implements SlackSocket {
	readonly sent: any[] = [];
	closed = false;
	readonly url: string;
	constructor(url: string) {
		super();
		this.url = url;
	}
	send(data: string): void {
		if (this.closed) throw new Error("closed");
		this.sent.push(JSON.parse(data));
	}
	close(): void {
		this.closed = true;
	}
	receive(body: unknown): void {
		this.dispatchEvent(new MessageEvent("message", { data: typeof body === "string" ? body : JSON.stringify(body) }));
	}
	drop(): void {
		this.dispatchEvent(new Event("close"));
	}
	fail(): void {
		this.dispatchEvent(new Event("error"));
	}
	get acks(): string[] {
		return this.sent.filter((body) => body.envelope_id).map((body) => body.envelope_id);
	}
}

const until = async (what: string, condition: () => boolean, ms = 2000): Promise<void> => {
	const deadline = Date.now() + ms;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await tick(2);
	}
};

/** An agent with its channel, a fake Slack and a fake domain: nothing here touches a network. */
function world(options: { answer?: (request: AgentRequest) => Promise<string> | string; jobHandler?: Handler; dir?: string; users?: string[]; channels?: string[]; messagesPerHour?: number; now?: () => number; telegram?: boolean; acceptFailures?: number; openFailures?: number } = {}) {
	const dir = options.dir ?? mkdtempSync(join(tmpdir(), "slack-world-"));
	const calls: { method: string; payload: any }[] = [];
	const said = (): { channel: string; thread?: string; text: string }[] =>
		calls.filter((call) => call.method === "chat.postMessage").map((call) => ({ channel: call.payload.channel, ...(call.payload.thread_ts ? { thread: call.payload.thread_ts } : {}), text: call.payload.text }));
	const api: SlackApi = async (method, payload) => (calls.push({ method, payload }), { ok: true, ts: String(calls.length) });
	const tgCalls: any[] = [];
	const tgApi: TelegramApi = async (method, payload) => (tgCalls.push({ method, payload }), { message_id: tgCalls.length });
	const tgSaid = (): string[] => tgCalls.filter((call) => call.method === "sendMessage").map((call) => call.payload.text);
	const domainPosts: any[] = [];
	const client = {
		get: async (): Promise<any> => ({ messages: [] }),
		post: async (path: string, body: any): Promise<any> => void domainPosts.push({ path, body }),
	};
	const store = new SlackStore(join(dir, "slack"), ME);
	const slackSender = new SlackSender({ api, store, agentId: ME });
	const telegramStore = new TelegramStore(join(dir, "telegram"), ME);
	const telegramSender = new TelegramSender({ api: tgApi, store: telegramStore, agentId: ME });
	const routes = [{ sender: slackSender, store }, ...(options.telegram ? [{ sender: telegramSender, store: telegramStore }] : [])];
	const sender: Sender = new RoutedSender(new MessageSender(client), routes);
	const approvals = new Approvals({ client, log: () => undefined, timeoutMinutes: 1, approvers: DEFAULT_THREAD_SETTINGS.approvers, channel: [...(options.telegram ? [telegramApprovals(telegramStore, telegramSender)] : []), slackApprovals(store, slackSender)] });
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
		local: combinedLocal([store, ...(options.telegram ? [telegramStore] : [])]),
		signal: stop.signal,
		boundary: () => "B",
	});
	const sockets: FakeSocket[] = [];
	const sleeps: number[] = [];
	const log: { level: string; event: string; fields?: any }[] = [];
	let acceptFailures = options.acceptFailures ?? 0;
	let openFailures = options.openFailures ?? 0;
	const channel = new SlackChannel({
		api,
		openConnection: async () => {
			if (openFailures-- > 0) throw new Error("Slack API error ratelimited");
			return `wss://fake.slack.test/${sockets.length + 1}`;
		},
		socket: (url) => {
			const socket = new FakeSocket(url);
			sockets.push(socket);
			return socket;
		},
		store,
		allowedUsers: new Set(options.users ?? [OWNER]),
		allowedChannels: new Set(options.channels ?? [CHANNEL]),
		agentId: ME,
		accept: async (message) => {
			if (acceptFailures-- > 0) throw new Error("disk full");
			await engine.acceptLocal(message);
		},
		about: () => `I am ${ME}.`,
		status: async () => "ready: yes",
		jobs,
		approvals,
		messagesPerHour: options.messagesPerHour ?? 30,
		helloTimeoutMs: 60_000,
		log: (level, event, fields) => void log.push({ level, event, fields }),
		...(options.now ? { now: options.now } : {}),
		sleep: async (ms) => void sleeps.push(ms),
	});
	const telegramChannel = new TelegramChannel({ api: tgApi, store: telegramStore, allowed: new Set([4242]), agentId: ME, accept: (message) => engine.acceptLocal(message), about: () => `I am ${ME}.`, status: async () => "ready: yes", jobs, approvals, pollSeconds: 0, sleep: async () => undefined });
	const telegramUpdate = (id: number, text: string) => ({ update_id: id, message: { message_id: id, date: Math.floor(Date.now() / 1000), chat: { id: 4242, type: "private" }, from: { id: 4242, is_bot: false }, text } });
	return { api, calls, said, domainPosts, store, engine, channel, jobs, requests, events, dir, stop, approvals, sender, sockets, sleeps, log, telegramChannel, telegramUpdate, tgSaid, tgCalls, telegramStore };
}

describe("slack channel and the thread engine", () => {
	it("answers a DM with a model run of its own and sends the answer to the DM, not to the domain", async () => {
		const w = world({ answer: () => "Hi Jimmy" });
		await w.channel.handleEvent(dm(10, "hello"));
		await w.engine.idle();
		assert.equal(w.requests.length, 1);
		assert.equal(w.requests[0]!.requestId, "thread:slack:Ev10");
		assert.match(w.requests[0]!.instruction, /slack\/U0OWNER01 \(human\)/);
		assert.match(w.requests[0]!.instruction, /hello/);
		assert.deepEqual(w.said(), [{ channel: DM, text: "Hi Jimmy" }]);
		const post = w.calls.find((call) => call.method === "chat.postMessage")!.payload;
		assert.deepEqual([post.mrkdwn, post.unfurl_links, post.unfurl_media, post.thread_ts], [false, false, false, undefined]);
		assert.deepEqual(w.domainPosts, []);
	});

	it("answers a mention in a thread of the message, and keeps one conversation per thread", async () => {
		const w = world({ answer: (request) => `seen ${request.instruction.includes("first question") ? "it" : "nothing"}` });
		await w.channel.handleEvent(mention(10, `<@${BOT}> first question`));
		await w.engine.idle();
		assert.deepEqual(w.said(), [{ channel: CHANNEL, thread: ts(10), text: "seen it" }]);
		assert.match(w.requests[0]!.instruction, /^(?![\s\S]*<@U0BOTBOT1>)[\s\S]*first question/, "the mention of the bot is not part of what the model reads");
		await w.channel.handleEvent(mention(11, `<@${BOT}> and the second`, { thread_ts: ts(10) }));
		await w.engine.idle();
		assert.match(w.requests[1]!.instruction, /slack\/U0OWNER01 \(human\): first question/);
		assert.deepEqual(w.said()[1], { channel: CHANNEL, thread: ts(10), text: "seen it" });
		await w.channel.handleEvent(mention(12, `<@${BOT}> another thread`));
		await w.engine.idle();
		assert.doesNotMatch(w.requests[2]!.instruction, /first question/);
		assert.equal(w.said()[2]!.thread, ts(12));
	});

	it("gives the model the earlier lines of the DM as history, and sends nothing for NO_REPLY", async () => {
		let answer = "first answer";
		const w = world({ answer: () => answer });
		await w.channel.handleEvent(dm(10, "one"));
		await w.engine.idle();
		answer = "NO_REPLY";
		await w.channel.handleEvent(dm(11, "thanks"));
		await w.engine.idle();
		assert.match(w.requests[1]!.instruction, /slack\/U0OWNER01 \(human\): one/);
		assert.match(w.requests[1]!.instruction, /agent\/qa \(agent\): first answer/);
		assert.equal(w.said().length, 1);
	});

	it("handles an event once, even when Slack delivers it again, with the same event id or a new one for the same message", async () => {
		const w = world();
		await w.channel.handleEvent(dm(10, "hello"));
		await w.channel.handleEvent(dm(10, "hello"));
		await w.channel.handleEvent(dm(10, "hello", {}, OWNER, "Ev99"));
		await w.engine.idle();
		assert.equal(w.requests.length, 1);
		assert.equal(w.said().length, 1);
	});

	it("handles an event once after a restart too, from its own store", async () => {
		const first = world();
		await first.channel.handleEvent(dm(10, "hello"));
		await first.engine.idle();
		const second = world({ dir: first.dir });
		await second.channel.handleEvent(dm(10, "hello"));
		await second.engine.idle();
		assert.equal(second.requests.length, 0);
		assert.deepEqual(second.said(), []);
	});

	it("takes up a message that was not answered when the agent stopped, from its own store", async () => {
		const first = world({ answer: () => new Promise<string>(() => undefined) });
		await first.channel.handleEvent(dm(10, "do the thing"));
		await tick();
		const second = world({ dir: first.dir, answer: () => "done it" });
		assert.equal(second.engine.start(), 1);
		await second.engine.idle();
		assert.match(second.requests[0]!.instruction, /do the thing/);
		assert.deepEqual(second.said(), [{ channel: DM, text: "done it" }]);
	});

	it("serves nobody else: strangers, bots, other channels and edits get no answer and no model run", async () => {
		const w = world();
		await w.channel.handleEvent(dm(10, "hello", {}, STRANGER));
		await w.channel.handleEvent(mention(11, "hello", {}, STRANGER));
		await w.channel.handleEvent(mention(12, "hello", {}, OWNER, "C0OTHER001"));
		await w.channel.handleEvent(dm(13, "hello", { bot_id: "B1" }));
		await w.channel.handleEvent(dm(14, "hello", { subtype: "message_changed" }));
		await w.channel.handleEvent(dm(15, "hello", { user: BOT }));
		await w.engine.idle();
		assert.equal(w.requests.length, 0);
		assert.deepEqual(w.calls, []);
	});

	it("says once per message that it reads text only", async () => {
		const w = world();
		await w.channel.handleEvent(dm(10, "look", { subtype: "file_share", files: [{ id: "F1" }] }));
		await w.channel.handleEvent(dm(10, "look", { subtype: "file_share", files: [{ id: "F1" }] }));
		assert.deepEqual(w.said(), [{ channel: DM, text: "I read text messages only." }]);
		await w.channel.handleEvent(mention(11, `<@${BOT}>`, { files: [{ id: "F2" }] }));
		assert.deepEqual(w.said()[1], { channel: CHANNEL, thread: ts(11), text: "I read text messages only." });
		assert.equal(w.requests.length, 0);
	});

	it("limits what one person can send in an hour, and says so once", async () => {
		let now = Date.parse("2026-10-10T10:00:00Z");
		const w = world({ messagesPerHour: 2, now: () => now });
		for (const n of [1, 2, 3, 4]) await w.channel.handleEvent(dm(n, `m${n}`));
		await w.engine.idle();
		assert.equal(w.requests.length, 2);
		assert.equal(w.said().filter((line) => /more than 2 messages an hour/.test(line.text)).length, 1);
		now += 3_700_000;
		await w.channel.handleEvent(dm(5, "again"));
		await w.engine.idle();
		assert.equal(w.requests.length, 3);
	});

	it("does not count commands against the limit", async () => {
		const w = world({ messagesPerHour: 1 });
		for (const n of [1, 2, 3]) await w.channel.handleEvent(dm(n, "!jobs"));
		await w.channel.handleEvent(dm(4, "hello"));
		await w.engine.idle();
		assert.equal(w.requests.length, 1);
	});

	it("retries a message that the engine could not take, and when it cannot be taken lets a redelivery try again", async () => {
		const flaky = world({ acceptFailures: 2 });
		await flaky.channel.handleEvent(dm(10, "hello"));
		await flaky.engine.idle();
		assert.equal(flaky.requests.length, 1);
		assert.deepEqual(flaky.sleeps, [250, 500]);

		const broken = world({ acceptFailures: 3 });
		await broken.channel.handleEvent(dm(10, "hello"));
		await broken.engine.idle();
		assert.equal(broken.requests.length, 0);
		assert.ok(broken.log.some((line) => line.event === "slack_accept_failed" && line.fields.error === "disk full"));
		await broken.channel.handleEvent(dm(10, "hello"));
		await broken.engine.idle();
		assert.equal(broken.requests.length, 1, "the redelivery is taken up");
	});

	it("reports the end of a job started in a Slack thread back into the thread, and still publishes its events to the domain", async () => {
		const w = world();
		const conversationId = `slack:${CHANNEL}:${ts(1)}`;
		const entry = w.jobs.start({ capability: { id: "qa.verify", version: "1" }, input: {}, label: "verify SAD-1", requestedBy: { kind: "human", id: `slack/${OWNER}` }, conversationId, audience: [{ kind: "human", id: `slack/${OWNER}` }], source: "message" });
		await w.jobs.idle();
		const told = w.said().find((line) => line.text.includes(entry.id));
		assert.match(told?.text ?? "", /all green/);
		assert.match(told?.text ?? "", /1 attachment\(s\) are kept in the domain.*run\.mp4 \(art-1\)/);
		assert.equal(told?.thread, ts(1));
		assert.deepEqual(w.domainPosts, []);
		assert.deepEqual(w.events, [`started:${conversationId}`, `finished:${conversationId}`]);
	});

	it("sends what concerns other conversations through the domain as before", async () => {
		const w = world();
		const out: OutgoingMessage = { recipients: [{ kind: "agent", id: "agent/reviewer" }], conversationId: "conv_9", text: "hello", key: "k" };
		await w.sender.send(out);
		assert.equal(w.domainPosts.length, 1);
		assert.equal(w.domainPosts[0].path, "/v1/messages");
		assert.deepEqual(w.said(), []);
	});

	it("cuts long answers into chunks of 3000 characters and keeps the tokens out of them", async () => {
		const w = world({ answer: () => `${"a".repeat(3500)} ${BOT_TOKEN}` });
		const sender = new SlackSender({ api: slackApi({ botToken: BOT_TOKEN, appToken: APP_TOKEN }, (async (_url: string, init: any) => (w.calls.push({ method: "http", payload: JSON.parse(init.body) }), reply({ ok: true }))) as any), store: w.store, agentId: ME });
		await sender.send({ recipients: [], conversationId: `slack:${DM}`, text: `${"a".repeat(3500)} ${BOT_TOKEN} ${APP_TOKEN}`, key: "k" });
		const posts = w.calls.filter((call) => call.method === "http").map((call) => call.payload.text as string);
		assert.deepEqual(posts.map((text) => text.length <= 3000), posts.map(() => true));
		assert.ok(posts.length >= 2);
		assert.doesNotMatch(posts.join(""), /botsecret|appsecret/);
		await assert.rejects(sender.send({ recipients: [], conversationId: "tg:1", text: "x", key: "k" }), /not a Slack conversation/);
	});
});

describe("slack commands", () => {
	it("answers the commands without a model run, in the thread of a mention", async () => {
		const w = world();
		await w.channel.handleEvent(dm(1, "!help"));
		await w.channel.handleEvent(dm(2, "!status"));
		await w.channel.handleEvent(dm(3, "!jobs"));
		await w.channel.handleEvent(dm(4, "!stop"));
		await w.channel.handleEvent(dm(5, "!stop job-none"));
		await w.channel.handleEvent(dm(6, "!frobnicate"));
		await w.channel.handleEvent(mention(7, `<@${BOT}> !status`));
		assert.equal(w.requests.length, 0);
		const said = w.said();
		assert.match(said[0]!.text, /I am agent\/qa\.[\s\S]*Commands: !status, !jobs, !stop <job>, !approve <id>, !deny <id>, !help\./);
		assert.equal(said[1]!.text, "ready: yes");
		assert.match(said[2]!.text, /Active \(0\):/);
		assert.match(said[3]!.text, /Say which job: !stop <job id>/);
		assert.equal(said[4]!.text, "I have no such job.");
		assert.match(said[5]!.text, /I do not know !frobnicate\. !help, !status/);
		assert.deepEqual(said[6], { channel: CHANNEL, thread: ts(7), text: "ready: yes" });
	});

	it("takes text that only looks like a command as a message", async () => {
		const w = world();
		await w.channel.handleEvent(dm(1, "/status please"));
		await w.channel.handleEvent(dm(2, "!!! urgent"));
		await w.channel.handleEvent(dm(3, "hello !stop"));
		await w.engine.idle();
		assert.equal(w.requests.length, 3);
	});

	it("stops a job from Slack as a signal", async () => {
		let open: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => (open = resolve));
		const w = world({ jobHandler: async () => (await gate, { type: "completed", result: {} }) });
		const entry = w.jobs.start({ capability: { id: "qa.verify", version: "1" }, input: {}, label: "long", requestedBy: { kind: "human", id: `slack/${OWNER}` }, conversationId: `slack:${DM}`, source: "message" });
		await tick();
		await w.channel.handleEvent(dm(1, `!stop ${entry.id}`));
		assert.match(w.said()[0]!.text, /The job was told/);
		open();
		await w.jobs.idle();
	});

	it("asks for an approval in the conversation and takes the answer from !approve and !deny, from the person asked only", async () => {
		const w = world();
		const asked = w.approvals.ask({ approver: { kind: "human", id: `slack/${OWNER}` }, conversationId: `slack:${DM}`, agent: ME, tool: "bash", summary: "run the migration", signal: new AbortController().signal });
		await tick();
		const question = w.said()[0]!.text;
		const id = /!approve ([0-9a-f]+)/.exec(question)![1]!;
		assert.match(question, /Approval needed \(agent\/qa\): bash: run the migration\nAnswer !approve [0-9a-f]+ or !deny [0-9a-f]+\./);
		assert.doesNotMatch(question, /\/approve/);
		assert.deepEqual(w.domainPosts, []);
		assert.equal(w.approvals.decide(id, { kind: "human", id: "slack/U0STRANGER" }, `slack:${DM}`, true), "rejected");
		await w.channel.handleEvent(dm(1, `!approve ${id}`));
		assert.deepEqual(await asked, { approved: true });
		await w.channel.handleEvent(dm(2, `!deny ${id}`));
		assert.match(w.said().at(-1)!.text, /no open question/);
	});

	it("takes a denial from the thread it was asked in, and nowhere else", async () => {
		const w = world();
		const conversationId = `slack:${CHANNEL}:${ts(1)}`;
		const asked = w.approvals.ask({ approver: { kind: "human", id: `slack/${OWNER}` }, conversationId, agent: ME, tool: "bash", summary: "x", signal: new AbortController().signal });
		await tick();
		assert.equal(w.said()[0]!.thread, ts(1));
		const id = /!deny ([0-9a-f]+)/.exec(w.said()[0]!.text)![1]!;
		await w.channel.handleEvent(dm(1, `!deny ${id}`));
		assert.match(w.said().at(-1)!.text, /not put to you here/);
		await w.channel.handleEvent(mention(2, `<@${BOT}> !deny ${id}`, { thread_ts: ts(1) }));
		assert.deepEqual(await asked, { approved: false, reason: "denied by the approver" });
	});

	it("asks an approver outside Slack through the domain, in a conversation of its own", async () => {
		const w = world();
		const asked = w.approvals.ask({ approver: { kind: "agent", id: "agent/manager" }, conversationId: `slack:${DM}`, agent: ME, tool: "bash", summary: "x", signal: AbortSignal.timeout(50) });
		await tick();
		assert.equal(w.domainPosts.length, 1);
		assert.equal(w.domainPosts[0].body.conversationId, undefined);
		assert.deepEqual(w.said(), []);
		assert.equal((await asked).approved, false);
	});
});

const hello = { type: "hello", num_connections: 1, debug_info: { host: "wss-111" } };

describe("slack socket mode", () => {
	const start = (w: ReturnType<typeof world>) => {
		const stop = new AbortController();
		const done = w.channel.run(stop.signal);
		return { stop, done };
	};

	it("connects, acknowledges every envelope at once and answers the events in them", async () => {
		const w = world({ answer: () => "Hi" });
		const { stop, done } = start(w);
		await until("a connection", () => w.sockets.length === 1);
		const socket = w.sockets[0]!;
		assert.equal(socket.url, "wss://fake.slack.test/1");
		socket.receive(hello);
		socket.receive(envelope("e1", dm(10, "hello")));
		socket.receive(envelope("e2", { type: "block_actions" }, "interactive"));
		socket.receive(envelope("e3", { command: "/x" }, "slash_commands"));
		socket.receive(envelope("e4", dm(11, "hello", {}, STRANGER)));
		assert.deepEqual(socket.acks, ["e1", "e2", "e3", "e4"], "acknowledged before anything is answered");
		await until("the answer", () => w.said().length === 1);
		assert.deepEqual(w.said(), [{ channel: DM, text: "Hi" }]);
		stop.abort();
		await done;
		assert.ok(socket.closed);
		assert.deepEqual(w.log.map((line) => line.event), ["slack_started", "slack_connected", "slack_disconnected", "slack_stopped"]);
	});

	it("answers a redelivered envelope once, acknowledging it each time", async () => {
		const w = world();
		const { stop, done } = start(w);
		await until("a connection", () => w.sockets.length === 1);
		const socket = w.sockets[0]!;
		socket.receive(hello);
		socket.receive({ ...envelope("e1", dm(10, "hello")), retry_attempt: 0 });
		socket.receive({ ...envelope("e1", dm(10, "hello")), retry_attempt: 1, retry_reason: "timeout" });
		socket.receive(envelope("e2", dm(10, "hello", {}, OWNER, "Ev77")));
		await w.engine.idle();
		await until("both to be settled", () => socket.acks.length === 3);
		await tick(20);
		await w.engine.idle();
		assert.equal(w.requests.length, 1);
		assert.equal(w.said().length, 1);
		stop.abort();
		await done;
	});

	it("keeps events in order and does not hold up the acknowledgement of a later one behind a slow answer", async () => {
		let release: () => void = () => undefined;
		const slow = new Promise<void>((resolve) => (release = resolve));
		const w = world({ answer: async () => (await slow, "ok") });
		const { stop, done } = start(w);
		await until("a connection", () => w.sockets.length === 1);
		const socket = w.sockets[0]!;
		socket.receive(hello);
		socket.receive(envelope("e1", dm(10, "one")));
		socket.receive(envelope("e2", dm(11, "two")));
		assert.deepEqual(socket.acks, ["e1", "e2"]);
		release();
		await until("both answers", () => w.said().length === 2);
		stop.abort();
		await done;
	});

	it("answers a ping of Slack's with a pong and ignores what it cannot read", async () => {
		const w = world();
		const { stop, done } = start(w);
		await until("a connection", () => w.sockets.length === 1);
		const socket = w.sockets[0]!;
		socket.receive(hello);
		socket.receive({ type: "ping", num: 3 });
		socket.receive("not json");
		socket.receive("null");
		socket.receive({ type: "something_new", envelope_id: "e9" });
		assert.deepEqual(socket.sent, [{ type: "pong", num: 3 }, { envelope_id: "e9" }]);
		stop.abort();
		await done;
	});

	it("connects again at once, with a fresh address, when Slack asks it to disconnect", async () => {
		const w = world();
		const { stop, done } = start(w);
		await until("a connection", () => w.sockets.length === 1);
		w.sockets[0]!.receive(hello);
		w.sockets[0]!.receive({ type: "disconnect", reason: "refresh_requested" });
		await until("the second connection", () => w.sockets.length === 2);
		assert.deepEqual(w.sockets.map((socket) => socket.url), ["wss://fake.slack.test/1", "wss://fake.slack.test/2"]);
		assert.ok(w.sockets[0]!.closed);
		assert.deepEqual(w.sleeps, [], "no waiting");
		assert.ok(w.log.some((line) => line.event === "slack_disconnected" && line.fields.why === "refresh_requested"));
		w.sockets[1]!.receive(hello);
		w.sockets[1]!.receive(envelope("e1", dm(10, "hello")));
		await until("the answer", () => w.said().length === 1);
		stop.abort();
		await done;
	});

	it("waits before connecting again when Slack disconnects it before it was ever connected", async () => {
		const w = world();
		const { stop, done } = start(w);
		await until("a connection", () => w.sockets.length === 1);
		w.sockets[0]!.receive({ type: "disconnect", reason: "link_disabled" });
		await until("the second connection", () => w.sockets.length === 2);
		assert.deepEqual(w.sleeps, [1000]);
		stop.abort();
		await done;
	});

	it("connects again when the socket closes or fails, backing off from one second and starting over after a good connection", async () => {
		const w = world();
		const { stop, done } = start(w);
		await until("a connection", () => w.sockets.length === 1);
		w.sockets[0]!.receive(hello);
		w.sockets[0]!.drop();
		await until("the second connection", () => w.sockets.length === 2);
		w.sockets[1]!.fail();
		await until("the third connection", () => w.sockets.length === 3);
		w.sockets[2]!.drop();
		await until("the fourth connection", () => w.sockets.length === 4);
		w.sockets[3]!.receive(hello);
		w.sockets[3]!.drop();
		await until("the fifth connection", () => w.sockets.length === 5);
		assert.deepEqual(w.sleeps, [1000, 2000, 4000, 1000]);
		assert.deepEqual(new Set(w.sockets.map((socket) => socket.url)).size, 5, "every connection has an address of its own");
		stop.abort();
		await done;
	});

	it("backs off from one second up to thirty when Slack cannot be asked for a connection, and never logs more than a cut of the error", async () => {
		const w = world({ openFailures: 8 });
		const stop = new AbortController();
		const done = w.channel.run(stop.signal);
		await until("the ninth try", () => w.sockets.length === 1);
		assert.deepEqual(w.sleeps, [1000, 2000, 4000, 8000, 16_000, 30_000, 30_000, 30_000]);
		assert.equal(w.log.filter((line) => line.event === "slack_connection_failed").length, 8);
		assert.ok(w.log.every((line) => !/wss:|xapp|xoxb/.test(JSON.stringify(line))));
		stop.abort();
		await done;
	});

	it("drops a connection that does not say hello", async () => {
		const w = world();
		const slowHello = new SlackChannel({ api: w.api, openConnection: async () => "wss://fake.slack.test/1", socket: (url) => (w.sockets.push(new FakeSocket(url)), w.sockets.at(-1)!), store: w.store, allowedUsers: new Set([OWNER]), allowedChannels: new Set(), agentId: ME, accept: async () => undefined, about: () => "", status: async () => "", jobs: w.jobs, approvals: w.approvals, helloTimeoutMs: 10, sleep: async (ms) => void w.sleeps.push(ms) });
		const stop = new AbortController();
		const done = slowHello.run(stop.signal);
		await until("the second connection", () => w.sockets.length === 2);
		assert.ok(w.sockets[0]!.closed);
		assert.deepEqual(w.sleeps.slice(0, 1), [1000]);
		stop.abort();
		await done;
	});

	it("stops cleanly on abort, while connected, while waiting to connect again and before it started", async () => {
		const connected = world();
		const first = start(connected);
		await until("a connection", () => connected.sockets.length === 1);
		connected.sockets[0]!.receive(hello);
		first.stop.abort();
		await first.done;
		assert.ok(connected.sockets[0]!.closed);
		connected.sockets[0]!.drop();
		await tick(20);
		assert.equal(connected.sockets.length, 1, "no connection after the stop");

		const waiting = new AbortController();
		const slowWorld = world();
		const channel = new SlackChannel({ api: slowWorld.api, openConnection: async () => { throw new Error("down"); }, store: slowWorld.store, allowedUsers: new Set([OWNER]), allowedChannels: new Set(), agentId: ME, accept: async () => undefined, about: () => "", status: async () => "", jobs: slowWorld.jobs, approvals: slowWorld.approvals, sleep: (_ms, signal) => new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true })) });
		const done = channel.run(waiting.signal);
		await tick(20);
		waiting.abort();
		await done;

		const early = world();
		const before = new AbortController();
		before.abort();
		await early.channel.run(before.signal);
		assert.equal(early.sockets.length, 0);
	});

	it("waits for the event being answered before it says it has stopped", async () => {
		const w = world();
		const { stop, done } = start(w);
		await until("a connection", () => w.sockets.length === 1);
		w.sockets[0]!.receive(hello);
		w.sockets[0]!.receive(envelope("e1", dm(1, "!status")));
		stop.abort();
		await done;
		assert.equal(w.said().length, 1);
		assert.equal(w.log.at(-1)!.event, "slack_stopped");
	});

	it("does not log tokens, addresses or what people wrote", async () => {
		const w = world({ answer: () => "secret answer" });
		const { stop, done } = start(w);
		await until("a connection", () => w.sockets.length === 1);
		w.sockets[0]!.receive(hello);
		w.sockets[0]!.receive(envelope("e1", dm(1, "my private words")));
		await until("the answer", () => w.said().length === 1);
		stop.abort();
		await done;
		assert.doesNotMatch(JSON.stringify(w.log), /private words|secret answer|wss:|xoxb|xapp/);
	});
});

describe("telegram and slack in one agent", () => {
	it("keeps the conversations of each channel apart: a Telegram message is answered on Telegram, a Slack one on Slack", async () => {
		const w = world({ telegram: true, answer: (request) => (/from Telegram/.test(request.instruction) ? "answer for Telegram" : "answer for Slack") });
		await w.telegramChannel.handleUpdate(w.telegramUpdate(10, "hello from Telegram"));
		await w.channel.handleEvent(dm(11, "hello from Slack"));
		await w.engine.idle();
		assert.deepEqual(w.tgSaid(), ["answer for Telegram"]);
		assert.deepEqual(w.said(), [{ channel: DM, text: "answer for Slack" }]);
		assert.deepEqual(w.domainPosts, []);
		assert.deepEqual(w.requests.map((request) => request.requestId).sort(), ["thread:slack:Ev11", "thread:tg:10"]);
	});

	it("reads the history of a conversation from the channel that keeps it", async () => {
		const w = world({ telegram: true, answer: () => "ok" });
		await w.telegramChannel.handleUpdate(w.telegramUpdate(10, "telegram words"));
		await w.engine.idle();
		await w.channel.handleEvent(dm(11, "slack words"));
		await w.engine.idle();
		await w.telegramChannel.handleUpdate(w.telegramUpdate(12, "more telegram"));
		await w.channel.handleEvent(dm(13, "more slack"));
		await w.engine.idle();
		const byId = (id: string) => w.requests.find((request) => request.requestId === `thread:${id}`)!.instruction;
		assert.match(byId("tg:12"), /telegram words/);
		assert.doesNotMatch(byId("tg:12"), /slack words/);
		assert.match(byId("slack:Ev13"), /slack words/);
		assert.doesNotMatch(byId("slack:Ev13"), /telegram words/);
	});

	it("routes job reports and everything said into a conversation by its prefix, and the rest through the domain", async () => {
		const w = world({ telegram: true });
		const start = (conversationId: string, id: string) => w.jobs.start({ capability: { id: "qa.verify", version: "1" }, input: {}, label: id, requestedBy: { kind: "human", id }, conversationId, audience: [{ kind: "human", id }], source: "message" });
		const onTelegram = start("tg:4242", "telegram/4242");
		const onSlack = start(`slack:${DM}`, `slack/${OWNER}`);
		await w.jobs.idle();
		assert.ok(w.tgSaid().some((text) => text.includes(onTelegram.id)));
		assert.ok(!w.tgSaid().some((text) => text.includes(onSlack.id)));
		assert.ok(w.said().some((line) => line.text.includes(onSlack.id)));
		assert.ok(!w.said().some((line) => line.text.includes(onTelegram.id)));
		assert.deepEqual(w.domainPosts, []);
		await w.sender.send({ recipients: [{ kind: "agent", id: "agent/reviewer" }], conversationId: "conv_9", text: "hello", key: "k" });
		assert.equal(w.domainPosts.length, 1);
	});

	it("asks an approval on the channel that carries the conversation, in that channel's words, and only reaches its own people", async () => {
		const w = world({ telegram: true });
		const never = new AbortController().signal;
		const onTelegram = w.approvals.ask({ approver: { kind: "human", id: "telegram/4242" }, conversationId: "tg:4242", agent: ME, tool: "bash", summary: "a", signal: never });
		const onSlack = w.approvals.ask({ approver: { kind: "human", id: `slack/${OWNER}` }, conversationId: `slack:${DM}`, agent: ME, tool: "bash", summary: "b", signal: never });
		await tick();
		assert.match(w.tgSaid()[0]!, /Answer \/approve [0-9a-f]+ or \/deny/);
		assert.match(w.said()[0]!.text, /Answer !approve [0-9a-f]+ or !deny/);
		assert.equal(w.tgSaid().length + w.said().length, 2, "each question went to one channel");
		await w.telegramChannel.handleUpdate(w.telegramUpdate(1, `/approve ${/\/approve ([0-9a-f]+)/.exec(w.tgSaid()[0]!)![1]}`));
		await w.channel.handleEvent(dm(2, `!deny ${/!approve ([0-9a-f]+)/.exec(w.said()[0]!.text)![1]}`));
		assert.deepEqual(await onTelegram, { approved: true });
		assert.deepEqual(await onSlack, { approved: false, reason: "denied by the approver" });
	});

	it("asks an approver of the other channel, or of none, through the domain", async () => {
		const w = world({ telegram: true });
		const asks = [
			w.approvals.ask({ approver: { kind: "human", id: `slack/${OWNER}` }, conversationId: "tg:4242", agent: ME, tool: "bash", summary: "x", signal: AbortSignal.timeout(50) }),
			w.approvals.ask({ approver: { kind: "human", id: "telegram/4242" }, conversationId: `slack:${DM}`, agent: ME, tool: "bash", summary: "x", signal: AbortSignal.timeout(50) }),
			w.approvals.ask({ approver: { kind: "agent", id: "agent/manager" }, conversationId: "conv_1", agent: ME, tool: "bash", summary: "x", signal: AbortSignal.timeout(50) }),
		];
		await tick();
		assert.equal(w.domainPosts.length, 3);
		assert.deepEqual([w.tgSaid(), w.said()], [[], []]);
		assert.deepEqual((await Promise.all(asks)).map((decision) => decision.approved), [false, false, false]);
	});

	it("combines the stores by prefix", () => {
		const w = world({ telegram: true });
		const both = combinedLocal([w.store, w.telegramStore]);
		assert.ok(both.owns("tg:1") && both.owns(`slack:${DM}`) && both.owns("slack:Ev1") && !both.owns("conv_1") && !both.owns(undefined));
		assert.equal(both.message("conv_1"), undefined);
		assert.deepEqual(both.history("conv_1", "m", 5, 100), []);
	});

	it("keeps the old way of building a routed sender working", async () => {
		const w = world({ telegram: true });
		const seen: string[] = [];
		const route = (name: string): Sender => ({ send: async () => void seen.push(name) });
		const sender = new RoutedSender(route("domain"), route("telegram"), w.telegramStore);
		for (const conversationId of ["tg:1", "conv_1", `slack:${DM}`, undefined]) await sender.send({ recipients: [], ...(conversationId ? { conversationId } : {}), text: "x", key: "k" });
		assert.deepEqual(seen, ["telegram", "domain", "domain", "domain"]);
	});
});

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { sleep } from "@somework/sdk";
import { freePort, startDomain } from "../../../sdk/typescript/test/harness.ts";

const here = new URL(".", import.meta.url).pathname;
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const logs = new Map<ChildProcess, string>();
const run = (script: string, env: Record<string, string>): ChildProcess => {
	const child = spawn("node", [script], { env: { PATH: process.env.PATH!, HOME: process.env.HOME!, ...env }, stdio: ["ignore", "ignore", "pipe"] });
	logs.set(child, "");
	child.stderr!.on("data", (d) => logs.set(child, logs.get(child)! + d));
	return child;
};

const logOf = (world: { service: ChildProcess }): string => logs.get(world.service) ?? "";

async function until<T>(what: string, read: () => Promise<T | undefined | false>, ms = 30_000): Promise<T> {
	const deadline = Date.now() + ms;
	for (;;) {
		const value = await read().catch(() => undefined);
		if (value) return value;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}\n${[...logs.values()].join("\n").slice(-3000)}`);
		await sleep(150);
	}
}

async function boot(plan: string[], extraEnv: Record<string, string> = {}) {
	const domain = await startDomain({ cardFile: join(here, "../../../adapters/pi/card.json") });
	cleanups.push(() => domain.stop());
	const dir = mkdtempSync(join(tmpdir(), "threads-e2e-"));
	const workspaces = join(dir, "workspaces");
	mkdirSync(workspaces);
	const state = join(dir, "state");
	mkdirSync(state);
	const tokenFile = join(dir, "sandbox-token");
	writeFileSync(tokenFile, "s".repeat(48));
	const sandboxPort = await freePort();
	const sandbox = run(join(here, "../src/sandbox/main.ts"), { SANDBOX_TOKEN_FILE: tokenFile, SANDBOX_ROOT: workspaces, SANDBOX_PORT: String(sandboxPort), SANDBOX_HOST: "127.0.0.1" });
	cleanups.push(() => void sandbox.kill("SIGKILL"));
	await until("the sandbox", async () => (await fetch(`http://127.0.0.1:${sandboxPort}/healthz`)).ok);
	const healthPort = await freePort();
	const start = (): ChildProcess => {
		const service = run(join(here, "fixtures/threads-main.ts"), {
			SOMEWORK_URL: domain.url,
			SOMEWORK_KEY_FILE: join(domain.dir, "worker.key.json"),
			PI_STATE_DIR: state,
			PI_PROVIDER: "faux",
			PI_FAUX_PLAN: JSON.stringify(plan),
			SANDBOX_URL: `http://127.0.0.1:${sandboxPort}`,
			SANDBOX_TOKEN_FILE: tokenFile,
			SANDBOX_WORKSPACES: workspaces,
			HEALTH_PORT: String(healthPort),
			PI_CONCURRENCY: "2",
			...extraEnv,
		});
		cleanups.push(() => void service.kill("SIGKILL"));
		return service;
	};
	const service = start();
	await until("the service to be ready", async () => (await (await fetch(`http://127.0.0.1:${healthPort}/ready`)).json() as any).ready);
	const inbox = async (): Promise<any[]> => ((await domain.author.get("/v1/inbox?limit=100")) as any).messages ?? [];
	const texts = async (): Promise<string[]> => (await inbox()).map((entry) => String(entry?.content?.data ?? entry?.message?.content?.data ?? ""));
	const say = (text: string, conversationId?: string) =>
		domain.author.post("/v1/messages", { recipients: [{ kind: "agent", id: "agent/ts-worker" }], ...(conversationId ? { conversationId } : {}), content: { mediaType: "text/plain", data: text }, triggerMode: "directed" });
	return { domain, service, say, inbox, texts, healthPort, state, start };
}

describe("conversations and jobs end to end (real domain, real sandbox, real service process)", () => {
	it("answers a message with a model run and sends the answer back", async () => {
		const world = await boot(["final:Hello from the worker."]);
		await world.say("hi there");
		await until("the answer", async () => (await world.texts()).some((text) => text.includes("Hello from the worker.")));
	});

	it("says nothing when the model answers NO_REPLY", async () => {
		const world = await boot(["final:NO_REPLY"]);
		await world.say("thanks!");
		await until("the message to be handled", async () => /thread_no_reply/.test([...logs.values()].join("")));
		assert.ok(!(await world.texts()).some((text) => text.includes("NO_REPLY")));
	});

	it("keeps the Telegram channel off, and says why, when there is a bot token but nobody is allowed to write to it", async () => {
		const world = await boot(["final:Hello from the worker."], { TELEGRAM_BOT_TOKEN: "123:not-a-real-token" });
		await until("the refusal to be logged", async () => /telegram_disabled/.test([...logs.values()].join("")));
		assert.match([...logs.values()].join(""), /TELEGRAM_ALLOWED_USER_IDS is required/);
		assert.doesNotMatch([...logs.values()].join(""), /not-a-real-token/);
		const profile = (await (await fetch(`http://127.0.0.1:${world.healthPort}/profile`)).json()) as any;
		assert.deepEqual(profile.telegram, { enabled: false, allowedUsers: 0 });
		await world.say("hi there");
		await until("the answer", async () => (await world.texts()).some((text) => text.includes("Hello from the worker.")));
	});

	it("keeps the Slack app off, and says why, when only one of its two tokens is there or nobody is allowed to write to it", async () => {
		const only = await boot(["final:Hello from the worker."], { SLACK_BOT_TOKEN: "xoxb-secret-bot-token" });
		await until("the refusal to be logged", async () => /slack_disabled/.test(logOf(only)));
		assert.match(logOf(only), /the Slack app token is missing or empty/);
		assert.doesNotMatch(logOf(only), /xoxb-secret-bot-token/);
		const profile = (await (await fetch(`http://127.0.0.1:${only.healthPort}/profile`)).json()) as any;
		assert.deepEqual(profile.slack, { enabled: false, allowedUsers: 0, channels: 0 });
	});

	it("keeps the Slack app off, and says why, when both tokens are there and nobody is allowed to write to it", async () => {
		const world = await boot(["final:Hello from the worker."], { SLACK_BOT_TOKEN: "xoxb-secret-bot-token", SLACK_APP_TOKEN: "xapp-1-secret-app-token" });
		await until("the refusal to be logged", async () => /slack_disabled/.test(logOf(world)));
		assert.match(logOf(world), /SLACK_ALLOWED_USER_IDS is required/);
		assert.doesNotMatch(logOf(world), /secret-(bot|app)-token/);
	});

	it("treats empty Slack token files (a /dev/null mount) as not configured: no reason, no crash, the agent answers", async () => {
		const off = await boot(["final:Hello from the worker."], { SLACK_BOT_TOKEN_FILE: "/dev/null", SLACK_APP_TOKEN_FILE: "/dev/null", SLACK_ALLOWED_USER_IDS: "U0OWNER01" });
		await off.say("hi there");
		await until("the answer", async () => (await off.texts()).some((text) => text.includes("Hello from the worker.")));
		assert.doesNotMatch(logOf(off), /slack_disabled/);
		assert.deepEqual(((await (await fetch(`http://127.0.0.1:${off.healthPort}/profile`)).json()) as any).slack, { enabled: false, allowedUsers: 0, channels: 0 });
	});

	it("says which Slack token is missing when one file is empty and the other holds a token", async () => {
		const dir = mkdtempSync(join(tmpdir(), "slack-token-"));
		writeFileSync(join(dir, "bot-token"), "xoxb-secret-bot-token\n");
		const world = await boot(["final:Hello from the worker."], { SLACK_BOT_TOKEN_FILE: join(dir, "bot-token"), SLACK_APP_TOKEN_FILE: "/dev/null", SLACK_ALLOWED_USER_IDS: "U0OWNER01" });
		await until("the refusal to be logged", async () => /slack_disabled/.test(logOf(world)));
		assert.match(logOf(world), /the Slack app token is missing or empty/);
		assert.doesNotMatch(logOf(world), /secret-bot-token/);
	});

	it("serves a Slack DM end to end through the service: acknowledged, answered in the DM, and nothing for a stranger", async () => {
		const dir = mkdtempSync(join(tmpdir(), "slack-stub-"));
		const calls = (): any[] => (existsSync(join(dir, "calls.jsonl")) ? readFileSync(join(dir, "calls.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);
		const acks = (): string[] => (existsSync(join(dir, "acks.jsonl")) ? readFileSync(join(dir, "acks.jsonl"), "utf8").split("\n").filter(Boolean) : []);
		const deliver = (envelopeId: string, eventId: string, user: string, text: string): void =>
			appendFileSync(join(dir, "inbound.jsonl"), `${JSON.stringify({ type: "events_api", envelope_id: envelopeId, payload: { type: "event_callback", event_id: eventId, authorizations: [{ user_id: "U0BOTBOT1" }], event: { type: "message", channel_type: "im", channel: "D0123ABCD", user, text, ts: `${Math.floor(Date.now() / 1000)}.000100` } } })}\n`);
		const world = await boot(["final:Hello from Slack."], {
			SLACK_BOT_TOKEN: "xoxb-test-bot-token",
			SLACK_APP_TOKEN: "xapp-1-test-app-token",
			SLACK_ALLOWED_USER_IDS: "U0OWNER01",
			SLACK_ALLOWED_CHANNELS: "C0123ABCD",
			SLACK_STUB_DIR: dir,
			NODE_OPTIONS: `--import=${join(here, "fixtures/slack-stub.ts")}`,
		});
		const profile = (await (await fetch(`http://127.0.0.1:${world.healthPort}/profile`)).json()) as any;
		assert.deepEqual(profile.slack, { enabled: true, allowedUsers: 1, channels: 1 });
		await until("the connection", async () => calls().some((call) => call.method === "apps.connections.open"));
		assert.equal(calls().find((call) => call.method === "apps.connections.open").authorization, "Bearer xapp-1-test-app-token");
		deliver("env-1", "Ev1", "U0STRANGER", "let me in");
		deliver("env-2", "Ev2", "U0OWNER01", "hello");
		deliver("env-3", "Ev2", "U0OWNER01", "hello");
		await until("the answer", async () => calls().some((call) => call.method === "chat.postMessage"));
		await until("the acknowledgements", async () => acks().length === 3);
		assert.deepEqual(acks().map((line) => JSON.parse(line).envelope_id), ["env-1", "env-2", "env-3"]);
		await until("the answer to be settled", async () => /thread_answered/.test(logOf(world)));
		const posts = calls().filter((call) => call.method === "chat.postMessage");
		assert.equal(posts.length, 1, "one answer for the person, none for the stranger, none for the redelivery");
		assert.equal(posts[0].authorization, "Bearer xoxb-test-bot-token");
		assert.deepEqual([posts[0].body.channel, posts[0].body.text, posts[0].body.thread_ts], ["D0123ABCD", "Hello from Slack.", undefined]);
		assert.deepEqual((await world.texts()).filter((text) => text.includes("Hello from Slack.")), [], "the domain never sees a Slack conversation");
		assert.doesNotMatch(logOf(world), /xoxb-test-bot-token|xapp-1-test-app-token/);
	});

	it("starts a job from a tool call, answers at once, and posts the job's result to the conversation by itself", async () => {
		const world = await boot(["call:start_demo:{\"topic\":\"x\"}", "final:The demo is running."]);
		await world.say("please run the demo for x");
		const reply = await until("the reply and the result", async () => ((await world.texts()).filter((text) => text.includes("The demo is running.")).length >= 2 ? await world.texts() : undefined));
		assert.ok(reply.some((text) => text.includes("demo x")), "the job's result names the job");
		const status = (await (await fetch(`http://127.0.0.1:${world.healthPort}/status`)).json()) as any;
		assert.equal(status.chat.jobs, 0, "nothing is left running");
	});
});

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { sleep } from "@somework/sdk";
import { freePort, startDomain } from "../../../sdk/typescript/test/harness.ts";
import { CHAT_REPLY_LABEL } from "../src/chat.ts";
import { makeRemote } from "../src/testing.ts";

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

async function until<T>(what: string, read: () => Promise<T | undefined | false>, ms = 30_000): Promise<T> {
	const deadline = Date.now() + ms;
	for (;;) {
		const value = await read().catch(() => undefined);
		if (value) return value;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}\n${[...logs.values()].join("\n").slice(-2500)}`);
		await sleep(150);
	}
}

/** The real service process answering chat with a model (faux), a real domain and a real sandbox daemon. */
describe("chat end to end (real domain, real sandbox, real service process)", () => {
	it("answers a question from the model, runs an instruction as a job and keeps both in the chat pool", async () => {
		const domain = await startDomain({ cardFile: join(here, "../../../adapters/pi/card.json") });
		cleanups.push(() => domain.stop());
		const { remote } = makeRemote();
		const dir = mkdtempSync(join(tmpdir(), "chat-e2e-"));
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
		const service = run(join(here, "fixtures/chat-main.ts"), {
			SOMEWORK_URL: domain.url,
			SOMEWORK_KEY_FILE: join(domain.dir, "worker.key.json"),
			PI_STATE_DIR: state,
			PI_PROVIDER: "faux",
			PI_FAUX_PLAN: JSON.stringify(["write:feature.txt:from chat", "final:the model answered"]),
			SANDBOX_URL: `http://127.0.0.1:${sandboxPort}`,
			SANDBOX_TOKEN_FILE: tokenFile,
			SANDBOX_WORKSPACES: workspaces,
			HEALTH_PORT: String(healthPort),
			PI_CONCURRENCY: "1",
			SOMEWORK_LEASE_SECONDS: "5",
			CHAT_ALLOWED_SENDERS: "agent/ts-author",
			CHAT_INSTRUCTORS: "agent/ts-author",
			CHAT_BUSY_AFTER_SECONDS: "60",
			FIXTURE_REMOTE: remote,
		});
		cleanups.push(() => void service.kill("SIGKILL"));
		const status = async () => (await (await fetch(`http://127.0.0.1:${healthPort}/status`)).json()) as any;
		await until("the service to report chat", async () => (await status()).chat?.mode === "model");
		assert.deepEqual((await status()).chat.instructors, ["agent/ts-author"]);

		const replies = async () => (((await domain.author.get("/v1/inbox?limit=200")).messages ?? []) as any[]).filter((m) => m.type === "chat.message" && m.labels?.[CHAT_REPLY_LABEL] === "true" && m.sender?.id === "agent/ts-worker");
		const text = (message: any): string => (typeof message.content?.data === "string" ? message.content.data : JSON.stringify(message.content?.data));
		const ask = await domain.author.post("/v1/messages", { recipients: [{ kind: "agent", id: "agent/ts-worker" }], content: { mediaType: "text/plain", data: "what is going on?" }, triggerMode: "directed" });
		const [answer] = await until("the answer", async () => ((await replies()).length >= 1 ? await replies() : undefined));
		assert.match(text(answer), /the model answered/);
		assert.equal(answer.replyTo, (ask as any).messageId);
		assert.equal((await status()).tokenPools.chat.used > 0, true);
		assert.equal((await status()).tokenPools.tasks.used, 0, "the question spent nothing of the task pool");

		await sleep(16_000); // the sender window
		await domain.author.post("/v1/messages", { recipients: [{ kind: "agent", id: "agent/ts-worker" }], conversationId: (ask as any).conversationId, content: { mediaType: "text/plain", data: "instruct: add feature.txt" }, triggerMode: "directed" });
		const both = await until("the instruction to be reported", async () => ((await replies()).length >= 2 ? await replies() : undefined));
		assert.match(both.map(text).join("\n"), /Done/);
		assert.match(both.map(text).join("\n"), /Attachments were not uploaded to the domain[\s\S]*chat-.*\.diff[\s\S]*\+from chat/, "the patch is in the reply: the domain has no task for a chat job, so nothing was uploaded");
		assert.ok(!both.map(text).join("\n").includes("task not found"));
		const jobs = (await status()).tokenPools;
		assert.ok(jobs.chat.used > 0);
	});

	it("lets the model queue the role's job from a plain message: it says what it queued, then the job runs and reports", async () => {
		const domain = await startDomain({ cardFile: join(here, "../../../adapters/pi/card.json") });
		cleanups.push(() => domain.stop());
		const { remote } = makeRemote();
		const dir = mkdtempSync(join(tmpdir(), "chat-e2e-"));
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
		const service = run(join(here, "fixtures/chat-main.ts"), {
			SOMEWORK_URL: domain.url,
			SOMEWORK_KEY_FILE: join(domain.dir, "worker.key.json"),
			PI_STATE_DIR: state,
			PI_PROVIDER: "faux",
			PI_FAUX_PLAN: JSON.stringify(['call:add_note:{"text":"hello"}', "final:I queued the note."]),
			SANDBOX_URL: `http://127.0.0.1:${sandboxPort}`,
			SANDBOX_TOKEN_FILE: tokenFile,
			SANDBOX_WORKSPACES: workspaces,
			HEALTH_PORT: String(healthPort),
			PI_CONCURRENCY: "1",
			SOMEWORK_LEASE_SECONDS: "5",
			CHAT_ALLOWED_SENDERS: "agent/ts-author",
			CHAT_INSTRUCTORS: "agent/ts-author",
			CHAT_BUSY_AFTER_SECONDS: "60",
			FIXTURE_REMOTE: remote,
			FIXTURE_JOB_TOOL: "1",
		});
		cleanups.push(() => void service.kill("SIGKILL"));
		const status = async () => (await (await fetch(`http://127.0.0.1:${healthPort}/status`)).json()) as any;
		await until("the service to report chat", async () => (await status()).chat?.mode === "model");
		const replies = async () => (((await domain.author.get("/v1/inbox?limit=200")).messages ?? []) as any[]).filter((m) => m.type === "chat.message" && m.labels?.[CHAT_REPLY_LABEL] === "true" && m.sender?.id === "agent/ts-worker");
		const text = (message: any): string => (typeof message.content?.data === "string" ? message.content.data : JSON.stringify(message.content?.data));
		await domain.author.post("/v1/messages", { recipients: [{ kind: "agent", id: "agent/ts-worker" }], content: { mediaType: "text/plain", data: "please add a note saying hello" }, triggerMode: "directed" });
		const said = await until("the queued job to be reported", async () => ((await replies()).length >= 2 ? await replies() : undefined), 60_000);
		const all = said.map(text);
		assert.ok(all.some((line) => /I queued the note/.test(line)), all.join("\n"));
		assert.ok(all.some((line) => /^\(1\/1\) /.test(line)), all.join("\n"));
	});
});

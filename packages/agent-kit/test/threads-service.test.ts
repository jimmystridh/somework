import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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

async function until<T>(what: string, read: () => Promise<T | undefined | false>, ms = 30_000): Promise<T> {
	const deadline = Date.now() + ms;
	for (;;) {
		const value = await read().catch(() => undefined);
		if (value) return value;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}\n${[...logs.values()].join("\n").slice(-3000)}`);
		await sleep(150);
	}
}

async function boot(plan: string[]) {
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

	it("starts a job from a tool call, answers at once, and posts the job's result to the conversation by itself", async () => {
		const world = await boot(["call:start_demo:{\"topic\":\"x\"}", "final:The demo is running."]);
		await world.say("please run the demo for x");
		const reply = await until("the reply and the result", async () => ((await world.texts()).filter((text) => text.includes("The demo is running.")).length >= 2 ? await world.texts() : undefined));
		assert.ok(reply.some((text) => text.includes("demo x")), "the job's result names the job");
		const status = (await (await fetch(`http://127.0.0.1:${world.healthPort}/status`)).json()) as any;
		assert.equal(status.chat.jobs, 0, "nothing is left running");
	});
});

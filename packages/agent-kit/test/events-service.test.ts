import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { sleep } from "@somework/sdk";
import { freePort, startDomain } from "../../../sdk/typescript/test/harness.ts";
import { HandlerStore } from "../src/events/store.ts";
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

const HANDLER = `// @topics task.*
export default async ({ event }) =>
	event.topic === "task.queued" ? { action: "notify", message: "queued " + JSON.stringify(event.data).slice(0, 120) } : { action: "drop", reason: "not interesting" };
`;

async function until<T>(what: string, read: () => Promise<T | undefined | false>, ms = 20_000): Promise<T> {
	const deadline = Date.now() + ms;
	for (;;) {
		const value = await read().catch(() => undefined);
		if (value) return value;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}\n${[...logs.values()].join("\n").slice(-2500)}`);
		await sleep(150);
	}
}

/** The real service process (a fixture role with events on), a real domain and a real sandbox daemon. The events are the domain's own task events. */
describe("events end to end (real domain, real sandbox, real service process)", () => {
	it("hands an event to the agent's handler, acts on its decision and obeys a control message", async () => {
		const domain = await startDomain({ cardFile: join(here, "../../../adapters/pi/card.json") });
		cleanups.push(() => domain.stop());
		const { remote } = makeRemote();
		const dir = mkdtempSync(join(tmpdir(), "events-e2e-"));
		const workspaces = join(dir, "workspaces");
		mkdirSync(workspaces);
		const state = join(dir, "state");
		mkdirSync(state);
		new HandlerStore(join(state, "handlers")).save("task-watch", HANDLER);
		const tokenFile = join(dir, "sandbox-token");
		writeFileSync(tokenFile, "s".repeat(48));
		const sandboxPort = await freePort();
		const sandbox = run(join(here, "../src/sandbox/main.ts"), { SANDBOX_TOKEN_FILE: tokenFile, SANDBOX_ROOT: workspaces, SANDBOX_PORT: String(sandboxPort), SANDBOX_HOST: "127.0.0.1" });
		cleanups.push(() => void sandbox.kill("SIGKILL"));
		await until("the sandbox", async () => (await fetch(`http://127.0.0.1:${sandboxPort}/healthz`)).ok);

		const healthPort = await freePort();
		const service = run(join(here, "fixtures/events-main.ts"), {
			SOMEWORK_URL: domain.url,
			SOMEWORK_KEY_FILE: join(domain.dir, "worker.key.json"),
			PI_STATE_DIR: state,
			PI_PROVIDER: "faux",
			PI_FAUX_PLAN: JSON.stringify(["final:ok"]),
			SANDBOX_URL: `http://127.0.0.1:${sandboxPort}`,
			SANDBOX_TOKEN_FILE: tokenFile,
			SANDBOX_WORKSPACES: workspaces,
			HEALTH_PORT: String(healthPort),
			PI_CONCURRENCY: "1",
			SOMEWORK_LEASE_SECONDS: "5",
			EVENTS_HANDLER_TIMEOUT_SECONDS: "10",
		});
		cleanups.push(() => void service.kill("SIGKILL"));
		const status = async () => (await (await fetch(`http://127.0.0.1:${healthPort}/status`)).json()) as any;
		await until("the service to report its handler", async () => (await status()).handlers?.[0]?.name === "task-watch");
		await sleep(600); // the first look at the feed fast-forwards past anything that already exists

		const worker = domain.worker();
		await worker.post("/v1/subscriptions", { kind: "topic", selector: "task.*", wakeOnMatch: true });
		const task = await domain.author.submitTask({ capability: { id: "code.agent", version: "1" }, input: { repository: { url: remote, ref: "main" }, instruction: "do nothing", budget: { maxTokens: 100_000, maxMinutes: 2 } } });
		assert.ok(task.taskId);
		// no agent claims a task any more, so the task's own events come from the requester cancelling it
		await domain.author.cancelTask(task.taskId, "not needed");

		const ran = await until("the handler to run on task events", async () => {
			const current = await status();
			return current.handlers[0].runs >= 2 && current.handlers[0].drops >= 1 ? current : undefined;
		});
		assert.equal(ran.handlers[0].enabled, true);
		assert.equal(ran.handlers[0].errors, 0, JSON.stringify(ran.handlers[0]));
		assert.ok(ran.events.dropped.some((sample: any) => sample.reason === "not interesting"), "drops are sampled");
		assert.deepEqual(Object.keys(ran.tokenPools), ["tasks", "events", "chat"]);
		assert.equal(ran.tokenPools.events.limit, 3_000_000);

		const inbox = await until("the owner's notice", async () => {
			const response = JSON.stringify(await domain.author.get("/v1/inbox?unread=true&limit=50"));
			return response.includes("queued") && response.includes("chat.notice") ? response : undefined;
		});
		assert.match(inbox, /task\.queued|queued/);

		// the kill switch: a control message from the controller switches every handler off
		await domain.author.post("/v1/messages", { recipients: [{ kind: "agent", id: "agent/ts-worker" }], content: { mediaType: "text/plain", data: "switch off" }, triggerMode: "directed", labels: { eventControl: "disable-all", eventReason: "maintenance" } });
		const off = await until("the handlers to be switched off", async () => ((await status()).handlers[0].enabled === false ? await status() : undefined));
		assert.equal(off.handlers[0].disabledReason, "maintenance");
		const noNotice = JSON.stringify(await domain.author.get("/v1/inbox?unread=true&limit=50"));
		assert.ok(!noNotice.includes("I take tasks, not chat"), "a control message gets no chat notice");
	});
});

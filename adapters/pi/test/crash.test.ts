import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { sleep } from "@somework/sdk";
import { freePort, startDomain } from "../../../sdk/typescript/test/harness.ts";
import { makeRemote, sh } from "./fakes.ts";

const here = new URL(".", import.meta.url).pathname;
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const logs = new Map<ChildProcess, string>();
const run = (script: string, env: Record<string, string>): ChildProcess => {
	const child = spawn("node", [join(here, "..", script)], { env: { PATH: process.env.PATH!, HOME: process.env.HOME!, ...env }, stdio: ["ignore", "ignore", "pipe"] });
	logs.set(child, "");
	child.stderr!.on("data", (d) => logs.set(child, logs.get(child)! + d));
	return child;
};
const exited = (child: ChildProcess) => new Promise<number | null>((resolve) => (child.exitCode !== null ? resolve(child.exitCode) : child.once("exit", (code) => resolve(code))));

/** A real domain, a real sandbox daemon and the real service as separate processes, driven by the credential-free faux model. */
async function world(plan: string[]) {
	const domain = await startDomain({ cardFile: join(here, "../card.json") });
	cleanups.push(() => domain.stop());
	const { remote } = makeRemote();
	const dir = mkdtempSync(join(tmpdir(), "pi-crash-"));
	const workspaces = join(dir, "workspaces");
	mkdirSync(workspaces);
	const state = join(dir, "state");
	mkdirSync(state);
	const tokenFile = join(dir, "sandbox-token");
	writeFileSync(tokenFile, "s".repeat(48));
	const sandboxPort = await freePort();
	const sandbox = run("src/sandbox/main.ts", { SANDBOX_TOKEN_FILE: tokenFile, SANDBOX_ROOT: workspaces, SANDBOX_PORT: String(sandboxPort), SANDBOX_HOST: "127.0.0.1" });
	cleanups.push(() => void sandbox.kill("SIGKILL"));
	for (let i = 0; i < 100; i++) {
		try {
			if ((await fetch(`http://127.0.0.1:${sandboxPort}/healthz`)).ok) break;
		} catch {
			await sleep(100);
		}
	}
	const healthPort = await freePort();
	const startService = () => {
		const service = run("src/main.ts", {
			SOMEWORK_URL: domain.url,
			SOMEWORK_KEY_FILE: join(domain.dir, "worker.key.json"),
			PI_STATE_DIR: state,
			PI_PROVIDER: "faux",
			PI_FAUX_PLAN: JSON.stringify(plan),
			SANDBOX_URL: `http://127.0.0.1:${sandboxPort}`,
			SANDBOX_TOKEN_FILE: tokenFile,
			SANDBOX_WORKSPACES: workspaces,
			HEALTH_PORT: String(healthPort),
			PI_CONCURRENCY: "1",
			SOMEWORK_LEASE_SECONDS: "3",
		});
		cleanups.push(() => void service.kill("SIGKILL"));
		return service;
	};
	const submit = async () =>
		(await domain.author.submitTask({ capability: { id: "code.agent", version: "1" }, input: { repository: { url: remote, ref: "main" }, instruction: "change things", budget: { maxTokens: 1_000_000, maxMinutes: 5 } } })).taskId as string;
	const waitRunning = async (taskId: string) => {
		for (let i = 0; i < 200 && (await domain.author.getTask(taskId)).state !== "running"; i++) await sleep(100);
	};
	return { domain, remote, healthPort, startService, submit, waitRunning, workspaces };
}

describe("crash matrix (separate processes, kill -9)", () => {
	it("service killed during a tool call: the restarted service resumes the run and the task completes with one commit", async () => {
		const w = await world(["bash:sleep 4", "write:after-crash.txt:resumed", "final:finished after the crash"]);
		const first = w.startService();
		const taskId = await w.submit();
		await w.waitRunning(taskId);
		await sleep(1500); // inside `sleep 4`
		first.kill("SIGKILL");
		await exited(first);
		assert.notEqual((await w.domain.author.getTask(taskId)).state, "succeeded");

		w.startService();
		const task = await w.domain.author.waitTerminal(taskId, 60_000);
		assert.equal(task.state, "succeeded", `${JSON.stringify(task.failure)}\n${[...logs.values()].join("\n").slice(-1500)}`);
		assert.equal(task.attempt, 2);
		assert.equal(task.result.commits.length, 1);
		assert.equal(task.result.summary, "finished after the crash");
		assert.match(sh(w.remote, "show", `refs/heads/agent/${taskId}:after-crash.txt`), /resumed/);
		assert.equal(sh(w.remote, "rev-list", "--count", `main..agent/${taskId}`).trim(), "1");
	});

	it("repeated crashes still produce a single branch with a single commit", async () => {
		const w = await world(["bash:sleep 3", "write:twice.txt:x", "final:ok"]);
		const taskId = await w.submit();
		for (let round = 0; round < 2; round++) {
			const service = w.startService();
			await w.waitRunning(taskId);
			await sleep(1200);
			service.kill("SIGKILL");
			await exited(service);
		}
		w.startService();
		const task = await w.domain.author.waitTerminal(taskId, 90_000);
		assert.equal(task.state, "succeeded", JSON.stringify(task.failure));
		assert.equal(task.result.commits.length, 1);
		assert.equal(sh(w.remote, "rev-list", "--count", `main..agent/${taskId}`).trim(), "1");
	});

	it("SIGTERM (docker stop) exits cleanly and the run is picked up by the next start", async () => {
		const w = await world(["bash:sleep 3", "write:graceful.txt:y", "final:ok"]);
		const first = w.startService();
		const taskId = await w.submit();
		await w.waitRunning(taskId);
		await sleep(1000);
		first.kill("SIGTERM");
		assert.equal(await exited(first), 0, "a clean exit on SIGTERM");
		w.startService();
		const task = await w.domain.author.waitTerminal(taskId, 60_000);
		assert.equal(task.state, "succeeded", JSON.stringify(task.failure));
		assert.equal(task.result.commits.length, 1);
	});

	it("SIGTERM with a long tool call in flight exits at once instead of waiting for the tool", async () => {
		const w = await world(["bash:sleep 30", "final:ok"]);
		const service = w.startService();
		const taskId = await w.submit();
		await w.waitRunning(taskId);
		await sleep(1500);
		const started = Date.now();
		service.kill("SIGTERM");
		assert.equal(await exited(service), 0);
		assert.ok(Date.now() - started < 3000, `stopped in ${Date.now() - started} ms, not after the 30 s tool`);
	});

	it("readiness and metrics are served while it works", async () => {
		const w = await world(["final:ok"]);
		w.startService();
		let ready = false;
		for (let i = 0; i < 100 && !ready; i++) {
			await sleep(150);
			ready = await fetch(`http://127.0.0.1:${w.healthPort}/ready`).then((r) => r.ok).catch(() => false);
		}
		assert.ok(ready, "/ready becomes 200 once the storage is open and the sandbox is reachable");
		assert.equal((await fetch(`http://127.0.0.1:${w.healthPort}/live`)).status, 200);
		assert.match(await (await fetch(`http://127.0.0.1:${w.healthPort}/metrics`)).text(), /somework_pi_active_jobs/);
		assert.ok(existsSync(w.workspaces));
	});
});

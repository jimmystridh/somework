import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { sleep } from "@somework/sdk";
import { freePort, startDomain } from "../../../sdk/typescript/test/harness.ts";
import { makeRemote, sh } from "@somework/agent-kit/testing";

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

const REPOSITORY = "https://example.test/o/r";

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
	// the job tool takes https repositories only: the sandbox's git (its home is the workspace root) sends that address to the local bare repository
	writeFileSync(join(workspaces, ".gitconfig"), `[url "${remote}"]\n\tinsteadOf = ${REPOSITORY}\n[user]\n\tname = t\n\temail = t@t\n`);
	const sandboxPort = await freePort();
	const sandbox = run("../../packages/agent-kit/src/sandbox/main.ts", { SANDBOX_TOKEN_FILE: tokenFile, SANDBOX_ROOT: workspaces, SANDBOX_PORT: String(sandboxPort), SANDBOX_HOST: "127.0.0.1" });
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
			CHAT_REPOSITORY_URL: REPOSITORY,
			CHAT_REPOSITORY_REF: "main",
		});
		cleanups.push(() => void service.kill("SIGKILL"));
		return service;
	};
	const status = async (): Promise<any> => (await fetch(`http://127.0.0.1:${healthPort}/status`)).json();
	/** Asks the agent for a change in a message; the model's plan starts with the job tool, which starts the job. */
	const ask = () => domain.author.post("/v1/messages", { recipients: [{ kind: "agent", id: "agent/ts-worker" }], content: { mediaType: "text/plain", data: "please change things" }, triggerMode: "directed" });
	/** A service that has never run baselines the domain's inbox when it starts: what is asked must be asked after that. */
	const ready = async () => {
		for (let i = 0; i < 200 && !(await fetch(`http://127.0.0.1:${healthPort}/ready`).then((r) => r.ok).catch(() => false)); i++) await sleep(150);
		await sleep(500);
	};
	const waitRunning = async () => {
		for (let i = 0; i < 300 && ((await status().catch(() => ({}))).chat?.jobs ?? 0) < 1; i++) await sleep(100);
	};
	const results = async (): Promise<string[]> => {
		const messages: any[] = ((await domain.author.get("/v1/inbox?limit=200")) as any).messages ?? [];
		return messages.filter((message) => message.labels?.jobId).map((message) => String(message.content?.data ?? ""));
	};
	const branches = (): string[] => sh(remote, "for-each-ref", "--format=%(refname:short)", "refs/heads/agent/").split("\n").filter(Boolean);
	return { domain, remote, healthPort, startService, ready, ask, waitRunning, results, branches, status, workspaces };
}

const START = 'call:code_agent:{"instruction":"change things"}';

async function finished(w: Awaited<ReturnType<typeof world>>, ms = 60_000): Promise<string> {
	const deadline = Date.now() + ms;
	for (;;) {
		const found = (await w.results().catch(() => [])).find((text) => /: done|I could not/.test(text));
		if (found) return found;
		if (Date.now() > deadline) throw new Error(`no job result\n${[...logs.values()].join("\n").slice(-2500)}`);
		await sleep(200);
	}
}

describe("crash matrix (separate processes, kill -9)", () => {
	it("service killed during a tool call: the restarted service resumes the job and it completes with one commit", async () => {
		const w = await world([START, "bash:sleep 4", "write:after-crash.txt:resumed", "final:finished after the crash"]);
		const first = w.startService();
		await w.ready();
		await w.ask();
		await w.waitRunning();
		await sleep(1500); // inside `sleep 4`
		first.kill("SIGKILL");
		await exited(first);
		assert.deepEqual(await w.results(), [], "nothing was reported yet");

		w.startService();
		const result = await finished(w);
		assert.match(result, /: done \(completed\)/, result);
		assert.match(result, /finished after the crash/);
		const [branch] = w.branches();
		assert.match(branch!, /^agent\/job-/);
		assert.match(sh(w.remote, "show", `refs/heads/${branch}:after-crash.txt`), /resumed/);
		assert.equal(sh(w.remote, "rev-list", "--count", `main..${branch}`).trim(), "1");
	});

	it("repeated crashes still produce a single branch with a single commit", async () => {
		const w = await world([START, "bash:sleep 3", "write:twice.txt:x", "final:ok"]);
		for (let round = 0; round < 2; round++) {
			const service = w.startService();
			await w.ready();
			if (round === 0) await w.ask();
			await w.waitRunning();
			await sleep(1200);
			service.kill("SIGKILL");
			await exited(service);
		}
		w.startService();
		assert.match(await finished(w, 90_000), /: done \(completed\)/);
		assert.equal(w.branches().length, 1);
		assert.equal(sh(w.remote, "rev-list", "--count", `main..${w.branches()[0]}`).trim(), "1");
	});

	it("SIGTERM (docker stop) exits cleanly and the job is picked up by the next start", async () => {
		const w = await world([START, "bash:sleep 3", "write:graceful.txt:y", "final:ok"]);
		const first = w.startService();
		await w.ready();
		await w.ask();
		await w.waitRunning();
		await sleep(1000);
		first.kill("SIGTERM");
		assert.equal(await exited(first), 0, "a clean exit on SIGTERM");
		w.startService();
		assert.match(await finished(w), /: done \(completed\)/);
		assert.equal(sh(w.remote, "rev-list", "--count", `main..${w.branches()[0]}`).trim(), "1");
	});

	it("SIGTERM with a long tool call in flight exits at once instead of waiting for the tool", async () => {
		const w = await world(["bash:sleep 30", "final:ok"]);
		const service = w.startService();
		await w.ready();
		await w.ask();
		for (let i = 0; i < 300 && ((await w.status().catch(() => ({}))).chat?.conversations ?? 0) < 1; i++) await sleep(100);
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

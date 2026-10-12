import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { sleep } from "@somework/sdk";
import { freePort, startDomain } from "../../../sdk/typescript/test/harness.ts";

const here = new URL(".", import.meta.url).pathname;
const SECRET = "xq9-plain-literal-secret-0123456789";
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const run = (script: string, env: Record<string, string>, log: { text: string }): ChildProcess => {
	const child = spawn("node", [script], { env: { PATH: process.env.PATH!, HOME: process.env.HOME!, ...env }, stdio: ["ignore", "ignore", "pipe"] });
	child.stderr!.on("data", (chunk) => (log.text += chunk));
	cleanups.push(() => void child.kill("SIGKILL"));
	return child;
};

async function until<T>(what: string, log: { text: string }, read: () => Promise<T | undefined | false>, ms = 30_000): Promise<T> {
	const deadline = Date.now() + ms;
	for (;;) {
		const value = await read().catch(() => undefined);
		if (value) return value;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}\n${log.text.slice(-3000)}`);
		await sleep(150);
	}
}

async function boot(fixture: unknown[], extraEnv: Record<string, string> = {}) {
	const domain = await startDomain({ cardFile: join(here, "../../../adapters/pi/card.json") });
	cleanups.push(() => domain.stop());
	const dir = mkdtempSync(join(tmpdir(), "preflight-e2e-"));
	const workspaces = join(dir, "workspaces");
	mkdirSync(workspaces);
	const state = join(dir, "state");
	mkdirSync(state);
	const tokenFile = join(dir, "sandbox-token");
	writeFileSync(tokenFile, "s".repeat(48));
	const secretFile = join(dir, "secret-token");
	writeFileSync(secretFile, SECRET);
	const log = { text: "" };
	const sandboxPort = await freePort();
	run(join(here, "../src/sandbox/main.ts"), { SANDBOX_TOKEN_FILE: tokenFile, SANDBOX_ROOT: workspaces, SANDBOX_PORT: String(sandboxPort), SANDBOX_HOST: "127.0.0.1" }, log);
	await until("the sandbox", log, async () => (await fetch(`http://127.0.0.1:${sandboxPort}/healthz`)).ok);
	const healthPort = await freePort();
	run(
		join(here, "fixtures/preflight-main.ts"),
		{
			SOMEWORK_URL: domain.url,
			SOMEWORK_KEY_FILE: join(domain.dir, "worker.key.json"),
			PI_STATE_DIR: state,
			PI_PROVIDER: "faux",
			SANDBOX_URL: `http://127.0.0.1:${sandboxPort}`,
			SANDBOX_TOKEN_FILE: tokenFile,
			SANDBOX_WORKSPACES: workspaces,
			GIT_TOKEN_FILE: secretFile,
			HEALTH_PORT: String(healthPort),
			PREFLIGHT_FIXTURE: JSON.stringify(fixture),
			...extraEnv,
		},
		log,
	);
	const base = `http://127.0.0.1:${healthPort}`;
	await until("the first preflight run", log, async () => (((await (await fetch(`${base}/ready`)).json()) as any).preflight ?? []).length > 0);
	return { base, log };
}

describe("a role's preflight in the running service (real domain, real sandbox, real service process)", () => {
	it("reports a failed warning in /ready, /profile and /metrics, logs it once, and stays ready", async () => {
		const world = await boot([
			{ name: "github-pull-requests", ok: false, severity: "warning", detail: "the token lacks Pull requests: read; GitHub said no to $TOKEN" },
			{ name: "jira", ok: true, severity: "error" },
		]);
		const ready = await fetch(`${world.base}/ready`);
		assert.equal(ready.status, 200);
		const body = (await ready.json()) as any;
		assert.equal(body.ready, true);
		assert.deepEqual(body.preflight.map((check: any) => [check.name, check.ok, check.severity]), [["github-pull-requests", false, "warning"], ["jira", true, "error"]]);
		assert.match(body.preflight[0].detail, /the token lacks Pull requests: read/);

		const profile = (await (await fetch(`${world.base}/profile`)).json()) as any;
		assert.equal(profile.preflight.everyMinutes, 15);
		assert.deepEqual(profile.preflight.checks.map((check: any) => check.name), ["github-pull-requests", "jira"]);

		const metrics = await (await fetch(`${world.base}/metrics`)).text();
		assert.match(metrics, /somework_preflight_ok\{agent="[^"]+",check="github-pull-requests"\} 0/);
		assert.match(metrics, /somework_preflight_ok\{agent="[^"]+",check="jira"\} 1/);

		await until("the service to log its start", world.log, async () => /service_started/.test(world.log.text));
		assert.equal(world.log.text.match(/"event":"preflight_failed"/g)?.length, 1);
		assert.match(world.log.text, /"level":"warn","event":"preflight_failed","check":"github-pull-requests"/);
		for (const text of [world.log.text, JSON.stringify(body), JSON.stringify(profile), metrics]) assert.ok(!text.includes("plain-literal-secret"), "no secret anywhere");
	});

	it("a failed error check is only a warning of the agent unless the role marks it blocking", async () => {
		const plain = await boot([{ name: "token", ok: false, severity: "error", detail: "expired" }]);
		assert.equal((await fetch(`${plain.base}/ready`)).status, 200);
		const blocking = await boot([{ name: "token", ok: false, severity: "error", blocking: true, detail: "expired" }]);
		const response = await fetch(`${blocking.base}/ready`);
		assert.equal(response.status, 503);
		assert.deepEqual(((await response.json()) as any).failed, ["preflight: token"]);
	});

	it("PREFLIGHT_MINUTES=0 still runs the checks once, at start", async () => {
		const world = await boot([{ name: "jira", ok: true, severity: "error" }], { PREFLIGHT_MINUTES: "0" });
		const profile = (await (await fetch(`${world.base}/profile`)).json()) as any;
		assert.equal(profile.preflight.everyMinutes, 0);
		assert.equal(profile.preflight.checks.length, 1);
	});
});

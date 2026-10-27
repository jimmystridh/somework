import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ConfinedExecutionEnv } from "@somework/agent-kit/windows";
import { AppProfilesError, AppRunner, loadAppProfiles, parseAppProfiles, type AppProfile } from "../src/app.ts";
import { freePort } from "../../../sdk/typescript/test/harness.ts";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "qa-app-")));
const root = join(dir, "ws");
mkdirSync(root, { recursive: true });
const env = () => new ConfinedExecutionEnv({ root, baseEnv: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root }, flavour: "posix" });

const profile = (over: Partial<AppProfile> = {}): AppProfile => ({ start: "true", health: ["http://127.0.0.1:1/"], env: {}, startupTimeoutSeconds: 5, prepareTimeoutSeconds: 60, ...over });

describe("application profiles", () => {
	const ok = { app: { default: { start: "nohup node server.js > .qa-app.log 2>&1 < /dev/null &", health: ["http://127.0.0.1:3000/health"], stop: "echo stop", env: { MODE: "local" }, startupTimeoutSeconds: 60, backendRevisionCommand: "echo abc123", cwd: "web" } } };

	it("accepts a sound file", () => {
		const parsed = parseAppProfiles(ok);
		assert.equal(parsed.default!.health[0], "http://127.0.0.1:3000/health");
		assert.equal(parsed.default!.cwd, "web");
		assert.deepEqual(parseAppProfiles({}), {});
	});

	it("takes a preparation command with its own, longer timeout", () => {
		const parsed = parseAppProfiles({ app: { default: { ...ok.app.default, prepare: "build.sh", prepareTimeoutSeconds: 7200 } } }).default!;
		assert.equal(parsed.prepare, "build.sh");
		assert.equal(parsed.prepareTimeoutSeconds, 7200);
		assert.equal(parseAppProfiles(ok).default!.prepareTimeoutSeconds, 3600);
		assert.equal(parseAppProfiles(ok).default!.prepare, undefined);
	});

	it("refuses typos, other sections, non-loopback health URLs, credentials in env and escaping directories", () => {
		const bad: [unknown, RegExp][] = [
			[{ apps: {} }, /unknown section/],
			[{ app: { Default: ok.app.default } }, /valid profile name/],
			[{ app: { default: { ...ok.app.default, strt: "x" } } }, /unknown setting/],
			[{ app: { default: { ...ok.app.default, health: ["https://example.com/"] } } }, /on this machine/],
			[{ app: { default: { ...ok.app.default, health: [] } } }, /one to eight/],
			[{ app: { default: { ...ok.app.default, health: ["file:///etc/passwd"] } } }, /http or https/],
			[{ app: { default: { ...ok.app.default, start: "" } } }, /non-empty command/],
			[{ app: { default: { ...ok.app.default, env: { API_TOKEN: "x" } } } }, /looks like a credential/],
			[{ app: { default: { ...ok.app.default, cwd: "../x" } } }, /relative path/],
			[{ app: { default: { ...ok.app.default, startupTimeoutSeconds: 1 } } }, /startupTimeoutSeconds/],
			[{ app: { default: { ...ok.app.default, prepare: "build", prepareTimeoutSeconds: 10 } } }, /prepareTimeoutSeconds must be/],
			[{ app: { default: { ...ok.app.default, prepare: "build", prepareTimeoutSeconds: 99999 } } }, /prepareTimeoutSeconds must be/],
			[{ app: { default: { ...ok.app.default, prepareTimeoutSeconds: 600 } } }, /needs a prepare command/],
		];
		for (const [value, message] of bad) assert.throws(() => parseAppProfiles(value), (error) => error instanceof AppProfilesError && message.test(error.message), JSON.stringify(value).slice(0, 80));
	});

	it("loads from a file and names the file in a parse error", () => {
		assert.deepEqual(loadAppProfiles(undefined), {});
		assert.equal(loadAppProfiles("/p.json", () => JSON.stringify(ok)).default!.start.startsWith("nohup"), true);
		assert.throws(() => loadAppProfiles("/p.json", () => "{nope"), /\/p\.json/);
	});
});

/** A tiny application in the temp directory: answers /health with 200 and everything else with a page. */
const serverScript = join(dir, "server.mjs");
writeFileSync(serverScript, `import { createServer } from "node:http"; createServer((q, r) => { r.statusCode = q.url === "/broken" ? 500 : 200; r.end("<h1>app</h1>"); }).listen(Number(process.argv[2]), "127.0.0.1");\n`);

describe("starting and stopping the application", () => {
	it("starts it in the background, waits until it is healthy, and stops it with the stop command", async () => {
		const port = await freePort();
		const runner = new AppRunner({ env: env(), pollMs: 50 });
		const app = profile({ start: `nohup node ${serverScript} ${port} > app.log 2>&1 < /dev/null & echo $! > app.pid`, health: [`http://127.0.0.1:${port}/`], stop: "kill $(cat app.pid)", backendRevisionCommand: "echo r42 extra" });
		const started = await runner.start(app, root);
		assert.ok(started.ok, JSON.stringify(started));
		assert.equal(started.backendRevision, "r42 extra");
		assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 200);
		const stopped = await runner.stop(app, root, started.startedAtMs);
		assert.deepEqual(stopped, { stopCommand: true, swept: 0 });
		await new Promise((resolve) => setTimeout(resolve, 200));
		await assert.rejects(() => fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) }));
	});

	it("reports a start command that fails, with its output and without secrets", async () => {
		const runner = new AppRunner({ env: env(), secrets: ["hunter2hunter2"] });
		const result = await runner.start(profile({ start: "echo boot error with hunter2hunter2 >&2; exit 3" }), root);
		assert.equal(result.ok, false);
		assert.match((result as any).reason, /exit 3/);
		assert.match((result as any).reason, /boot error/);
		assert.doesNotMatch((result as any).reason, /hunter2/);
	});

	it("runs the preparation command to its end before the start command, and does not start when it fails", async () => {
		const runner = new AppRunner({ env: env(), secrets: ["hunter2hunter2"], pollMs: 50 });
		const port = await freePort();
		const order = join(root, "order.txt");
		const app = profile({ prepare: `echo prepare >> ${order}; sleep 1; echo built >> ${order}`, start: `echo start >> ${order}; nohup node ${serverScript} ${port} > app3.log 2>&1 < /dev/null & echo $! > app3.pid`, health: [`http://127.0.0.1:${port}/`], stop: "kill $(cat app3.pid)", startupTimeoutSeconds: 15 });
		assert.equal((await runner.start(app, root)).ok, true);
		await runner.stop(app, root, Date.now());
		assert.equal(readFileSync(order, "utf8"), "prepare\nbuilt\nstart\n");

		const failing = await runner.start(profile({ prepare: `echo compile error with hunter2hunter2 >&2; exit 2`, start: `echo started >> ${order}` }), root);
		assert.equal(failing.ok, false);
		assert.match((failing as any).reason, /preparation command failed \(exit 2\)/);
		assert.match((failing as any).reason, /compile error/);
		assert.doesNotMatch((failing as any).reason, /hunter2/);
		assert.doesNotMatch(readFileSync(order, "utf8"), /started/);
	});

	it("gives up when the application never becomes healthy, and when a health URL answers 5xx", async () => {
		const port = await freePort();
		const runner = new AppRunner({ env: env(), pollMs: 50 });
		const never = await runner.start(profile({ start: "true", health: [`http://127.0.0.1:${port}/`], startupTimeoutSeconds: 5 }), root, undefined);
		assert.equal(never.ok, false);
		assert.match((never as any).reason, /did not become healthy within 5 s/);
		const sick = await freePort();
		const app = profile({ start: `nohup node ${serverScript} ${sick} > app2.log 2>&1 < /dev/null & echo $! > app2.pid`, health: [`http://127.0.0.1:${sick}/broken`], stop: "kill $(cat app2.pid)", startupTimeoutSeconds: 5 });
		assert.equal((await runner.start(app, root)).ok, false);
		await runner.stop(app, root, Date.now());
	});

	it("stops waiting when the job is stopped", async () => {
		const port = await freePort();
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 300);
		const result = await new AppRunner({ env: env(), pollMs: 50 }).start(profile({ health: [`http://127.0.0.1:${port}/`], startupTimeoutSeconds: 60 }), root, controller.signal);
		assert.equal(result.ok, false);
		assert.match((result as any).reason, /stopped while waiting/);
	});

	it("stopping never throws, and asks the environment to sweep what the application left", async () => {
		const swept: number[] = [];
		const runner = new AppRunner({ env: { exec: async () => { throw new Error("boom"); }, sweepSince: async (since) => (swept.push(since), 4) } });
		assert.deepEqual(await runner.stop(profile({ stop: "x" }), root, 10_000), { stopCommand: false, swept: 4 });
		assert.deepEqual(swept, [9000]);
		const failing = new AppRunner({ env: { exec: async () => { throw new Error("boom"); }, sweepSince: async () => { throw new Error("no"); } } });
		assert.deepEqual(await failing.stop(undefined, root, 1), { swept: 0 });
	});

	it("the health check is a plain fetch (not following redirects off the machine)", async () => {
		const server = createServer((_req, res) => { res.statusCode = 302; res.setHeader("location", "http://example.invalid/"); res.end(); });
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const port = (server.address() as { port: number }).port;
		try {
			const result = await new AppRunner({ env: env(), pollMs: 50 }).start(profile({ health: [`http://127.0.0.1:${port}/`], startupTimeoutSeconds: 5 }), root);
			assert.ok(result.ok, "a redirect is an answer below 500");
		} finally {
			server.close();
		}
	});
});

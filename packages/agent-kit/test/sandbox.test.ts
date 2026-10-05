import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { RemoteExecutionEnv } from "../src/sandbox/remote-env.ts";
import { createSandboxServer } from "../src/sandbox/server.ts";

const TOKEN = "t".repeat(40);
const ctx = BACKGROUND_CONTEXT;
let root: string;
let url: string;
let server: ReturnType<typeof createSandboxServer>;
let remote: RemoteExecutionEnv;
let local: NodeExecutionEnv;

before(async () => {
	root = mkdtempSync(join(tmpdir(), "sandbox-"));
	server = createSandboxServer({ token: TOKEN, root });
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	remote = new RemoteExecutionEnv({ baseUrl: url, token: TOKEN, cwd: root, id: "sandbox:test" });
	local = new NodeExecutionEnv({ cwd: root });
});
after(() => {
	server.close();
});

const value = <T>(result: { ok: boolean; value?: T; error?: unknown }): T => {
	assert.ok(result.ok, `expected ok, got ${JSON.stringify(result.error)}`);
	return result.value as T;
};

describe("remote ExecutionEnv", () => {
	it("round-trips text and binary files and lists directories", async () => {
		value(await remote.createDir("a/b", { recursive: true }, ctx));
		value(await remote.writeFile("a/b/hello.txt", "héllo\nworld\n", ctx));
		assert.equal(value(await remote.readTextFile("a/b/hello.txt", ctx)), "héllo\nworld\n");
		value(await remote.appendFile("a/b/hello.txt", "more\n", ctx));
		assert.deepEqual(value(await remote.readTextLines("a/b/hello.txt", { maxLines: 2 }, ctx)), ["héllo", "world"]);
		const bytes = new Uint8Array([0, 255, 1, 128]);
		value(await remote.writeFile("bin.dat", bytes, ctx));
		assert.deepEqual([...value(await remote.readBinaryFile("bin.dat", ctx))], [0, 255, 1, 128]);
		assert.deepEqual(value(await remote.listDir("a/b", ctx)).map((f: { name: string }) => f.name), ["hello.txt"]);
		assert.equal(value(await remote.fileInfo("a/b/hello.txt", ctx)).kind, "file");
		assert.equal(value(await remote.exists("nope", ctx)), false);
		const reader = value(await remote.openTextLineReader("a/b/hello.txt", ctx));
		assert.deepEqual(value(await reader.readLine(ctx)), { text: "héllo", terminated: true });
	});

	it("maps failures to the same error codes as the local environment", async () => {
		const [fromRemote, fromLocal] = [await remote.readTextFile("missing.txt", ctx), await local.readTextFile("missing.txt", ctx)];
		assert.ok(!fromRemote.ok && !fromLocal.ok);
		assert.equal(fromRemote.error.code, "not_found");
		assert.equal(fromRemote.error.code, fromLocal.error.code);
		const dir = await remote.readTextFile("a", ctx);
		assert.ok(!dir.ok);
		assert.equal(dir.error.code, (await local.readTextFile("a", ctx)).ok ? "?" : "is_directory");
	});

	it("runs commands with streamed output and an exit code", async () => {
		const out: string[] = [];
		const result = value(await remote.exec("echo one; echo two >&2; exit 3", { onOutput: (text) => out.push(text) }, ctx));
		assert.equal(result.exitCode, 3);
		assert.match(out.join(""), /one/);
		assert.match(out.join(""), /two/);
	});

	it("runs a command in the directory the call names, not the environment's default", async () => {
		value(await remote.createDir("elsewhere", { recursive: true }, ctx));
		const out: string[] = [];
		await remote.exec("pwd", { cwd: join(root, "elsewhere"), onOutput: (text) => out.push(text) }, ctx);
		assert.equal(out.join("").trim(), realpathSync(join(root, "elsewhere")));
		const dflt: string[] = [];
		await remote.exec("pwd", { onOutput: (text) => dflt.push(text) }, ctx);
		assert.equal(dflt.join("").trim(), realpathSync(root));
	});

	it("does not inherit the daemon's environment, and passes only what a call names", async () => {
		process.env.DAEMON_SECRET = "hunter2";
		const out: string[] = [];
		await remote.exec('echo "[$DAEMON_SECRET][$CALL_ONLY]"', { env: { CALL_ONLY: "visible" }, onOutput: (text) => out.push(text) }, ctx);
		assert.equal(out.join("").trim(), "[][visible]");
		delete process.env.DAEMON_SECRET;
	});

	it("honours a command timeout (seconds)", async () => {
		const result = await remote.exec("sleep 30", { timeout: 0.5 }, ctx);
		assert.ok(!result.ok);
		assert.equal(result.error.code, "timeout");
	});

	it("kills the command's whole process tree when the call is cancelled", async () => {
		const pidFile = join(root, "tree.pid");
		const { context, cancel } = withCancel(ctx);
		const started = Date.now();
		const running = remote.exec(`(sleep 60 & echo $! > ${pidFile}; wait)`, undefined, context);
		for (let i = 0; i < 50 && !(await remote.exists("tree.pid", ctx)).ok; i++) await new Promise((r) => setTimeout(r, 50));
		while (!readFileSyncSafe(pidFile)) await new Promise((r) => setTimeout(r, 50));
		const pid = Number(readFileSyncSafe(pidFile));
		cancel("test");
		const result = await running;
		assert.ok(!result.ok && result.error.code === "aborted");
		assert.ok(Date.now() - started < 5000, "cancel returned promptly");
		for (let i = 0; i < 40 && alive(pid); i++) await new Promise((r) => setTimeout(r, 50));
		assert.equal(alive(pid), false, "the sleeping child was killed with the command");
	});

	it("rejects calls without the harness token", async () => {
		const stranger = new RemoteExecutionEnv({ baseUrl: url, token: "x".repeat(40), cwd: root, id: "sandbox:test" });
		const read = await stranger.readTextFile("a/b/hello.txt", ctx);
		assert.ok(!read.ok);
		const exec = await stranger.exec("echo hi", undefined, ctx);
		assert.ok(!exec.ok);
	});

	it("reports an unreachable sandbox as an error result, not an exception", async () => {
		const gone = new RemoteExecutionEnv({ baseUrl: "http://127.0.0.1:1", token: TOKEN, cwd: root, id: "sandbox:gone" });
		assert.ok(!(await gone.readTextFile("x", ctx)).ok);
		assert.ok(!(await gone.exec("true", undefined, ctx)).ok);
	});
});

function readFileSyncSafe(path: string): string {
	try {
		return readFileSync(path, "utf8").trim();
	} catch {
		return "";
	}
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

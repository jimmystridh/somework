import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context";
import { ConfinedExecutionEnv } from "../src/windows/local-env.ts";

const ctx = BACKGROUND_CONTEXT;
const hostTmp = tmpdir();
const dir = realpathSync(mkdtempSync(join(tmpdir(), "windev-env-")));
const root = join(dir, "ws");
const outside = join(dir, "outside");
const baseEnv = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root, KEPT: "from-base-env" };
const make = (extra: Partial<ConstructorParameters<typeof ConfinedExecutionEnv>[0]> = {}) => new ConfinedExecutionEnv({ root, baseEnv, flavour: "posix", ...extra });

before(() => {
	mkdirSync(join(root, "sub"), { recursive: true });
	mkdirSync(outside, { recursive: true });
	writeFileSync(join(root, "in.txt"), "inside");
	writeFileSync(join(outside, "secret.txt"), "outside");
	symlinkSync(outside, join(root, "link-out"));
	symlinkSync(join(outside, "secret.txt"), join(root, "file-link-out"));
	symlinkSync(join(root, "sub"), join(root, "link-in"));
});
after(() => {});

describe("file access is confined to the workspace root", () => {
	it("reads, writes, lists and renames inside", async () => {
		const env = make();
		assert.deepEqual(await env.readTextFile("in.txt", ctx), { ok: true, value: "inside" });
		assert.equal((await env.writeFile("sub/new.txt", "x", ctx)).ok, true);
		assert.equal(readFileSync(join(root, "sub/new.txt"), "utf8"), "x");
		assert.equal((await env.renameFile("sub/new.txt", "sub/renamed.txt", ctx)).ok, true);
		const listing = await env.listDir("sub", ctx);
		assert.ok(listing.ok && listing.value.some((entry) => entry.name === "renamed.txt"));
		assert.equal((await env.exists("in.txt", ctx)).ok, true);
		assert.equal((await env.createDir("deep/er", { recursive: true }, ctx)).ok, true);
		assert.equal((await env.readTextFile("link-in/renamed.txt", ctx)).ok, true, "a link that stays inside is fine");
	});

	it("refuses paths that name something outside", async () => {
		const env = make();
		for (const path of ["../outside/secret.txt", `${outside}/secret.txt`, "sub/../../outside/secret.txt", "~/x", "file:///etc/passwd"]) {
			const result = await env.readTextFile(path, ctx);
			assert.equal(result.ok, false, path);
			if (!result.ok) assert.equal(result.error.code, "permission_denied", path);
		}
	});

	it("refuses links that lead outside, for reading, writing, listing and creating below them", async () => {
		const env = make();
		assert.equal((await env.readTextFile("link-out/secret.txt", ctx)).ok, false);
		assert.equal((await env.readTextFile("file-link-out", ctx)).ok, false);
		assert.equal((await env.writeFile("link-out/created.txt", "x", ctx)).ok, false);
		assert.equal(existsSync(join(outside, "created.txt")), false, "nothing was written through the link");
		assert.equal((await env.listDir("link-out", ctx)).ok, false);
		assert.equal((await env.createDir("link-out/newdir/deeper", { recursive: true }, ctx)).ok, false);
		assert.equal(existsSync(join(outside, "newdir")), false);
		assert.equal((await env.renameFile("in.txt", "link-out/moved.txt", ctx)).ok, false);
		assert.equal(existsSync(join(outside, "moved.txt")), false);
	});

	it("never removes the root itself, and cannot remove outside it", async () => {
		const env = make();
		assert.equal((await env.remove(".", { recursive: true }, ctx)).ok, false);
		assert.equal((await env.remove(root, { recursive: true }, ctx)).ok, false);
		assert.equal((await env.remove("../outside/secret.txt", {}, ctx)).ok, false);
		assert.equal(existsSync(join(outside, "secret.txt")), true);
		assert.equal(existsSync(root), true);
	});

	it("resolves relative paths against its own working directory, which must be inside", async () => {
		const env = make({ cwd: join(root, "sub") });
		assert.deepEqual(await env.absolutePath("x.txt", ctx), { ok: true, value: join(root, "sub", "x.txt") });
		assert.throws(() => make({ cwd: outside }), /outside/);
	});

	it("only hands out temporary locations inside the root", async () => {
		const original = process.env.TMPDIR;
		try {
			process.env.TMPDIR = join(root, ".tmp");
			mkdirSync(join(root, ".tmp"), { recursive: true });
			const inside = await make().createTempDir("job-", ctx);
			assert.ok(inside.ok && inside.value.startsWith(join(root, ".tmp")), JSON.stringify(inside));
			process.env.TMPDIR = hostTmp;
			const away = await make().createTempFile({ prefix: "x" }, ctx);
			assert.equal(away.ok, false);
		} finally {
			if (original === undefined) delete process.env.TMPDIR;
			else process.env.TMPDIR = original;
		}
	});
});

describe("commands", () => {
	const run = async (env: ConfinedExecutionEnv, command: string, options: Record<string, unknown> = {}) => {
		let output = "";
		const result = await env.exec(command, { ...options, onOutput: (text: string) => void (output += text) }, ctx);
		return { result, output };
	};

	it("starts in the confined working directory and refuses one outside", async () => {
		const env = make();
		assert.equal((await run(env, "pwd")).output.trim(), root);
		assert.equal((await run(env, "pwd", { cwd: "sub" })).output.trim(), join(root, "sub"));
		const outsideRun = await run(env, "pwd", { cwd: outside });
		assert.equal(outsideRun.result.ok, false);
		assert.equal(outsideRun.output, "");
		assert.equal((await run(env, "pwd", { cwd: "link-out" })).result.ok, false, "a link to outside is not a working directory either");
	});

	it("gets exactly the base environment plus the call's own variables, never the service's", async () => {
		process.env.SERVICE_SECRET_FOR_TEST = "must-not-leak";
		try {
			const { output } = await run(make(), 'echo "secret=[$SERVICE_SECRET_FOR_TEST] kept=[$KEPT] extra=[$EXTRA]"', { env: { EXTRA: "call-var" } });
			assert.equal(output.trim(), "secret=[] kept=[from-base-env] extra=[call-var]");
			assert.ok(!(await run(make(), "env")).output.includes("must-not-leak"));
		} finally {
			delete process.env.SERVICE_SECRET_FOR_TEST;
		}
	});

	it("caps output with a marker, and keeps what was under the cap", async () => {
		const env = make({ maxOutputBytes: 2048 });
		const { output, result } = await run(env, "head -c 100000 /dev/zero | tr '\\0' 'a'");
		assert.equal(result.ok, true);
		assert.ok(output.length < 2048 + 100);
		assert.match(output, /\[output truncated at 2048 bytes\]/);
		assert.equal(output.startsWith("aaaa"), true);
	});

	it("applies the timeout and kills the whole process tree", async () => {
		const pidFile = join(root, "grandchild.pid");
		const env = make();
		const started = Date.now();
		const { result } = await run(env, `sh -c 'sleep 60 & echo $! > "${pidFile}"; wait'`, { timeout: 1 });
		assert.ok(Date.now() - started < 15_000, "returned promptly");
		assert.equal(result.ok === false || result.value.exitCode !== 0, true);
		const grandchild = Number(readFileSync(pidFile, "utf8").trim());
		assert.ok(grandchild > 0);
		await new Promise((done) => setTimeout(done, 300));
		assert.throws(() => process.kill(grandchild, 0), /ESRCH/, "the grandchild is gone");
	});

	it("clamps the timeout to the configured maximum, even when none or a larger one is asked", async () => {
		const env = make({ maxTimeoutSeconds: 1 });
		const started = Date.now();
		await run(env, "sleep 30");
		await run(env, "sleep 30", { timeout: 600 });
		assert.ok(Date.now() - started < 20_000);
	});

	it("stops when the context is cancelled", async () => {
		const { context, cancel } = withCancel(ctx);
		const pending = make().exec("sleep 60", {}, context);
		setTimeout(() => cancel("stop"), 300);
		const started = Date.now();
		const result = await pending;
		assert.ok(Date.now() - started < 15_000);
		assert.equal(result.ok === false || result.value.exitCode !== 0, true);
	});
});

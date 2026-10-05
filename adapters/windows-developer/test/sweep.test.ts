import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ConfinedExecutionEnv } from "../src/local-env.ts";
import { loadWindowsSettings } from "../src/settings.ts";
import { buildSweepScript, sweepLeftovers, type SweepOptions } from "../src/sweep.ts";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "windev-sweep-")));
const root = join(dir, "ws");
mkdirSync(root, { recursive: true });
const make = (sweep: (options: SweepOptions) => Promise<number>) =>
	new ConfinedExecutionEnv({ root, baseEnv: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root }, flavour: "posix", sweepUser: "svc-somework", sweep });

describe("the leftover sweep script", () => {
	it("targets one account, a start time and keeps the protected processes", () => {
		const script = buildSweepScript({ user: "svc-somework", sinceMs: 1_790_000_000_000, protectPids: [4242, 17] });
		assert.match(script, /FromUnixTimeMilliseconds\(1790000000000\)/);
		assert.match(script, /\$protect = @\(4242,17\)/);
		assert.match(script, /\$owner\.User -eq 'svc-somework'/);
	});

	it("refuses an account name that could break out of the script", () => {
		for (const user of ["x'; Remove-Item C:\\ -Recurse; '", "a b", "", "a".repeat(80)]) assert.throws(() => buildSweepScript({ user, sinceMs: 1_790_000_000_000, protectPids: [] }), /usable account name/);
		assert.throws(() => buildSweepScript({ user: "svc", sinceMs: 0, protectPids: [] }), /epoch/);
	});

	it("reports the number stopped and never throws", async () => {
		assert.equal(await sweepLeftovers({ user: "svc", sinceMs: 1_790_000_000_000, protectPids: [] }, async () => "3\r\n"), 3);
		assert.equal(await sweepLeftovers({ user: "svc", sinceMs: 1_790_000_000_000, protectPids: [] }, async () => "garbage"), 0);
		assert.equal(await sweepLeftovers({ user: "svc", sinceMs: 1_790_000_000_000, protectPids: [] }, async () => Promise.reject(new Error("powershell missing"))), 0);
	});
});

describe("when the confined environment sweeps", () => {
	it("sweeps after a timeout, for the command's own time window, protecting the service", async () => {
		const calls: SweepOptions[] = [];
		const before = Date.now();
		const result = await make(async (options) => (calls.push(options), 0)).exec("sleep 30", { timeout: 1 }, BACKGROUND_CONTEXT);
		assert.equal(result.ok, false);
		assert.equal(calls.length, 1);
		assert.equal(calls[0]!.user, "svc-somework");
		assert.ok(calls[0]!.sinceMs >= before - 1500 && calls[0]!.sinceMs <= Date.now());
		assert.deepEqual(calls[0]!.protectPids, [process.pid, process.ppid]);
	});

	it("does not sweep after a normal exit, even a failing one", async () => {
		const calls: SweepOptions[] = [];
		const env = make(async (options) => (calls.push(options), 0));
		await env.exec("true", {}, BACKGROUND_CONTEXT);
		const failing = await env.exec("exit 3", {}, BACKGROUND_CONTEXT);
		assert.ok(failing.ok && failing.value.exitCode === 3);
		assert.equal(calls.length, 0);
	});

	it("does not sweep when no account is configured", async () => {
		const env = new ConfinedExecutionEnv({ root, baseEnv: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root }, flavour: "posix" });
		assert.equal((await env.exec("sleep 30", { timeout: 1 }, BACKGROUND_CONTEXT)).ok, false);
	});
});

describe("the sweep setting", () => {
	const base = { WINDOWS_WORKSPACE_ROOT: "C:/somework/workspaces", WINDOWS_BASH: "C:\\Program Files\\Git\\bin\\bash.exe" };
	it("is read with one job at a time", () => {
		assert.equal(loadWindowsSettings({ ...base, WINDOWS_SWEEP_USER: "svc-somework", PI_CONCURRENCY: "1" }, () => true).sweepUser, "svc-somework");
	});
	it("is refused with concurrent jobs or an unusable name", () => {
		assert.throws(() => loadWindowsSettings({ ...base, WINDOWS_SWEEP_USER: "svc-somework", PI_CONCURRENCY: "2" }, () => true), /PI_CONCURRENCY=1/);
		assert.throws(() => loadWindowsSettings({ ...base, WINDOWS_SWEEP_USER: "svc-somework" }, () => true), /PI_CONCURRENCY=1/);
		assert.throws(() => loadWindowsSettings({ ...base, WINDOWS_SWEEP_USER: "bad name", PI_CONCURRENCY: "1" }, () => true), /usable account name/);
	});
	it("is off by default", () => {
		assert.equal(loadWindowsSettings(base, () => true).sweepUser, undefined);
	});
});

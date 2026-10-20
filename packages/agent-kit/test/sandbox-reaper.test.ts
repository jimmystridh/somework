import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { reapStaleProcesses, staleProcesses, startTicksOf } from "../src/sandbox/reaper.ts";

/** A /proc with a boot time of 1000 s and one entry per `[pid, startTicks, command]`. */
function fakeProc(entries: [number, number, string][]): string {
	const dir = mkdtempSync(join(tmpdir(), "reaper-"));
	writeFileSync(join(dir, "stat"), "cpu  1 2 3\nbtime 1000\nprocesses 5\n");
	for (const [pid, ticks, command] of entries) {
		mkdirSync(join(dir, String(pid)));
		// pid (comm) state ppid ... the 22nd field overall is the start time; the command name may hold spaces and parentheses
		const rest = ["S", "1", ...Array(16).fill("0"), "0", String(ticks)];
		writeFileSync(join(dir, String(pid), "stat"), `${pid} (node (a b)) ${rest.join(" ")} 0 0\n`);
		writeFileSync(join(dir, String(pid), "cmdline"), command.split(" ").join("\u0000"));
	}
	return dir;
}

describe("the sandbox's stale process reaper", () => {
	it("reads the start time after a command name with spaces and parentheses", () => {
		assert.equal(startTicksOf("42 (node (a b)) S 1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 123456 0 0"), 123456);
		assert.equal(startTicksOf("garbage"), undefined);
	});

	it("finds what is older than the limit, and never the sandbox itself", () => {
		// boot at t=1000, now 101000: a process started 100 s after boot is 99900 s old, one started 99000 s after boot is 1000 s old
		const procDir = fakeProc([[10, 100 * 100, "node --test test/events-runner.test.ts"], [11, 99_000 * 100, "node server.js"], [1, 100 * 100, "node sandbox/main.ts"]]);
		const found = staleProcesses({ maxAgeSeconds: 12 * 3600, procDir, selfPid: 1, nowSeconds: () => 101_000 });
		assert.deepEqual(found.map((entry) => entry.pid), [10]);
		assert.match(found[0]!.command, /events-runner/);
		assert.equal(found[0]!.ageSeconds, 99_900);
	});

	it("kills the stale ones, logs them and keeps going when one cannot be killed", () => {
		const procDir = fakeProc([[20, 100, "a"], [21, 100, "b"]]);
		const killed: number[] = [];
		const events: string[] = [];
		reapStaleProcesses({ maxAgeSeconds: 3600, procDir, selfPid: 1, nowSeconds: () => 100_000, kill: (pid) => { if (pid === 20) throw new Error("EPERM"); killed.push(pid); }, log: (event) => events.push(event) });
		assert.deepEqual(killed, [21]);
		assert.deepEqual(events.sort(), ["stale_process_kill_failed", "stale_process_killed"]);
	});

	it("does nothing on a machine without /proc", () => {
		assert.deepEqual(staleProcesses({ maxAgeSeconds: 1, procDir: join(tmpdir(), "no-such-proc") }), []);
	});

	it("kills a real leftover process on Linux", { skip: process.platform !== "linux" }, async () => {
		const child = spawn("sleep", ["300"], { stdio: "ignore", detached: true });
		const exited = new Promise((resolve) => child.once("exit", resolve));
		try {
			const reaped = reapStaleProcesses({ maxAgeSeconds: 3600, nowSeconds: () => Date.now() / 1000 + 7200 });
			assert.ok(reaped.some((entry) => entry.pid === child.pid), "the sleep is found");
			await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error("not killed")), 5000))]);
		} finally {
			child.kill("SIGKILL");
		}
	});
});

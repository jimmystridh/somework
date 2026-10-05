// Smoke test of the Windows developer on the machine it will run on (deploy/smoke.ps1 calls this). Also runs on macOS/Linux, where the
// same checks run against POSIX paths. Needs no SomeWork domain and no model: the task is driven through the kit's handler with a
// scripted model against a local bare repository.
//   node deploy/smoke.ts            prints PASS/FAIL lines; exit code 1 when anything failed
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { approvalPolicy, createHandler, Metrics, PiDurableRuntime } from "@somework/agent-kit";
import { scriptedModels } from "@somework/agent-kit/providers/faux";
import { FakeHost, makeRemote, sh } from "@somework/agent-kit/testing";
import { localEnvFactory } from "../src/local-env.ts";
import { profile } from "../src/profile.ts";
import { parseProfiles } from "../src/profiles.ts";
import { createRole } from "../src/role.ts";
import { baseEnvironment, bashCandidates, chooseBash } from "../src/shell.ts";

const windows = process.platform === "win32";
const results: { name: string; ok: boolean; detail: string }[] = [];

async function check(name: string, run: () => Promise<string | void> | string | void): Promise<void> {
	try {
		const detail = (await run()) ?? "";
		results.push({ name, ok: true, detail });
		console.log(`PASS: ${name}${detail ? ` (${detail})` : ""}`);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		results.push({ name, ok: false, detail });
		console.log(`FAIL: ${name}: ${detail.split("\n")[0]}`);
	}
}
const must = (condition: unknown, message: string): void => {
	if (!condition) throw new Error(message);
};

const root = realpathSync(mkdtempSync(join(tmpdir(), "somework-smoke-")));
const workspaceRoot = join(root, "workspaces");
mkdirSync(join(workspaceRoot, ".home"), { recursive: true });
mkdirSync(join(workspaceRoot, ".tmp"), { recursive: true });
process.env.TEMP = process.env.TMP = process.env.TMPDIR = join(workspaceRoot, ".tmp");

await check("node is 22.19+ and strips TypeScript", () => {
	const [major, minor] = process.versions.node.split(".").map(Number);
	must(major! > 22 || (major === 22 && minor! >= 19), `node ${process.version} is older than 22.19`);
	must((process.features as { typescript?: string | boolean }).typescript, "this node build has no TypeScript support (use the official build)");
	return process.version;
});

let bash: string | undefined;
await check(windows ? "Git for Windows bash and git are found" : "bash and git are found", () => {
	bash = windows ? chooseBash({ explicit: process.env.WINDOWS_BASH || undefined, candidates: bashCandidates(process.env), exists: existsSync }) : undefined;
	const git = execFileSync("git", ["--version"], { encoding: "utf8" }).trim();
	return `${bash ?? "/bin/bash"}; ${git}`;
});

const baseEnv = windows ? baseEnvironment({ root: workspaceRoot, host: process.env }) : { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: workspaceRoot };
if (windows) writeFileSync(join(workspaceRoot, ".home", ".gitconfig"), "[core]\n\tlongpaths = true\n\tautocrlf = false\n[credential]\n\thelper =\n");
const envFor = localEnvFactory({ root: workspaceRoot, shellPath: bash, baseEnv, maxOutputBytes: 64 * 1024, ...(windows ? { sweepUser: process.env.USERNAME } : {}) });
const ctx = BACKGROUND_CONTEXT;

const run = async (command: string, options: { cwd?: string; timeout?: number; env?: Record<string, string> } = {}) => {
	let output = "";
	const result = await envFor(undefined).exec(command, { ...options, onOutput: (text: string) => void (output += text) }, ctx);
	return { result, output };
};

await check("commands run through bash in the workspace root and see only the base environment", async () => {
	process.env.SOMEWORK_SMOKE_SECRET = "leak";
	const { output, result } = await run('echo "root=$(pwd) secret=[$SOMEWORK_SMOKE_SECRET]"');
	delete process.env.SOMEWORK_SMOKE_SECRET;
	must(result.ok && result.value.exitCode === 0, "the command failed");
	must(output.includes("secret=[]"), `the service's environment leaked: ${output.trim()}`);
	return output.trim().replace(/secret=\[\]/, "").trim();
});

await check("file access outside the workspace root is refused (.., absolute, home, link to outside)", async () => {
	const outside = join(root, "outside");
	mkdirSync(outside, { recursive: true });
	writeFileSync(join(outside, "secret.txt"), "secret");
	symlinkSync(outside, join(workspaceRoot, "escape"), "junction"); // a junction on Windows (no privilege needed), a symlink elsewhere
	const env = envFor(undefined);
	for (const path of ["..\\outside\\secret.txt", "../outside/secret.txt", join(outside, "secret.txt"), "~/x", "escape/secret.txt", "escape"]) {
		const read = await env.readTextFile(path, ctx);
		must(!read.ok, `${path} was readable`);
	}
	const written = await env.writeFile("escape/planted.txt", "x", ctx);
	must(!written.ok && !existsSync(join(outside, "planted.txt")), "a write went through the junction");
	return "6 reads and 1 write refused";
});

if (windows) {
	await check("8.3 short names, UNC, device names and alternate streams are refused", async () => {
		const env = envFor(undefined);
		for (const path of ["PROGRA~1", "\\\\localhost\\c$\\Windows", "\\\\?\\C:\\Windows", "CON", "file.txt:stream", "C:Windows"]) must(!(await env.readTextFile(path, ctx)).ok, `${path} was accepted`);
	});
}

await check("a timeout kills the command and everything it started", async () => {
	const marker = "60.3141";
	const started = Date.now();
	await run(`sleep ${marker} & sleep ${marker}`, { timeout: 2 });
	must(Date.now() - started < 20_000, "the command was not stopped by its timeout");
	await new Promise((done) => setTimeout(done, 1000));
	const left = windows
		? spawnSync("powershell.exe", ["-NoProfile", "-Command", `@(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'sleep.exe' -and $_.CommandLine -like '*${marker}*' }).Count`], { encoding: "utf8" }).stdout.trim()
		: spawnSync("pgrep", ["-f", `sleep ${marker}`], { encoding: "utf8" }).stdout.trim() === ""
			? "0"
			: "1";
	must(left === "0", `${left} process(es) survived the timeout`);
	return "no process left";
});

await check("a legacy-encoded (Windows-1252) source file survives a byte-preserving edit, and a rewrite as UTF-8 is blocked", async () => {
	const { dir, remote } = makeRemote();
	const seed = join(dir, "seed");
	writeFileSync(join(seed, "legacy.cpp"), Buffer.from("// Vi s\u00e4ger: h\u00e5ll \u00f6ver\r\nint main() {}\r\n", "latin1"));
	sh(seed, "add", "-A");
	sh(seed, "commit", "-m", "legacy");
	sh(seed, "push", "origin", "HEAD:main");

	const profiles = parseProfiles({ build: { smoke: { command: "test -f legacy.cpp && echo build-ok" } }, encoding: { legacyGlobs: ["**/*.cpp"] } });
	const drive = async (taskId: string, plan: string[]) => {
		const fake = scriptedModels(plan);
		const host = new FakeHost();
		const runtime = new PiDurableRuntime({ storagePath: join(root, `${taskId}.sqlite`), models: fake.models, model: fake.model, env: envFor, policy: approvalPolicy([], profile.approvalPatterns) });
		await runtime.start();
		try {
			const client = { uploadArtifact: async (a: { filename: string }) => ({ artifactId: `art_${a.filename}` }) };
			const role = createRole({ profiles });
			const handler = createHandler({ runtime, envFor, session: { env: envFor(workspaceRoot), identity: { name: "Smoke", email: "smoke@test.invalid" } }, host, workspaceRoot, client: client as never, limits: { maxTokensCap: 1_000_000, maxMinutesCap: 10 }, metrics: new Metrics(), profile, hooks: role.hooks });
			const control = { signal: new AbortController().signal, stopReason: undefined, progress() {}, requestInput: async () => ({ approved: false }) };
			const job = { taskId, task: { conversationId: taskId }, capability: { id: "code.windows", version: "1" }, fencingToken: 1, runtimeInstanceId: "smoke", input: { repository: { url: remote, ref: "main" }, instruction: "edit legacy.cpp", budget: { maxTokens: 100_000, maxMinutes: 5 }, build: { name: "smoke" } } };
			return { outcome: (await handler(job as never, control as never)) as { type: string; result?: Record<string, unknown> }, host };
		} finally {
			await runtime.close();
		}
	};
	const pushed = (taskId: string): boolean => {
		try {
			sh(remote, "rev-parse", "--verify", "--quiet", `refs/heads/agent/${taskId}`);
			return true;
		} catch {
			return false;
		}
	};

	const good = await drive("smoke-good", ["bash:printf '// added\\r\\n' >> legacy.cpp", "final:appended"]);
	must(good.outcome.type === "completed" && good.outcome.result?.status === "completed", `byte-preserving edit: ${JSON.stringify(good.outcome).slice(0, 300)}`);
	must(pushed("smoke-good"), "the byte-preserving edit was not pushed");
	const stored = execFileSync("git", ["show", "refs/heads/agent/smoke-good:legacy.cpp"], { cwd: remote });
	must(stored.includes(Buffer.from([0xe4])) && !stored.includes(Buffer.from([0xc3, 0xa4])), "the pushed file is not Windows-1252 any more");
	must(stored.toString("latin1").includes("\r\n// added\r\n"), "CRLF line endings were lost");

	const bad = await drive("smoke-bad", ["bash:printf 'Vi s\\xc3\\xa4ger\\r\\n' > legacy.cpp", "final:rewrote"]);
	must(bad.outcome.type === "completed" && bad.outcome.result?.status === "blocked", `UTF-8 rewrite: ${JSON.stringify(bad.outcome).slice(0, 300)}`);
	must(!pushed("smoke-bad"), "a damaged file was pushed");
	return "edit pushed intact; rewrite blocked";
});

await check("build output with a token-like string is redacted in the stored log", async () => {
	const { dir, remote } = makeRemote();
	void dir;
	const profiles = parseProfiles({ build: { leaky: { command: "echo token=ghp_abcdefghijklmnopqrstuvwxyz0123456789; echo done" } } });
	const stored: string[] = [];
	const client = { uploadArtifact: async (a: { bytes: string }) => (stored.push(String(a.bytes)), { artifactId: "art_log" }) };
	const fake = scriptedModels(["write:x.txt:1", "final:ok"]);
	const runtime = new PiDurableRuntime({ storagePath: join(root, "leaky.sqlite"), models: fake.models, model: fake.model, env: envFor });
	await runtime.start();
	try {
		const role = createRole({ profiles, secrets: [] });
		const handler = createHandler({ runtime, envFor, session: { env: envFor(workspaceRoot), identity: { name: "Smoke", email: "smoke@test.invalid" } }, host: new FakeHost(), workspaceRoot, client: client as never, limits: { maxTokensCap: 1_000_000, maxMinutesCap: 10 }, profile, hooks: role.hooks });
		const control = { signal: new AbortController().signal, stopReason: undefined, progress() {}, requestInput: async () => ({ approved: false }) };
		await handler({ taskId: "smoke-log", task: { conversationId: "smoke-log" }, capability: { id: "code.windows", version: "1" }, fencingToken: 1, runtimeInstanceId: "smoke", input: { repository: { url: remote, ref: "main" }, instruction: "x", budget: { maxTokens: 100_000, maxMinutes: 5 }, build: { name: "leaky" } } } as never, control as never);
	} finally {
		await runtime.close();
	}
	const log = stored.find((text) => text.includes("--- leaky"));
	must(log !== undefined, "the build log was not uploaded");
	must(!log!.includes("ghp_abcdefghijklmnopqrstuvwxyz") && log!.includes("token=[REDACTED]"), `log was not redacted: ${log!.slice(0, 200)}`);
});

try {
	rmSync(root, { recursive: true, force: true });
} catch {
	// a surviving junction or open handle: the temporary directory is cleaned by the next run of the machine's temp cleanup
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? `; failed: ${failed.map((r) => r.name).join("; ")}` : ""}`);
process.exit(failed.length === 0 ? 0 : 1);

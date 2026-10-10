import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { createHandler, approvalPolicy, InvalidInput, Metrics, PiDurableRuntime } from "@somework/agent-kit";
import { scriptedModels } from "@somework/agent-kit/providers/faux";
import { FakeHost, makeRemote, runHandler, sh } from "@somework/agent-kit/testing";
import { localEnvFactory } from "@somework/agent-kit/windows";
import { profile } from "../src/profile.ts";
import { parseProfiles } from "../src/profiles.ts";
import { createRole } from "../src/role.ts";
import card from "../card.json" with { type: "json" };

const here = new URL(".", import.meta.url).pathname;
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const PROFILES = {
	build: {
		ok: { command: "echo compiling && test -f feature.txt && echo built-with-feature", timeoutMinutes: 2 },
		broken: { command: "echo about to fail && echo secret=ghp_abcdefghijklmnopqrstuvwxyz0123456789 && exit 3", timeoutMinutes: 2 },
		advisory: { command: "exit 1", timeoutMinutes: 2, blockPushOnFailure: false },
	},
	test: {
		unit: { command: "echo tests-passed && test -f feature.txt", timeoutMinutes: 2 },
		flaky: { command: "echo one failure && exit 1", timeoutMinutes: 2, blockPushOnFailure: false },
	},
	encoding: { legacyGlobs: ["**/*.cpp"], blockPush: true },
};

interface Stored {
	artifactId: string;
	filename: string;
	bytes: Buffer;
}

interface Run {
	taskId: string;
	task: { state: "succeeded" | "failed"; result?: any; failure?: any; resultArtifacts: any[] };
}

interface Stack {
	remote: string;
	seed: string;
	host: FakeHost;
	stored: Stored[];
	run(input?: Record<string, unknown>): Promise<Run>;
	pushed(taskId: string): boolean;
}

async function stack(plan: string[], seedLegacy = false, profilesRaw: unknown = PROFILES): Promise<Stack> {
	const { dir: remoteDir, remote } = makeRemote();
	const seed = join(remoteDir, "seed");
	if (seedLegacy) {
		writeFileSync(join(seed, "legacy.cpp"), Buffer.from("// Vi s\u00e4ger: h\u00e5ll \u00f6ver\r\nint main() {}\r\n", "latin1"));
		sh(seed, "add", "-A");
		sh(seed, "commit", "-m", "legacy source");
		sh(seed, "push", "origin", "HEAD:main");
	}
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "windev-e2e-")));
	const root = join(dir, "workspaces");
	const fake = scriptedModels(plan);
	const host = new FakeHost();
	const profiles = parseProfiles(profilesRaw);
	const envFor = localEnvFactory({ root, baseEnv: { PATH: process.env.PATH ?? "", HOME: root }, flavour: "posix" });
	const stored: Stored[] = [];
	const client = {
		uploadArtifact: async (options: { filename: string; mediaType: string; bytes: Uint8Array | string }) => {
			const artifactId = `art_${stored.length + 1}`;
			stored.push({ artifactId, filename: options.filename, bytes: Buffer.from(options.bytes) });
			return { artifactId, filename: options.filename, mediaType: options.mediaType, sizeBytes: stored.at(-1)!.bytes.length };
		},
	} as never;
	const runtime = new PiDurableRuntime({ storagePath: join(dir, "pi.sqlite"), models: fake.models, model: fake.model, env: envFor, policy: approvalPolicy([], profile.approvalPatterns) });
	await runtime.start();
	cleanups.push(() => runtime.close());
	const role = createRole({ profiles });
	const handler = createHandler({ runtime, envFor, session: { env: envFor(root), identity: { name: "Win", email: "win@test.invalid" } }, host, workspaceRoot: root, client, limits: { maxTokensCap: 5_000_000, maxMinutesCap: 60 }, metrics: new Metrics(), profile, hooks: role.hooks });
	let runs = 0;
	return {
		remote,
		seed,
		host,
		stored,
		async run(input = {}) {
			const taskId = `job-win${(runs += 1)}`;
			const outcome = await runHandler(handler, { taskId, capability: { id: "code.windows", version: "1" }, input: { repository: { url: remote, ref: "main" }, instruction: "add a feature", budget: { maxTokens: 1_000_000, maxMinutes: 5 }, ...input } });
			if (outcome.type === "detach") assert.fail("the job detached");
			const task = outcome.type === "completed" ? { state: "succeeded" as const, result: outcome.result as any, resultArtifacts: outcome.artifacts ?? [] } : { state: "failed" as const, failure: outcome.failure as any, resultArtifacts: [] };
			return { taskId, task };
		},
		pushed(taskId) {
			try {
				sh(remote, "rev-parse", "--verify", "--quiet", `refs/heads/agent/${taskId}`);
				return true;
			} catch {
				return false;
			}
		},
	};
}

describe("Windows developer role end to end", () => {
	it("is the card it claims to be", () => {
		assert.deepEqual(profile.capabilities, [{ id: "code.windows", version: "1" }]);
		assert.equal(card.capabilities[0]!.sideEffects, "write");
		assert.equal(card.agentId, "agent/windows-developer");
		assert.deepEqual(profile.skills.allow, [], "no repository skill is exposed unless the deployment names it");
		assert.deepEqual([profile.git.push, profile.git.pullRequest], [true, true]);
		assert.equal(profile.requireBudget, true);
	});

	it("builds and tests after the model finished, then pushes: logs are artifacts, results are in the output", async () => {
		const s = await stack(["write:feature.txt:new feature", "final:added feature.txt"]);
		const { taskId, task } = await s.run({ build: { name: "ok" }, tests: ["unit"] });
		assert.equal(task.state, "succeeded", JSON.stringify(task.failure));
		assert.equal(task.result.status, "completed");
		assert.equal(task.result.branch, `agent/${taskId}`);
		assert.equal(task.result.build.ok, true);
		assert.equal(task.result.build.name, "ok");
		assert.equal(task.result.tests[0].ok, true);
		assert.ok(task.result.build.logArtifact && task.result.tests[0].logArtifact, "both logs are artifacts");
		assert.equal(task.result.encoding.ok, true);
		assert.equal(task.resultArtifacts.length, 3, "patch, build log, test log");
		assert.equal(s.pushed(taskId), true);
		assert.equal(s.host.created.length, 1);
	});

	it("a failing build blocks the push and the result says why; the log is redacted", async () => {
		const s = await stack(["write:feature.txt:new feature", "final:added feature.txt"]);
		const { taskId, task } = await s.run({ build: { name: "broken" }, tests: ["unit"] });
		assert.equal(task.state, "succeeded", JSON.stringify(task.failure));
		assert.equal(task.result.status, "blocked");
		assert.equal(task.result.branch, undefined);
		assert.equal(task.result.build.ok, false);
		assert.equal(task.result.build.exitCode, 3);
		assert.match(task.result.blocked[0], /build "broken" failed \(exit 3\)/);
		assert.equal(task.result.tests[0].skipped, true, "tests are skipped when the build failed");
		assert.equal(task.result.summary, "added feature.txt");
		assert.equal(s.pushed(taskId), false, "nothing reached the remote");
		assert.equal(s.host.created.length, 0, "no pull request");
		assert.equal(task.resultArtifacts.length, 1, "the build log");
		const log = s.stored.find((item) => item.artifactId === task.result.build.logArtifact)!.bytes.toString("utf8");
		assert.match(log, /about to fail/);
		assert.match(log, /exit code 3/);
		assert.ok(!log.includes("ghp_abcdefghijklmnopqrstuvwxyz"), "the token-like text is redacted in the stored log");
		assert.match(log, /secret=\[REDACTED\]/);
	});

	it("a failing check whose profile does not block still pushes, and reports the failure", async () => {
		const s = await stack(["write:feature.txt:new feature", "final:done"]);
		const { taskId, task } = await s.run({ build: { name: "advisory" }, tests: ["flaky"] });
		assert.equal(task.state, "succeeded", JSON.stringify(task.failure));
		assert.equal(task.result.status, "completed");
		assert.equal(task.result.build.ok, false);
		assert.equal(task.result.blocked, undefined);
		assert.equal(s.pushed(taskId), true);
	});

	it("refuses an arbitrary build command: the role only runs pre-configured profiles", async () => {
		const s = await stack(["final:ok"]);
		for (const build of [{ name: "ok", command: "del /s /q C:\\" }, { command: "whoami" }]) {
			const { task } = await s.run({ build });
			assert.equal(task.state, "failed");
			assert.equal(task.failure.code, "invalid_input");
		}
		const role = createRole({ profiles: parseProfiles(PROFILES) });
		assert.throws(() => role.hooks.instruction!({ instruction: "x", repository: { url: "u", ref: "main" }, build: { name: "ok", command: "whoami" } }, { taskId: "t" }), (error: Error) => error instanceof InvalidInput && /only pre-configured/.test(error.message));
	});

	it("an unknown profile name fails the job as invalid input, before any work", async () => {
		const s = await stack(["write:feature.txt:x", "final:ok"]);
		const { taskId, task } = await s.run({ build: { name: "does-not-exist" } });
		assert.equal(task.state, "failed");
		assert.equal(task.failure.code, "invalid_input");
		assert.match(task.failure.message, /unknown build profile "does-not-exist"; configured: ok, broken, advisory/);
		assert.equal(s.pushed(taskId), false);
	});

	it("blocks the push when a legacy source file was silently rewritten as UTF-8", async () => {
		const s = await stack([`bash:printf 'Vi s\\xc3\\xa4ger\\r\\n' > legacy.cpp`, "final:rewrote legacy.cpp"], true);
		const { taskId, task } = await s.run();
		assert.equal(task.state, "succeeded", JSON.stringify(task.failure));
		assert.equal(task.result.status, "blocked");
		assert.equal(task.result.encoding.ok, false);
		assert.equal(task.result.encoding.violations[0].file, "legacy.cpp");
		assert.match(task.result.encoding.violations[0].reasons.join(" "), /legacy 8-bit file/);
		assert.match(task.result.blocked[0], /^encoding: legacy\.cpp/);
		assert.equal(s.pushed(taskId), false);
	});

	it("pushes an edit that keeps the legacy encoding and CRLF intact", async () => {
		const s = await stack([`bash:printf '// added\\r\\n' >> legacy.cpp`, "final:appended"], true);
		const { taskId, task } = await s.run();
		assert.equal(task.state, "succeeded", JSON.stringify(task.failure));
		assert.equal(task.result.status, "completed");
		assert.deepEqual([task.result.encoding.ok, task.result.encoding.checked], [true, 1]);
		assert.equal(s.pushed(taskId), true);
		const stored = sh(s.remote, "show", `refs/heads/agent/${taskId}:legacy.cpp`);
		assert.ok(stored.includes("// added"));
	});

	it("an encoding policy that does not block still reports the damage and pushes", async () => {
		const s = await stack([`bash:printf 'Vi s\\xc3\\xa4ger\\r\\n' > legacy.cpp`, "final:rewrote"], true, { ...PROFILES, encoding: { legacyGlobs: ["**/*.cpp"], blockPush: false } });
		const { taskId, task } = await s.run();
		assert.equal(task.result.status, "completed");
		assert.equal(task.result.encoding.ok, false);
		assert.equal(s.pushed(taskId), true);
	});

	it("without a selection it behaves like the developer role and still checks encodings", async () => {
		const s = await stack(["write:feature.txt:new feature", "final:added"]);
		const { taskId, task } = await s.run();
		assert.equal(task.result.status, "completed");
		assert.equal(task.result.build, undefined);
		assert.equal(task.result.encoding.ok, true);
		assert.equal(task.resultArtifacts.length, 1, "only the patch");
	});
});

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { Job, JobControl } from "@somework/sdk";
import { createHandler } from "../src/handler.ts";
import { PiDurableRuntime } from "../src/pi-runtime.ts";
import { DEFAULT_APPROVAL_PATTERNS } from "../src/policy.ts";
import { InvalidInput, validateProfile, type AgentProfile, type RoleHooks } from "../src/profile.ts";
import { Metrics } from "../src/metrics.ts";
import { scriptedModels } from "../src/providers/faux.ts";
import { emptyUsage, type AgentRequest, type AgentRuntime } from "../src/runtime.ts";
import { FakeHost, makeRemote } from "../src/testing.ts";

const tmp = (): string => mkdtempSync(join(tmpdir(), "kit-profile-"));

const base = (over: Partial<AgentProfile> = {}): AgentProfile => ({
	id: "tester",
	capabilities: [{ id: "code.agent", version: "1" }],
	approvalPatterns: DEFAULT_APPROVAL_PATTERNS,
	defaultBudget: { maxTokens: 7000, maxMinutes: 3 },
	git: { push: true, pullRequest: true, branchPrefix: "agent" },
	skills: { allow: [] },
	...over,
});

describe("validateProfile", () => {
	it("accepts a sound profile and rejects contradictions", () => {
		assert.equal(validateProfile(base()).id, "tester");
		assert.throws(() => validateProfile(base({ id: "" })), /id is required/);
		assert.throws(() => validateProfile(base({ capabilities: [] })), /serves no capability/);
		assert.throws(() => validateProfile(base({ git: { push: true, pullRequest: true, branchPrefix: "../x" } })), /branchPrefix/);
		assert.throws(() => validateProfile(base({ git: { push: false, pullRequest: true, branchPrefix: "agent" } })), /needs the branch to be pushed/);
		assert.throws(() => validateProfile(base({ defaultBudget: { maxTokens: 0, maxMinutes: 1 } })), /defaultBudget/);
	});
});

describe("the handler under a profile", () => {
	function harness(profile: AgentProfile | undefined, hooks?: RoleHooks, edit = true) {
		const requests: AgentRequest[] = [];
		const { remote } = makeRemote();
		const host = new FakeHost();
		const workspaceRoot = join(tmp(), "workspaces");
		const runtime: AgentRuntime = {
			start: async () => {},
			health: () => ({ ready: true }),
			close: async () => {},
			execute: async (request) => {
				requests.push(request);
				if (edit) writeFileSync(join(request.workspace, "change.txt"), "changed\n");
				return { status: "done", answer: "did it", usage: emptyUsage() };
			},
		};
		const uploads: string[] = [];
		const handler = createHandler({
			runtime,
			session: { env: new NodeExecutionEnv({ cwd: workspaceRoot }), identity: { name: "Kit", email: "kit@test.invalid" } },
			host,
			workspaceRoot,
			client: { uploadArtifact: async (a: { filename: string }) => (uploads.push(a.filename), { artifactId: "art_1" }) } as never,
			limits: { maxTokensCap: 10_000, maxMinutesCap: 5 },
			profile,
			hooks,
		});
		const run = (input: Record<string, unknown>, capability: unknown = { id: "code.agent", version: "1" }) =>
			handler({ taskId: "task_1", task: {}, input: { repository: { url: remote, ref: "main" }, instruction: "x", ...input }, capability } as unknown as Job, { signal: new AbortController().signal, progress() {} } as unknown as JobControl) as Promise<any>;
		const branches = () => execFileSync("git", ["branch", "--list"], { cwd: remote, encoding: "utf8" });
		return { requests, host, run, branches, uploads };
	}
	const budget = { budget: { maxTokens: 5000, maxMinutes: 1 } };

	it("refuses a capability the role does not serve, and serves its own", async () => {
		const { run, requests } = harness(base());
		const refused = await run(budget, { id: "qa.verify", version: "1" });
		assert.equal(refused.failure.code, "unsupported_capability");
		assert.equal(requests.length, 0);
		assert.equal((await run(budget)).type, "completed");
		assert.equal((await run(budget, { id: "code.agent", version: 1 })).type, "completed", "a numeric version still matches");
	});

	it("pushes the task branch under the profile's prefix and opens a pull request", async () => {
		const { run, branches, host, uploads } = harness(base({ git: { push: true, pullRequest: true, branchPrefix: "dev" } }));
		const outcome = await run(budget);
		assert.equal(outcome.result.branch, "dev/task_1");
		assert.match(branches(), /dev\/task_1/);
		assert.equal(host.created[0]!.head, "dev/task_1");
		assert.deepEqual(uploads, ["task_1.diff"]);
	});

	it("pushes without a pull request when the profile says so", async () => {
		const { run, branches, host } = harness(base({ git: { push: true, pullRequest: false, branchPrefix: "agent" } }));
		const outcome = await run(budget);
		assert.match(branches(), /agent\/task_1/);
		assert.equal(host.created.length, 0);
		assert.equal(outcome.result.prUrl, undefined);
	});

	it("leaves a read-only role's workspace alone: nothing is pushed, no patch, no pull request", async () => {
		const { run, branches, host, uploads } = harness(base({ git: { push: false, pullRequest: false, branchPrefix: "agent" } }));
		const outcome = await run(budget);
		assert.equal(outcome.type, "completed");
		assert.deepEqual(Object.keys(outcome.result).sort(), ["status", "summary", "usage"]);
		assert.doesNotMatch(branches(), /task_1/);
		assert.deepEqual([host.created.length, uploads.length], [0, 0]);
	});

	it("requires a budget unless the profile supplies one, and clamps whatever is used to the service caps", async () => {
		const strict = harness(base());
		assert.equal((await strict.run({})).failure.code, "budget_required");
		const lenient = harness(base({ requireBudget: false, defaultBudget: { maxTokens: 900_000, maxMinutes: 30 } }));
		assert.equal((await lenient.run({})).type, "completed");
		assert.deepEqual(lenient.requests[0]!.budget, { maxTokens: 10_000, maxMinutes: 5 });
		assert.equal((await lenient.run({ budget: { maxTokens: 2000, maxMinutes: 1 } })).type, "completed");
		assert.deepEqual(lenient.requests[1]!.budget, { maxTokens: 2000, maxMinutes: 1 });
	});

	it("lets the role shape the instruction and the pull request, and refuse bad input", async () => {
		const hooks: RoleHooks = {
			instruction(input) {
				if (typeof input.ticket !== "string") throw new InvalidInput("a ticket is required");
				return `Review ${input.ticket}`;
			},
			pullRequest: (_input, { taskId, instruction }) => ({ title: `[review] ${instruction}`, body: `task ${taskId}` }),
		};
		const { run, requests, host } = harness(base(), hooks);
		assert.equal((await run({ ...budget, instruction: undefined })).failure.code, "invalid_input");
		assert.equal((await run({ ...budget, ticket: "T-1" })).type, "completed");
		assert.equal(requests[0]!.instruction, "Review T-1");
		assert.equal(host.created[0]!.title, "[review] Review T-1");
	});

	it("behaves as the developer role did when no profile is given", async () => {
		const { run, branches, requests } = harness(undefined);
		assert.equal((await run({})).failure.code, "budget_required");
		const outcome = await run(budget, { id: "anything", version: "9" });
		assert.equal(outcome.result.branch, "agent/task_1");
		assert.match(branches(), /agent\/task_1/);
		assert.equal(requests.length, 1);
	});
});

describe("allowedTools", () => {
	const open: PiDurableRuntime[] = [];
	afterEach(async () => {
		for (const runtime of open.splice(0)) await runtime.close();
	});

	async function runtimeWith(plan: string[], allowedTools: string[] | undefined, instructions?: string) {
		const contexts: any[] = [];
		const fake = scriptedModels(plan, (context) => contexts.push(context));
		const dir = tmp();
		const workspace = join(dir, "ws");
		mkdirSync(workspace);
		const runtime = new PiDurableRuntime({ storagePath: join(dir, "state.sqlite"), models: fake.models, model: fake.model, env: (cwd) => new NodeExecutionEnv({ cwd: cwd ?? dir }), allowedTools, instructions });
		open.push(runtime);
		return { runtime, workspace, contexts };
	}
	const hooks = () => ({ signal: new AbortController().signal, onProgress: () => {}, requestApproval: async () => ({ approved: true }) });
	const request = (workspace: string): AgentRequest => ({ requestId: "j1", agentKey: "k", instruction: "go", workspace, budget: { maxTokens: 1_000_000, maxMinutes: 5 } });
	/** The tools the request offers are announced by the system messages (`toolsAdded`). */
	const toolNames = (context: any): string[] => context.messages.flatMap((message: any) => (message.role === "system" ? (message.toolsAdded ?? []).map((tool: any) => tool.name) : [])).sort();

	it("offers the model only the allowed tools and blocks a call to any other", async () => {
		const { runtime, workspace, contexts } = await runtimeWith(["write:out.txt:hello", "final:done"], ["read", "bash"]);
		await runtime.start();
		const outcome = await runtime.execute(request(workspace), hooks());
		assert.equal(outcome.status, "done");
		assert.deepEqual(toolNames(contexts[0]), ["bash", "read"]);
		assert.equal(existsSync(join(workspace, "out.txt")), false, "the write was refused");
		assert.match(JSON.stringify(contexts.at(-1)), /Tool write is not available/);
	});

	it("offers every tool when nothing is restricted", async () => {
		const { runtime, workspace, contexts } = await runtimeWith(["final:ok"], undefined);
		await runtime.start();
		await runtime.execute(request(workspace), hooks());
		assert.ok(toolNames(contexts[0]).length >= 4, toolNames(contexts[0]).join(","));
	});

	it("stops at startup on a tool name that does not exist", async () => {
		const { runtime } = await runtimeWith(["final:ok"], ["read", "wirte"]);
		await assert.rejects(() => runtime.start(), /wirte/);
	});

	it("gives a new conversation the role's standing orders", async () => {
		const { runtime, workspace, contexts } = await runtimeWith(["final:ok"], undefined, "You only review; never change files.");
		await runtime.start();
		await runtime.execute(request(workspace), hooks());
		assert.match(JSON.stringify(contexts[0]), /You only review; never change files\./);
	});
});

describe("role hooks around the handler", () => {
	function setup(profile: AgentProfile | undefined, hooks: RoleHooks, options: { outcome?: Awaited<ReturnType<AgentRuntime["execute"]>> | "detach" } = {}) {
		const { remote } = makeRemote();
		const host = new FakeHost();
		const workspaceRoot = join(tmp(), "workspaces");
		const metrics = new Metrics();
		const logs: { level: string; event: string; fields: any }[] = [];
		const requests: AgentRequest[] = [];
		const envUsed: (string | undefined)[] = [];
		const env = new NodeExecutionEnv({ cwd: workspaceRoot });
		const runtime: AgentRuntime = {
			start: async () => {},
			health: () => ({ ready: true }),
			close: async () => {},
			execute: async (request) => {
				requests.push(request);
				writeFileSync(join(request.workspace, "change.txt"), "changed\n");
				if (options.outcome === "detach") return { status: "detached" };
				return options.outcome ?? { status: "done", answer: "did it", usage: emptyUsage() };
			},
		};
		const uploads: string[] = [];
		const handler = createHandler({
			runtime,
			session: { env, identity: { name: "Kit", email: "kit@test.invalid" } },
			envFor: (cwd) => (envUsed.push(cwd), env),
			host,
			workspaceRoot,
			client: { uploadArtifact: async (a: { filename: string }) => (uploads.push(a.filename), { artifactId: `art_${uploads.length}` }) } as never,
			limits: { maxTokensCap: 10_000, maxMinutesCap: 5 },
			metrics,
			log: (level, event, fields) => logs.push({ level, event, fields }),
			profile,
			hooks,
		});
		const run = (input: Record<string, unknown> = {}) =>
			handler({ taskId: "task_1", task: {}, input: { repository: { url: remote, ref: "main" }, instruction: "x", budget: { maxTokens: 5000, maxMinutes: 1 }, ...input }, capability: { id: "code.agent", version: "1" } } as unknown as Job, { signal: new AbortController().signal, progress() {} } as unknown as JobControl) as Promise<any>;
		const branches = () => execFileSync("git", ["branch", "--list"], { cwd: remote, encoding: "utf8" });
		return { run, host, metrics, logs, requests, uploads, envUsed, branches, remote };
	}

	it("prepareInput can enrich the input before the instruction is built, and can refuse", async () => {
		const hooks: RoleHooks = {
			async prepareInput(input) {
				if (input.fail) throw new InvalidInput("no way");
				if (input.boom) throw new Error("context service down");
				return { ...input, context: "fetched" };
			},
			instruction: (input) => `${input.instruction} + ${input.context}`,
		};
		const { run, requests } = setup(base(), hooks);
		assert.equal((await run()).type, "completed");
		assert.equal(requests[0]!.instruction, "x + fetched");
		assert.equal((await run({ fail: true })).failure.code, "invalid_input");
		const failed = (await run({ boom: true })).failure;
		assert.deepEqual([failed.code, failed.retryable], ["job_error", true]);
	});

	it("beforeFinalize that returns nothing lets the work through", async () => {
		const seen: string[] = [];
		const { run, branches } = setup(base(), { beforeFinalize: async (ctx) => void seen.push(`${ctx.taskId}:${ctx.answer}:${ctx.baseBranch}`) });
		assert.equal((await run()).result.status, "completed");
		assert.deepEqual(seen, ["task_1:did it:main"]);
		assert.match(branches(), /agent\/task_1/);
	});

	it("a blocked run completes as `blocked`: nothing is pushed, nothing is opened, and it is counted as blocked, not as an unanswered run", async () => {
		const resultSeen: any[] = [];
		const hooks: RoleHooks = {
			beforeFinalize: async () => ({ blocked: { reason: "the build failed", details: { exitCode: 2 } } }),
			result: (base, ctx) => (resultSeen.push({ blocked: ctx.blocked, finalize: ctx.finalize, baseSha: ctx.baseSha }), { result: { ...base, blockedBy: ctx.blocked!.reason }, artifacts: [{ artifactId: "log_1" }] }),
		};
		const { run, branches, host, uploads, metrics, logs } = setup(base(), hooks);
		const outcome = await run();
		assert.equal(outcome.type, "completed");
		assert.equal(outcome.result.status, "blocked");
		assert.equal(outcome.result.blockedBy, "the build failed");
		assert.equal(outcome.result.summary, "did it");
		assert.deepEqual(outcome.artifacts, [{ artifactId: "log_1" }], "no diff artifact, only what the role added");
		assert.doesNotMatch(branches(), /task_1/);
		assert.deepEqual([host.created.length, uploads.length], [0, 0]);
		assert.deepEqual([resultSeen[0].blocked.details, resultSeen[0].finalize, /^[0-9a-f]{40}$/.test(resultSeen[0].baseSha)], [{ exitCode: 2 }, undefined, true]);
		const text = metrics.render();
		assert.match(text, /somework_pi_jobs_total\{status="blocked"\} 1/);
		assert.doesNotMatch(text, /status="unanswered"|status="done"/);
		assert.match(text, /somework_pi_job_duration_seconds_count\{status="blocked"\} 1/);
		assert.ok(logs.some((l) => l.event === "job_blocked" && l.fields.reason === "the build failed"));
	});

	it("a read-only role is gated too", async () => {
		const { run } = setup(base({ git: { push: false, pullRequest: false, branchPrefix: "agent" } }), { beforeFinalize: async () => ({ blocked: { reason: "unreadable" } }) });
		assert.equal((await run()).result.status, "blocked");
	});

	it("a throwing beforeFinalize fails the job as retryable and pushes nothing", async () => {
		const { run, branches } = setup(base(), { beforeFinalize: async () => { throw new Error("checker crashed"); } });
		const outcome = await run();
		assert.deepEqual([outcome.failure.code, outcome.failure.retryable], ["job_error", true]);
		assert.doesNotMatch(branches(), /task_1/);
	});

	it("the result hook can extend the result, replace it, add artifacts, or fail the task", async () => {
		const modes: Record<string, RoleHooks["result"]> = {
			extend: (base) => ({ result: { ...base, extra: 1 }, artifacts: [{ artifactId: "x" }] }),
			replace: () => ({ result: { verdict: "approve" } }),
			fail: () => ({ failure: { code: "invalid_review_output", message: "no json", retryable: false } }),
			nothing: () => undefined,
		};
		for (const [mode, hook] of Object.entries(modes)) {
			const { run } = setup(base(), { result: hook });
			const outcome = await run();
			if (mode === "extend") {
				assert.deepEqual([outcome.result.extra, outcome.result.branch, outcome.artifacts.length], [1, "agent/task_1", 2], "the kit's diff artifact stays, the role's is added");
			} else if (mode === "replace") {
				assert.deepEqual(outcome.result, { verdict: "approve" });
			} else if (mode === "fail") {
				assert.deepEqual([outcome.type, outcome.failure.code, outcome.failure.retryable], ["failed", "invalid_review_output", false]);
			} else {
				assert.equal(outcome.result.branch, "agent/task_1");
			}
		}
	});

	it("the result hook sees the git outcome and the base commit", async () => {
		let seen: any;
		const { run } = setup(base(), { result: (_base, ctx) => void (seen = { commits: ctx.finalize?.commits.length, status: ctx.finalize?.status, baseSha: ctx.baseSha, base: ctx.baseBranch, usage: ctx.usage.totalTokens }) });
		await run();
		assert.deepEqual([seen.commits, seen.status, /^[0-9a-f]{40}$/.test(seen.baseSha), seen.base, seen.usage], [1, "completed", true, "main", 0]);
	});

	it("onSettled runs once per finished job and never for a detached one", async () => {
		const settled: string[] = [];
		const ended = setup(base(), { onSettled: (taskId, outcome) => void settled.push(`${taskId}:${outcome.type}`) });
		await ended.run();
		await ended.run({ budget: undefined });
		assert.deepEqual(settled, ["task_1:completed", "task_1:failed"]);
		const detached = setup(base(), { onSettled: () => void settled.push("detached?") }, { outcome: "detach" });
		assert.equal((await detached.run()).type, "detach");
		assert.deepEqual(settled, ["task_1:completed", "task_1:failed"]);
	});

	it("hooks get the role's execution environment factory", async () => {
		let factory: ((cwd?: string) => unknown) | undefined;
		const { run, envUsed } = setup(base(), { result: (_base, ctx) => void (factory = ctx.envFor) });
		await run();
		factory!("/somewhere");
		assert.deepEqual(envUsed, ["/somewhere"]);
	});

	it("an unknown ref is a clear, non-retryable refusal and the model never runs", async () => {
		const { run, requests, metrics, remote, logs } = setup(base(), {});
		const outcome = await run({ repository: { url: remote, ref: "no-such-branch" } });
		assert.deepEqual([outcome.type, outcome.failure.code, outcome.failure.retryable], ["failed", "ref_not_found", false]);
		assert.match(outcome.failure.message, /no-such-branch/);
		assert.equal(requests.length, 0);
		assert.match(metrics.render(), /somework_pi_jobs_total\{status="ref_not_found"\} 1/);
		assert.ok(logs.some((l) => l.event === "job_refused" && l.fields.reason === "ref_not_found"));
	});

	it("repository.ref may be a commit SHA: a read-only role gets it detached, a developer branches from it and targets baseRef", async () => {
		const sha = (remote: string) => execFileSync("git", ["rev-parse", "main"], { cwd: remote, encoding: "utf8" }).trim();
		const readOnly = setup(base({ git: { push: false, pullRequest: false, branchPrefix: "review" } }), {});
		const ro = await readOnly.run({ repository: { url: readOnly.remote, ref: sha(readOnly.remote) } });
		assert.equal(ro.result.status, "completed");
		assert.equal(execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: readOnly.requests[0]!.workspace, encoding: "utf8" }).trim(), "HEAD", "detached");

		const developer = setup(base(), {});
		const done = await developer.run({ repository: { url: developer.remote, ref: sha(developer.remote), baseRef: "main" } });
		assert.equal(done.result.branch, "agent/task_1");
		assert.equal(developer.host.created[0]!.base, "main");
	});

	it("refuses a baseRef that is not a string before doing any work", async () => {
		const { run, requests } = setup(base(), {});
		assert.equal((await run({ repository: { url: "u", ref: "main", baseRef: 7 } })).failure.code, "invalid_input");
		assert.equal(requests.length, 0);
	});
});

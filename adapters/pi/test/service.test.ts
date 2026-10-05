import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { sleep, Worker, type Handler, type SomeWorkClient } from "@somework/sdk";
import { scriptedModels } from "../src/fake-model.ts";
import { DailyLedger } from "../src/ledger.ts";
import { Metrics } from "../src/metrics.ts";
import { PiDurableRuntime } from "../src/pi-runtime.ts";
import { approvalPolicy } from "../src/policy.ts";
import { createHandler, type HandlerDeps } from "../src/service.ts";
import { type ShardTable } from "../src/shards.ts";
import { startDomain, type Domain } from "../../../sdk/typescript/test/harness.ts";
import { FakeHost, makeRemote, sh } from "./fakes.ts";

const here = new URL(".", import.meta.url).pathname;
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface Stack {
	domain: Domain;
	remote: string;
	host: FakeHost;
	runtime: PiDurableRuntime;
	metrics: Metrics;
	startWorker(): { stop(): Promise<void> };
	submit(over?: Record<string, unknown>): Promise<string>;
	terminal(taskId: string, ms?: number): Promise<any>;
	author: SomeWorkClient;
	workspaceRoot: string;
}

async function stack(plan: string[], extra: Partial<HandlerDeps> = {}, wrap: (inner: Handler) => Handler = (inner) => inner): Promise<Stack> {
	const domain = await startDomain({ cardFile: join(here, "../card.json") });
	cleanups.push(() => domain.stop());
	const { remote } = makeRemote();
	const dir = mkdtempSync(join(tmpdir(), "pi-svc-"));
	const workspaceRoot = join(dir, "workspaces");
	const fake = scriptedModels(plan);
	const host = new FakeHost();
	const metrics = new Metrics();
	const env = (cwd: string | undefined) => new NodeExecutionEnv({ cwd: cwd ?? workspaceRoot });
	const runtime = new PiDurableRuntime({ storagePath: join(dir, "pi.sqlite"), models: fake.models, model: fake.model, env, policy: approvalPolicy() });
	await runtime.start();
	cleanups.push(() => runtime.close());
	const author = domain.author;
	const handler = wrap(createHandler({
		runtime,
		session: { env: env(workspaceRoot), identity: { name: "Pi", email: "pi@test.invalid" } },
		host,
		workspaceRoot,
		client: domain.worker(),
		limits: { maxTokensCap: 5_000_000, maxMinutesCap: 60 },
		metrics,
		...extra,
	}));
	return {
		domain,
		remote,
		host,
		runtime,
		metrics,
		author,
		workspaceRoot,
		startWorker() {
			const abort = new AbortController();
			const finished = new Worker(domain.worker(), { handler, leaseSeconds: 2, shutdownGraceMs: 5000 }).run(abort.signal);
			const handle = {
				stop: async () => {
					abort.abort();
					await finished;
				},
			};
			cleanups.push(handle.stop);
			return handle;
		},
		async submit(over = {}) {
			const task = await author.submitTask({
				capability: { id: "code.agent", version: "1" },
				input: { repository: { url: remote, ref: "main" }, instruction: "add a feature", budget: { maxTokens: 1_000_000, maxMinutes: 5 }, ...over },
			});
			return task.taskId as string;
		},
		terminal: (taskId, ms = 40_000) => author.waitTerminal(taskId, ms),
	};
}

describe("Pi agent service", () => {
	it("runs a coding task end to end: branch, one commit, a pull request, and the patch as an artifact", async () => {
		const s = await stack(["write:feature.txt:new feature", "final:added feature.txt"]);
		s.startWorker();
		const taskId = await s.submit();
		const task = await s.terminal(taskId);
		assert.equal(task.state, "succeeded", JSON.stringify(task.failure));
		assert.equal(task.result.status, "completed");
		assert.equal(task.result.branch, `agent/${taskId}`);
		assert.equal(task.result.commits.length, 1);
		assert.equal(task.result.prUrl, `https://example.test/pr/agent/${taskId}`);
		assert.equal(task.result.summary, "added feature.txt");
		assert.equal(sh(s.remote, "rev-parse", `refs/heads/agent/${taskId}`).trim(), task.result.commits[0]);
		assert.equal(s.host.created.length, 1);
		assert.equal(task.resultArtifacts?.length, 1, "the patch is an artifact");
	});

	it("a worker shutdown mid-run detaches; the retry re-attaches and the effects happen exactly once", async () => {
		const s = await stack(["bash:sleep 2", "write:once.txt:written", "final:done"]);
		const first = s.startWorker();
		const taskId = await s.submit();
		for (let i = 0; i < 100 && (await s.author.getTask(taskId)).state !== "running"; i++) await sleep(100);
		await sleep(600);
		await first.stop();
		assert.notEqual((await s.author.getTask(taskId)).state, "succeeded");
		s.startWorker();
		const task = await s.terminal(taskId);
		assert.equal(task.state, "succeeded", JSON.stringify(task.failure));
		assert.equal(task.attempt, 2);
		assert.equal(task.result.commits.length, 1, "one commit");
		assert.equal(s.host.created.length, 1, "one pull request");
	});

	it("when the finished outcome is lost before it is committed, the retry re-attaches and nothing is done twice", async () => {
		let lost = false;
		const s = await stack(["write:lost.txt:once", "final:done"], {}, (inner) => async (job, control) => {
			const outcome = await inner(job, control);
			if (!lost) {
				lost = true; // the process "dies" after the branch was pushed but before the SDK committed the result
				return { type: "detach" };
			}
			return outcome;
		});
		s.startWorker();
		const task = await s.terminal(await s.submit());
		assert.equal(task.state, "succeeded", JSON.stringify(task.failure));
		assert.equal(task.attempt, 2);
		assert.equal(task.result.commits.length, 1, "no second commit");
		assert.equal(s.host.created.length, 1, "no second pull request");
	});

	it("rejects a job without a budget at submit time, and refuses one the daily budget cannot cover", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-ledger-"));
		const ledger = new DailyLedger(join(dir, "ledger.json"), 5000);
		ledger.record(4900);
		const s = await stack(["final:never runs"], { ledger });
		s.startWorker();
		await assert.rejects(() => s.submit({ budget: undefined }), /schema|validation|budget/i);
		const task = await s.terminal(await s.submit({ budget: { maxTokens: 50_000, maxMinutes: 5 } }));
		assert.equal(task.state, "failed");
		assert.equal(task.failure.code, "budget_exhausted");
	});

	it("refuses a key that belongs to another shard", async () => {
		const table: ShardTable = { shardCount: 2, owners: { "agent/someone-else": [[0, 1]] } };
		const s = await stack(["final:x"], { shards: { table, agentId: "agent/ts-worker" } });
		s.startWorker();
		const task = await s.terminal(await s.submit());
		assert.equal(task.state, "failed");
		assert.equal(task.failure.code, "wrong_shard");
	});

	for (const approved of [false, true]) {
		it(`asks the requester before a risky command and ${approved ? "runs" : "blocks"} it on ${approved ? "approval" : "denial"}`, async () => {
			const s = await stack(["bash:sudo touch /tmp/ignored 2>/dev/null; echo risky > risky.txt", "final:done"]);
			s.startWorker();
			const taskId = await s.submit();
			let waiting: any;
			for (let i = 0; i < 150 && waiting?.state !== "input_required"; i++) {
				await sleep(100);
				waiting = await s.author.getTask(taskId);
			}
			assert.equal(waiting.state, "input_required", "the task is waiting for an approval");
			await s.author.provideInput(taskId, { approved, reason: approved ? undefined : "too risky" });
			const task = await s.terminal(taskId);
			assert.equal(task.state, "succeeded", JSON.stringify(task.failure));
			const ws = (await import("node:fs")).readdirSync(s.workspaceRoot).map((d) => join(s.workspaceRoot, d, "risky.txt"));
			assert.equal(ws.some((p) => existsSync(p)), approved, approved ? "the approved command ran" : "the denied command did not run");
			assert.match(s.metrics.render(), new RegExp(`somework_pi_approvals_total\\{decision="${approved ? "approved" : "denied"}"\\} 1`));
		});
	}

	it("a requester cancel stops the run and the task ends canceled", async () => {
		const s = await stack(["bash:sleep 60", "final:x"]);
		s.startWorker();
		const taskId = await s.submit();
		for (let i = 0; i < 100 && (await s.author.getTask(taskId)).state !== "running"; i++) await sleep(100);
		await sleep(800);
		const started = Date.now();
		await s.author.cancelTask(taskId, "changed my mind");
		const task = await s.terminal(taskId, 20_000);
		assert.equal(task.state, "canceled");
		assert.ok(Date.now() - started < 15_000, "did not wait for the 60 s sleep");
		assert.match(s.metrics.render(), /somework_pi_jobs_total\{status="cancel_requested"\} 1/);
	});

	it("exports job, token and tool metrics", async () => {
		const s = await stack(["write:m.txt:x", "final:ok"]);
		s.startWorker();
		await s.terminal(await s.submit());
		const text = s.metrics.render();
		assert.match(text, /somework_pi_jobs_total\{status="done"\} 1/);
		assert.match(text, /somework_pi_tokens_total\{kind="input"\} [1-9]/);
		assert.match(text, /somework_pi_tool_calls_total\{tool="write"\} 1/);
		assert.match(text, /somework_pi_job_duration_seconds_count\{status="done"\} 1/);
	});
});

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { sleep } from "@somework/sdk";
import type { Handler, Outcome } from "@somework/agent-kit";
import { createHandler, DailyLedger, Metrics, PiDurableRuntime, approvalPolicy, type HandlerDeps, type ShardTable } from "@somework/agent-kit";
import { scriptedModels } from "@somework/agent-kit/providers/faux";
import { FakeHost, jobRig, makeRemote, runHandler, sh } from "@somework/agent-kit/testing";
import { profile } from "../src/profile.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface Stack {
	remote: string;
	host: FakeHost;
	runtime: PiDurableRuntime;
	metrics: Metrics;
	rig: ReturnType<typeof jobRig>;
	run(over?: Record<string, unknown>, options?: Parameters<typeof runHandler>[2], taskId?: string): Promise<Outcome>;
	workspaceRoot: string;
}

async function stack(plan: string[], extra: Partial<HandlerDeps> = {}, wrap: (inner: Handler) => Handler = (inner) => inner): Promise<Stack> {
	const { remote } = makeRemote();
	const dir = mkdtempSync(join(tmpdir(), "pi-svc-"));
	const workspaceRoot = join(dir, "workspaces");
	const fake = scriptedModels(plan);
	const host = new FakeHost();
	const metrics = new Metrics();
	const rig = jobRig({ stateDir: dir });
	const env = (cwd: string | undefined) => new NodeExecutionEnv({ cwd: cwd ?? workspaceRoot });
	const runtime = new PiDurableRuntime({ storagePath: join(dir, "pi.sqlite"), models: fake.models, model: fake.model, env, policy: approvalPolicy() });
	await runtime.start();
	cleanups.push(() => runtime.close());
	const handler = wrap(createHandler({
		runtime,
		session: { env: env(workspaceRoot), identity: { name: "Pi", email: "pi@test.invalid" } },
		host,
		workspaceRoot,
		client: rig.client,
		limits: { maxTokensCap: 5_000_000, maxMinutesCap: 60 },
		metrics,
		profile,
		...extra,
	}));
	return {
		remote,
		host,
		runtime,
		metrics,
		rig,
		workspaceRoot,
		run: (over = {}, options, taskId) =>
			runHandler(
				handler,
				{ capability: { id: "code.agent", version: "1" }, input: { repository: { url: remote, ref: "main" }, instruction: "add a feature", budget: { maxTokens: 1_000_000, maxMinutes: 5 }, ...over }, ...(taskId ? { taskId } : {}) },
				options,
			),
	};
}

/** The result of a job that completed; fails the test with the failure otherwise. */
function completed(outcome: Outcome): { result: any; artifacts: unknown[] } {
	assert.equal(outcome.type, "completed", JSON.stringify(outcome));
	const done = outcome as Extract<Outcome, { type: "completed" }>;
	return { result: done.result, artifacts: done.artifacts ?? [] };
}

const failure = (outcome: Outcome) => {
	assert.equal(outcome.type, "failed", JSON.stringify(outcome));
	return (outcome as Extract<Outcome, { type: "failed" }>).failure;
};

describe("Pi agent service", () => {
	it("runs a coding job end to end: branch, one commit, a pull request, and the patch as an artifact", async () => {
		const s = await stack(["write:feature.txt:new feature", "final:added feature.txt"]);
		const { result, artifacts } = completed(await s.run({}, {}, "job-first"));
		assert.equal(result.status, "completed");
		assert.equal(result.branch, "agent/job-first");
		assert.equal(result.commits.length, 1);
		assert.equal(result.prUrl, "https://example.test/pr/agent/job-first");
		assert.equal(result.summary, "added feature.txt");
		assert.equal(sh(s.remote, "rev-parse", "refs/heads/agent/job-first").trim(), result.commits[0]);
		assert.equal(s.host.created.length, 1);
		assert.equal(artifacts.length, 1, "the patch is an artifact");
		assert.ok(s.rig.domain.uploaded.some((name) => name.endsWith(".diff")));
	});

	it("a shutdown mid-run detaches; the retry of the same job re-attaches and the effects happen exactly once", async () => {
		const s = await stack(["bash:sleep 2", "write:once.txt:written", "final:done"]);
		const stop = new AbortController();
		const first = s.run({}, { signal: stop.signal }, "job-retry");
		await sleep(900);
		stop.abort("shutdown");
		assert.deepEqual(await first, { type: "detach" });
		const { result } = completed(await s.run({}, {}, "job-retry"));
		assert.equal(result.commits.length, 1, "one commit");
		assert.equal(s.host.created.length, 1, "one pull request");
	});

	it("when the finished outcome is lost before it is reported, the retry re-attaches and nothing is done twice", async () => {
		let lost = false;
		const s = await stack(["write:lost.txt:once", "final:done"], {}, (inner) => async (job, control) => {
			const outcome = await inner(job, control);
			if (!lost) {
				lost = true; // the process "dies" after the branch was pushed but before the result was reported
				return { type: "detach" };
			}
			return outcome;
		});
		assert.deepEqual(await s.run({}, {}, "job-lost"), { type: "detach" });
		const { result } = completed(await s.run({}, {}, "job-lost"));
		assert.equal(result.commits.length, 1, "no second commit");
		assert.equal(s.host.created.length, 1, "no second pull request");
	});

	it("refuses a job without a budget, and one the daily budget cannot cover", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-ledger-"));
		const ledger = new DailyLedger(join(dir, "ledger.json"), 5000);
		ledger.record(4900);
		const s = await stack(["final:never runs"], { ledger });
		assert.equal(failure(await s.run({ budget: undefined })).code, "budget_required");
		assert.equal(failure(await s.run({ budget: { maxTokens: 50_000, maxMinutes: 5 } })).code, "budget_exhausted");
	});

	it("refuses a key that belongs to another shard", async () => {
		const table: ShardTable = { shardCount: 2, owners: { "agent/someone-else": [[0, 1]] } };
		const s = await stack(["final:x"], { shards: { table, agentId: "agent/ts-worker" } });
		assert.equal(failure(await s.run()).code, "wrong_shard");
	});

	for (const approved of [false, true]) {
		it(`asks before a risky command and ${approved ? "runs" : "blocks"} it on ${approved ? "approval" : "denial"}`, async () => {
			const s = await stack(["bash:sudo touch /tmp/ignored 2>/dev/null; echo risky > risky.txt", "final:done"]);
			const asked: { tool: string; summary: string }[] = [];
			completed(
				await s.run({}, { approve: (question) => (asked.push(question), { approved, reason: approved ? undefined : "too risky" }) }),
			);
			assert.equal(asked.length, 1, "the job asked for an approval");
			assert.equal(asked[0]!.tool, "bash");
			const ws = readdirSync(s.workspaceRoot).map((d) => join(s.workspaceRoot, d, "risky.txt"));
			assert.equal(ws.some((p) => existsSync(p)), approved, approved ? "the approved command ran" : "the denied command did not run");
			assert.match(s.metrics.render(), new RegExp(`somework_pi_approvals_total\\{decision="${approved ? "approved" : "denied"}"\\} 1`));
		});
	}

	it("a stop signal ends the run at once and the job fails as cancel_requested", async () => {
		const s = await stack(["bash:sleep 60", "final:x"]);
		const stop = new AbortController();
		const running = s.run({}, { signal: stop.signal });
		await sleep(900);
		const started = Date.now();
		stop.abort("cancel_requested");
		assert.equal(failure(await running).code, "cancel_requested");
		assert.ok(Date.now() - started < 15_000, "did not wait for the 60 s sleep");
		assert.match(s.metrics.render(), /somework_pi_jobs_total\{status="cancel_requested"\} 1/);
	});

	it("exports job, token and tool metrics", async () => {
		const s = await stack(["write:m.txt:x", "final:ok"]);
		completed(await s.run());
		const text = s.metrics.render();
		assert.match(text, /somework_pi_jobs_total\{status="done"\} 1/);
		assert.match(text, /somework_pi_tokens_total\{kind="input"\} [1-9]/);
		assert.match(text, /somework_pi_tool_calls_total\{tool="write"\} 1/);
		assert.match(text, /somework_pi_job_duration_seconds_count\{status="done"\} 1/);
	});
});

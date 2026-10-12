import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Type } from "@earendil-works/pi-ai";
import { Drain, DrainingError, drainFileIn } from "../src/drain.ts";
import { HandlerGuard } from "../src/events/guard.ts";
import { EventInbox } from "../src/events/inbox.ts";
import { resolveEvents } from "../src/events/config.ts";
import { EventProcessor, type EventActions } from "../src/events/processor.ts";
import { HandlerStore } from "../src/events/store.ts";
import type { FeedEvent } from "../src/events/types.ts";
import { JobGate } from "../src/gate.ts";
import { createHealthServer } from "../src/health.ts";
import { DailyLedger } from "../src/ledger.ts";
import { Metrics } from "../src/metrics.ts";
import { JobManager, type JobEntry, type JobSpec } from "../src/threads/jobs.ts";
import { MessageSender } from "../src/threads/message.ts";
import { ResourceRegistry } from "../src/threads/resources.ts";
import { buildState } from "../src/threads/state.ts";
import { DurableTable } from "../src/threads/store.ts";
import { createThreadTools, type JobTool, type RunContext } from "../src/threads/tools.ts";

const tmp = (): string => mkdtempSync(join(tmpdir(), "drain-"));
const tick = (ms = 5): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function flag() {
	const dir = tmp();
	const file = drainFileIn(dir);
	return { dir, file, raise: () => writeFileSync(file, ""), lower: () => rmSync(file, { force: true }) };
}

const gaugeValue = (metrics: Metrics): string | undefined => metrics.render().split("\n").find((line) => line.startsWith("somework_draining"))?.split(" ").pop();

describe("the drain flag", () => {
	it("is the file `drain` in the state directory, and is read whenever it is asked", () => {
		const { dir, file, raise, lower } = flag();
		assert.equal(file, join(dir, "drain"));
		const drain = new Drain({ file, metrics: new Metrics() });
		assert.equal(drain.active, false);
		raise();
		assert.equal(drain.active, true, "a flag raised after the agent started counts at once");
		lower();
		assert.equal(drain.active, false);
	});

	it("exports somework_draining as 0 and 1, and logs when the flag changes", () => {
		const { file, raise, lower } = flag();
		const metrics = new Metrics();
		const logs: string[] = [];
		const drain = new Drain({ file, metrics, log: (_level, event) => void logs.push(event) });
		assert.equal(gaugeValue(metrics), "0");
		raise();
		assert.equal(drain.active, true);
		assert.equal(gaugeValue(metrics), "1");
		assert.equal(drain.active, true);
		lower();
		assert.equal(drain.active, false);
		assert.equal(gaugeValue(metrics), "0");
		assert.deepEqual(logs, ["drain_started", "drain_ended"], "one line per change, not one per look");
	});

	it("starts drained when the file is already there, and says so", () => {
		const { file, raise } = flag();
		raise();
		const metrics = new Metrics();
		const logs: { event: string; fields?: Record<string, unknown> }[] = [];
		new Drain({ file, metrics, log: (_level, event, fields) => void logs.push({ event, fields }) });
		assert.equal(gaugeValue(metrics), "1");
		assert.deepEqual(logs.map((entry) => [entry.event, entry.fields?.atStart]), [["drain_started", true]]);
	});

	it("ignores a file that nobody touched for three hours, saying so once: a deployment that died must not leave the agent drained", () => {
		const { file, raise } = flag();
		raise();
		const metrics = new Metrics();
		const logs: string[] = [];
		const drain = new Drain({ file, metrics, log: (_level, event) => void logs.push(event) });
		assert.equal(drain.active, true);
		const fourHoursAgo = new Date(Date.now() - 4 * 3_600_000);
		utimesSync(file, fourHoursAgo, fourHoursAgo);
		assert.equal(drain.active, false);
		assert.equal(drain.active, false);
		assert.equal(gaugeValue(metrics), "0");
		assert.deepEqual(logs, ["drain_started", "drain_expired", "drain_ended"]);
		raise();
		utimesSync(file, new Date(), new Date());
		assert.equal(drain.active, true, "a file made again counts again");
	});

	it("keeps the metric current on its own while it is watched", async () => {
		const { file, raise, lower } = flag();
		const metrics = new Metrics();
		const stop = new AbortController();
		new Drain({ file, metrics }).watch(stop.signal, 10);
		raise();
		await tick(60);
		assert.equal(gaugeValue(metrics), "1");
		lower();
		await tick(60);
		assert.equal(gaugeValue(metrics), "0");
		stop.abort();
	});
});

const spec = (label: string): JobSpec => ({ capability: { id: "test.verify", version: "1" }, input: { ticket: label }, label, requestedBy: { kind: "human", id: "user/jimmy" }, conversationId: "conv_1", replyTo: "msg_1", source: "message" });

function jobRig(draining: () => boolean, handler: () => Promise<any> = async () => ({ type: "completed", result: {} })) {
	const file = join(tmp(), "jobs.json");
	const build = () =>
		new JobManager({
			handler,
			resources: new ResourceRegistry(),
			gate: new JobGate(4),
			store: new DurableTable<JobEntry>(file),
			reporter: { waiting: async () => undefined, started: async () => undefined, finished: async () => undefined },
			takeArtifacts: () => [],
			steer: async () => true,
			approve: async () => ({ approved: true }),
			budget: { maxTokens: 1000, maxMinutes: 1 },
			draining,
		});
	return { manager: build(), build };
}

describe("jobs while the agent drains", () => {
	it("starts no new job, and starts it again once the drain is over", async () => {
		const { file, raise, lower } = flag();
		const { manager } = jobRig(() => new Drain({ file, metrics: new Metrics() }).active);
		raise();
		assert.throws(() => manager.start(spec("SAD-1")), DrainingError);
		assert.deepEqual(manager.active(), [], "nothing was recorded either");
		lower();
		const entry = manager.start(spec("SAD-1"));
		await manager.idle();
		assert.equal(manager.get(entry.id)?.end?.kind, "completed");
	});

	it("lets the jobs that already run finish normally", async () => {
		let drained = false;
		let finish: () => void = () => undefined;
		const { manager } = jobRig(
			() => drained,
			() => new Promise((resolve) => (finish = () => resolve({ type: "completed", result: { summary: "done" } }))),
		);
		const entry = manager.start(spec("SAD-2"));
		await tick();
		assert.equal(manager.get(entry.id)?.state, "running");
		drained = true;
		assert.throws(() => manager.start(spec("SAD-3")), DrainingError);
		finish();
		await manager.idle();
		assert.equal(manager.get(entry.id)?.end?.kind, "completed");
		assert.equal(manager.get(entry.id)?.end?.summary, "done");
	});

	it("returns the job a request already started, and takes up unfinished jobs after a restart", async () => {
		let drained = false;
		const never = () => new Promise<never>(() => undefined);
		const first = jobRig(() => drained, never);
		const entry = first.manager.start(spec("SAD-4"), "job-fixed");
		await tick();
		drained = true;
		assert.equal(first.manager.start(spec("SAD-4"), "job-fixed").id, entry.id, "the same request is not refused");
		const second = first.build();
		assert.deepEqual(second.recover().map((job) => job.id), ["job-fixed"], "a job left unfinished is not new work");
	});
});

describe("the job tools while the agent drains", () => {
	const context: RunContext = { conversationId: "conv 1", messageId: "m1", sender: { kind: "human", id: "user/jimmy" }, audience: [{ kind: "human", id: "user/jimmy" }] };

	function toolRig() {
		let drained = true;
		const { manager } = jobRig(() => drained);
		const posts: any[] = [];
		const demo: JobTool = { name: "start_demo", description: "Run the demo.", parameters: Type.Object({ topic: Type.String() }), plan: (args: { topic: string }) => ({ capability: { id: "demo.run", version: "1" }, input: { topic: args.topic }, label: `demo ${args.topic}` }) };
		const { extension } = createThreadTools(
			{
				context: () => context,
				saveAttachment: async () => ({ path: "/scratch/a", bytes: 1 }),
				jobs: () => manager,
				resources: () => new ResourceRegistry(),
				sender: () => new MessageSender({ post: async (_path: string, body: any) => void posts.push(body) } as any),
			},
			[demo],
		);
		const call = async (name: string, args: unknown) => {
			const tool = (extension.tools as readonly any[]).find((candidate) => candidate.name === name);
			const result = await tool.execute(args, { conversationId: 7 }, {});
			return { error: result.isError === true, text: result.content[0].text as string };
		};
		return { call, manager, posts, finishDrain: () => void (drained = false) };
	}

	it("refuse to start a job and tell the model why", async () => {
		const { call, manager, finishDrain } = toolRig();
		const refused = await call("start_demo", { topic: "x" });
		assert.equal(refused.error, true);
		assert.match(refused.text, /^not started: this agent is draining for a deployment/);
		assert.deepEqual(manager.active(), []);
		finishDrain();
		assert.equal((await call("start_demo", { topic: "x" })).error, false);
	});

	it("leave the tools that only look or talk alone", async () => {
		const { call } = toolRig();
		assert.equal((await call("job_status", {})).error, false);
		assert.equal((await call("resources", {})).error, false);
	});

	it("do not hide from the model that the agent drains", async () => {
		const sources = { agentId: "agent/test", role: "test", capabilities: [{ id: "demo.run", version: "1" }], ledger: { usage: () => ({ tasks: { used: 0, limit: 10 } }) as any } };
		assert.match(await buildState({ ...sources, draining: () => true }), /^draining: yes .*chat still works/m);
		assert.doesNotMatch(await buildState({ ...sources, draining: () => false }), /draining/);
		assert.doesNotMatch(await buildState(sources), /draining/);
	});
});

const agent = { id: "agent/test", role: "test", capabilities: [{ id: "code.review", version: "3" }] };
const feed = (n: number, over: Partial<FeedEvent> = {}): FeedEvent => ({
	seq: n,
	eventId: `evt_${n}`,
	type: "github.pull_request.opened",
	wake: true,
	createdAt: new Date().toISOString(),
	payload: { topic: "github.pull_request.opened", source: "github", key: `k${n}`, data: { n }, classification: "internal", verified: true, depth: 0 },
	...over,
});

function eventRig(draining: () => boolean) {
	const dir = tmp();
	const config = resolveEvents({ enabled: true }, {});
	const store = new HandlerStore(join(dir, "handlers"));
	store.save("h", "export default async () => ({ action: 'wake' });\n");
	const guard = new HandlerGuard(store, { maxConsecutiveFailures: config.maxConsecutiveFailures, maxWakesPerHour: config.maxWakesPerHour });
	const inbox = new EventInbox(join(dir, "events"));
	const calls = { wake: 0, submit: 0, handlerRuns: 0 };
	const actions: EventActions = {
		wake: async () => (calls.wake++, { tokens: 1 }),
		submit: async () => (calls.submit++, { jobId: "job-1" }),
		notify: async () => undefined,
	};
	const runner = { run: async () => (calls.handlerRuns++, { ok: true as const, decision: { action: "wake" }, ms: 1, stderr: "" }) };
	const logs: { event: string; fields?: any }[] = [];
	const metrics = new Metrics();
	const ledger = new DailyLedger(join(dir, "ledger.json"), 1000, () => "2026-10-12", { share: config.tokenShare, throttleAt: config.throttleAt });
	const processor = new EventProcessor({ config, store, runner, guard, ledger, inbox, actions, agent, log: (_level, event, fields) => void logs.push({ event, fields }), metrics, draining });
	return { processor, guard, inbox, calls, logs, metrics };
}

describe("events while the agent drains", () => {
	it("are dropped with the reason draining: no handler runs, nothing wakes the agent, and the event stays readable in the inbox", async () => {
		const { processor, guard, inbox, calls, logs, metrics } = eventRig(() => true);
		assert.equal(await processor.process(feed(1)), "dropped");
		assert.deepEqual(calls, { wake: 0, submit: 0, handlerRuns: 0 });
		assert.equal(guard.samples()[0]?.reason, "draining");
		assert.equal(logs.find((entry) => entry.event === "event_dropped")?.fields.reason, "draining");
		assert.match(inbox.recent()[0]!.why, /draining/);
		assert.match(metrics.render(), /somework_events_total\{result="dropped"\} 1/);
	});

	it("are handled as before once the drain is over", async () => {
		let drained = true;
		const { processor, calls } = eventRig(() => drained);
		assert.equal(await processor.process(feed(1)), "dropped");
		drained = false;
		assert.equal(await processor.process(feed(2)), "woken");
		assert.equal(calls.wake, 1);
	});

	it("that only record something are recorded as usual, because they start no work", async () => {
		const { processor, inbox, calls } = eventRig(() => true);
		assert.equal(await processor.process(feed(1, { wake: false })), "recorded");
		assert.equal(inbox.recent()[0]!.why, "delivered without wake");
		assert.equal(calls.handlerRuns, 0);
	});
});

describe("the health endpoints while the agent drains", () => {
	async function get(server: Server, path: string): Promise<{ status: number; body: any }> {
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const { port } = server.address() as AddressInfo;
		try {
			const response = await fetch(`http://127.0.0.1:${port}${path}`);
			return { status: response.status, body: await response.json() };
		} finally {
			server.close();
		}
	}
	const base = { runtime: { health: () => ({ ready: true }) } as any, metrics: new Metrics(), status: () => ({ handlers: [] }) };

	it("/ready stays 200 and /status says draining: true", async () => {
		const ready = await get(createHealthServer({ ...base, draining: () => true }), "/ready");
		assert.equal(ready.status, 200);
		assert.equal(ready.body.ready, true);
		assert.equal(ready.body.draining, true);
		const status = await get(createHealthServer({ ...base, draining: () => true }), "/status");
		assert.deepEqual(status.body, { handlers: [], draining: true });
	});

	it("/status says draining: false when it does not", async () => {
		assert.deepEqual((await get(createHealthServer({ ...base, draining: () => false }), "/status")).body, { handlers: [], draining: false });
	});

	it("exposes the metric on /metrics", async () => {
		const metrics = new Metrics();
		const { file, raise } = flag();
		raise();
		new Drain({ file, metrics });
		const server = createHealthServer({ ...base, metrics });
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const { port } = server.address() as AddressInfo;
		const text = await (await fetch(`http://127.0.0.1:${port}/metrics`)).text();
		server.close();
		assert.match(text, /^somework_draining 1$/m);
	});

	it("has no way to start or end a drain over HTTP: the health port has no authentication, so the file is the only switch", async () => {
		const server = createHealthServer({ ...base, draining: () => false });
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const { port } = server.address() as AddressInfo;
		for (const method of ["POST", "DELETE", "PUT"]) assert.equal((await fetch(`http://127.0.0.1:${port}/drain`, { method })).status, 404, method);
		server.close();
	});
});

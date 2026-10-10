import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Type } from "@earendil-works/pi-ai";
import { JobGate } from "../src/gate.ts";
import { JobManager, type JobEntry } from "../src/threads/jobs.ts";
import { MessageSender } from "../src/threads/message.ts";
import { ResourceRegistry } from "../src/threads/resources.ts";
import { DurableTable } from "../src/threads/store.ts";
import { createThreadTools, describeJob, jobId, threadKey, type JobTool, type RunContext } from "../src/threads/tools.ts";

const context: RunContext = { conversationId: "conv 1", messageId: "m1", sender: { kind: "human", id: "user/jimmy" }, audience: [{ kind: "human", id: "user/jimmy" }] };
const tick = (ms = 5): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function rig(handler: () => Promise<any> = async () => ({ type: "completed", result: {} })) {
	const posts: any[] = [];
	const saved: any[] = [];
	const resources = new ResourceRegistry();
	const jobs = new JobManager({
		handler,
		resources,
		gate: new JobGate(2),
		store: new DurableTable<JobEntry>(join(mkdtempSync(join(tmpdir(), "tools-")), "jobs.json")),
		reporter: { waiting: async () => undefined, started: async () => undefined, finished: async () => undefined },
		takeArtifacts: () => [],
		steer: async () => true,
		approve: async () => ({ approved: true }),
		budget: { maxTokens: 1000, maxMinutes: 1 },
		resourcesFor: (capability) => (capability === "demo.run" ? ["demo-stack"] : undefined),
	});
	const sender = new MessageSender({ post: async (_path: string, body: any) => void posts.push(body) } as any);
	const demo: JobTool = {
		name: "start_demo",
		description: "Run the demo.",
		parameters: Type.Object({ topic: Type.String() }),
		plan: (args: { topic: string }) => (args.topic === "bad" ? { refuse: "no such topic" } : { capability: { id: "demo.run", version: "1" }, input: { topic: args.topic }, label: `demo ${args.topic}` }),
	};
	const { extension, toolNames } = createThreadTools(
		{
			context: (id) => (id === (7 as unknown) ? context : undefined),
			saveAttachment: async (_context, request) => (saved.push(request), { path: `/scratch/${request.name ?? request.artifactId}`, bytes: 12 }),
			jobs: () => jobs,
			resources: () => resources,
			sender: () => sender,
		},
		[demo],
	);
	const call = async (name: string, args: unknown, conversationId: unknown = 7) => {
		const tool = (extension.tools as readonly any[]).find((candidate) => candidate.name === name);
		const result = await tool.execute(args, { conversationId }, {});
		return { error: result.isError === true, text: result.content[0].text as string };
	};
	return { call, jobs, posts, saved, toolNames, resources };
}

describe("the thread tools", () => {
	it("offers the role's job tools next to the kit's", () => {
		assert.deepEqual(rig().toolNames, ["start_demo", "job_status", "job_stop", "resources", "message_send", "attachment_get"]);
	});

	it("starts a job at once, for the sender of the message, in its conversation, holding the resources the role names", async () => {
		const { call, jobs, resources } = rig(() => new Promise(() => undefined));
		const started = await call("start_demo", { topic: "x" });
		assert.equal(started.error, false);
		assert.match(started.text, /^Started job-[0-9a-f]{12} \(demo x, asked by user\/jimmy\)/);
		await tick();
		const [entry] = jobs.active();
		assert.equal(entry!.conversationId, "conv 1");
		assert.equal(entry!.replyTo, "m1");
		assert.deepEqual(entry!.audience, context.audience);
		assert.deepEqual(entry!.resources, ["demo-stack"]);
		assert.deepEqual(resources.holders().map((hold) => hold.resource), ["demo-stack"]);
	});

	it("does not start the same work twice when a call is replayed", async () => {
		const { call, jobs } = rig(() => new Promise(() => undefined));
		await call("start_demo", { topic: "x" });
		await call("start_demo", { topic: "x" });
		await call("start_demo", { topic: "y" });
		assert.equal(jobs.active().length, 2);
		assert.equal(jobId("m1", { capability: { id: "demo.run", version: "1" }, input: { topic: "x" }, label: "a" }), jobId("m1", { capability: { id: "demo.run", version: "1" }, input: { topic: "x" }, label: "b" }));
	});

	it("tells the model why a job was not started, and that a call outside a conversation cannot start one", async () => {
		const { call, jobs } = rig();
		assert.deepEqual(await call("start_demo", { topic: "bad" }), { error: true, text: "not started: no such topic" });
		assert.match((await call("start_demo", { topic: "x" }, 99)).text, /not part of a conversation/);
		assert.equal(jobs.active().length, 0);
	});

	it("lists the jobs, one job, and says when there is none", async () => {
		const { call } = rig(() => new Promise(() => undefined));
		assert.match((await call("job_status", {})).text, /Active \(0\):\n\(none\)/);
		const id = /Started (job-\w+)/.exec((await call("start_demo", { topic: "x" })).text)![1]!;
		await tick();
		assert.match((await call("job_status", {})).text, new RegExp(`Active \\(1\\):\\n${id} \\(demo x, asked by user/jimmy\\): running`));
		assert.match((await call("job_status", { job: id })).text, /running for/);
		assert.equal((await call("job_status", { job: "job-nope" })).error, true);
	});

	it("passes a stop on as a signal: a job that has not started does not start, a running one is told", async () => {
		const { call, jobs, resources } = rig(() => new Promise(() => undefined));
		await call("start_demo", { topic: "first" });
		await tick();
		await call("start_demo", { topic: "second" });
		await tick();
		const waiting = jobs.active().find((entry) => entry.label === "demo second")!;
		const running = jobs.active().find((entry) => entry.label === "demo first")!;
		assert.equal(waiting.state, "waiting");
		assert.match((await call("job_stop", { job: waiting.id })).text, /will not run/);
		assert.match((await call("job_stop", { job: running.id, reason: "wrong ticket" })).text, /model was told/);
		assert.equal((await call("job_stop", { job: "job-nope" })).error, true);
		assert.equal(resources.holders().length, 1, "the running job still holds its resource: its model decides");
	});

	it("shows who holds a resource and who waits", async () => {
		const { call } = rig(() => new Promise(() => undefined));
		assert.equal((await call("resources", {})).text, "No resource is held.");
		await call("start_demo", { topic: "first" });
		await tick();
		await call("start_demo", { topic: "second" });
		await tick();
		const text = (await call("resources", {})).text;
		assert.match(text, /demo-stack: held by demo first/);
		assert.match(text, /Waiting:\n.* waits for demo-stack/);
	});

	it("writes to somebody else, caused by the message it is answering, once", async () => {
		const { call, posts } = rig();
		const args = { to: [{ kind: "agent", id: "agent/reviewer" }], text: "please review PR 5" };
		assert.match((await call("message_send", args)).text, /Sent to agent\/reviewer/);
		await call("message_send", args);
		assert.equal(posts.length, 2, "the domain deduplicates by the key");
		assert.equal(posts[0].causationId, "m1");
		assert.deepEqual(posts[0].recipients, args.to);
		assert.equal(posts[0].triggerMode, "directed");
		assert.equal(posts[0].content.data, "please review PR 5");
		assert.match((await call("message_send", { to: [{ kind: "agent", id: "a" }, { kind: "agent", id: "b" }], text: "x" })).text, /conversationId/);
	});

	it("saves an attachment into the scratch directory of the conversation", async () => {
		const { call, saved } = rig();
		assert.equal((await call("attachment_get", { artifactId: "art_1", name: "report.pdf" })).text, "Saved 12 bytes to /scratch/report.pdf.");
		assert.deepEqual(saved, [{ artifactId: "art_1", name: "report.pdf" }]);
		assert.match((await call("attachment_get", { artifactId: "art_1" }, 99)).text, /not part of a conversation/);
	});

	it("names the scratch directory of a conversation safely", () => {
		assert.equal(threadKey(context), "conv_1");
		assert.equal(threadKey({ messageId: "msg/../x" }), "msg_x");
	});

	it("describes a job in one line", () => {
		const entry: JobEntry = { id: "job-1", state: "waiting", createdAt: 0, label: "verify X", capability: { id: "a", version: "1" }, input: {}, requestedBy: { kind: "human", id: "user/jimmy" }, source: "message", waitingFor: "app-stack (held by verify Y)" };
		assert.equal(describeJob(entry, 120_000), "job-1 (verify X, asked by user/jimmy): waiting for app-stack (held by verify Y) since 2 min");
	});
});

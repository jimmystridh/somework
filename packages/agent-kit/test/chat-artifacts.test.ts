import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { SomeWorkError, type Job, type JobControl } from "@somework/sdk";
import { ChatArtifacts, describeCaptured, isChatTask, type CapturedArtifact } from "../src/chat-artifacts.ts";
import { ModelChatResponder, DEFAULT_CHAT_MODEL } from "../src/chat-model.ts";
import { ChatApprovals } from "../src/chat-model.ts";
import { JobGate } from "../src/gate.ts";
import { createHandler } from "../src/handler.ts";
import { DailyLedger } from "../src/ledger.ts";
import type { AgentProfile } from "../src/profile.ts";
import type { AgentRuntime } from "../src/runtime.ts";
import { FakeHost, makeRemote } from "../src/testing.ts";

/** A domain that has no task named `chat-...`: any call that is bound to one is a 404, as the real domain answers. */
class FakeDomain {
	calls: string[] = [];
	uploaded: string[] = [];
	#secret = "kept";
	async uploadArtifact(options: { filename: string; sourceTaskId?: string }): Promise<any> {
		this.calls.push(`upload ${options.filename} for ${options.sourceTaskId}`);
		if (options.sourceTaskId?.startsWith("chat-")) throw new SomeWorkError(404, "not_found", "task not found");
		this.uploaded.push(options.filename);
		return { artifactId: `art_${this.uploaded.length}`, uri: `s3://x/${options.filename}` };
	}
	async post(path: string, body?: unknown): Promise<any> {
		this.calls.push(`POST ${path}`);
		if (/\/tasks\/chat-/.test(path)) throw new SomeWorkError(404, "not_found", "task not found");
		return { ok: true, secret: this.#secret, body };
	}
	async get(path: string): Promise<any> {
		this.calls.push(`GET ${path}`);
		if (/\/tasks\/chat-/.test(path)) throw new SomeWorkError(404, "not_found", "task not found");
		return { ok: true };
	}
}

const stateDir = () => mkdtempSync(join(tmpdir(), "chat-artifacts-"));

describe("the client of a chat job", () => {
	it("recognises the synthetic task of an instruction", () => {
		assert.ok(isChatTask("chat-msg_1"));
		assert.ok(!isChatTask("task_1"));
		assert.ok(!isChatTask(undefined));
	});

	it("keeps an upload for a chat job on the host instead of asking the domain, and the role gets an artifact reference", async () => {
		const domain = new FakeDomain();
		const artifacts = new ChatArtifacts({ dir: stateDir() });
		const client = artifacts.wrap(domain);
		const ref = await client.uploadArtifact({ filename: "chat-m1-review.md", mediaType: "text/markdown", bytes: "# report\nall fine", sourceTaskId: "chat-m1" });
		assert.deepEqual(domain.calls, [], "the domain was not asked");
		assert.match(ref.artifactId, /^inline:chat-m1:1$/);
		assert.equal(ref.uri, ref.artifactId);
		assert.equal(ref.sizeBytes, 17);
		const [captured] = artifacts.take("chat-m1");
		assert.equal(readFileSync(captured!.path!, "utf8"), "# report\nall fine");
		assert.equal(captured!.preview, "# report\nall fine");
		assert.deepEqual(artifacts.take("chat-m1"), [], "taken once");
	});

	it("leaves a real task's upload and every other call to the domain, with the client's own state intact", async () => {
		const domain = new FakeDomain();
		const client = new ChatArtifacts({ dir: stateDir() }).wrap(domain);
		assert.deepEqual(await client.uploadArtifact({ filename: "r.md", mediaType: "text/markdown", bytes: "x", sourceTaskId: "task_9" }), { artifactId: "art_1", uri: "s3://x/r.md" });
		assert.deepEqual(await client.uploadArtifact({ filename: "r.md", mediaType: "text/markdown", bytes: "x" }), { artifactId: "art_2", uri: "s3://x/r.md" });
		assert.equal((await client.post("/v1/messages", {})).secret, "kept", "private fields still work through the wrapper");
		assert.deepEqual((await client.get("/v1/tasks/task_9")) as object, { ok: true });
	});

	it("skips any call bound to a chat job's task, so nothing can 404 a chat job", async () => {
		const domain = new FakeDomain();
		const client = new ChatArtifacts({ dir: stateDir() }).wrap(domain);
		assert.deepEqual(await client.post("/v1/tasks/chat-m1/progress", { message: "x" }), {});
		assert.deepEqual(await client.get("/v1/tasks/chat-m1"), {});
		assert.deepEqual(domain.calls, []);
	});

	it("keeps only the latest few jobs' files and still names every artifact it kept", async () => {
		const artifacts = new ChatArtifacts({ dir: stateDir() });
		const client = artifacts.wrap(new FakeDomain());
		for (let i = 0; i < 14; i++) await client.uploadArtifact({ filename: "a.txt", mediaType: "text/plain", bytes: `job ${i}`, sourceTaskId: `chat-m${i}` });
		const kept = [0, 13].map((i) => artifacts.take(`chat-m${i}`)[0]!.path!);
		assert.ok(!existsSync(kept[0]!), "the oldest job's folder was removed");
		assert.ok(existsSync(kept[1]!));
	});
});

describe("what the reply says about a chat job's artifacts", () => {
	const text = (over: Partial<CapturedArtifact> = {}): CapturedArtifact => ({ filename: "review.md", mediaType: "text/markdown", sizeBytes: 11, path: "/state/chat-artifacts/chat-m1/1-review.md", preview: "# the text", ...over });

	it("shows a small text artifact whole and says that nothing was uploaded", () => {
		const out = describeCaptured([text()], 3000);
		assert.match(out, /^\nAttachments were not uploaded to the domain \(this was a chat instruction\):/);
		assert.match(out, /- review.md \(text\/markdown, 11 bytes\):\n# the text/);
		assert.ok(!out.includes("truncated"));
	});

	it("cuts a long text to the room there is, with a note that gives the size and where the full copy is", () => {
		const out = describeCaptured([text({ sizeBytes: 50_000, preview: "line\n".repeat(3000), previewTruncated: true })], 1000);
		assert.ok(Buffer.byteLength(out) <= 1000, `${Buffer.byteLength(out)}`);
		assert.match(out, /\[truncated: \d+ of 50000 bytes shown; full copy on the agent host at \/state\/chat-artifacts\/chat-m1\/1-review.md\]/);
	});

	it("names a binary artifact with where it stays, or why it was not kept", () => {
		const out = describeCaptured([{ filename: "run.webm", mediaType: "video/webm", sizeBytes: 18_000_000, path: "/state/chat-artifacts/chat-m1/1-run.webm" }, { filename: "huge.webm", mediaType: "video/webm", sizeBytes: 900_000_000, notKept: "larger than 200 MB" }], 2000);
		assert.match(out, /- run.webm \(video\/webm, 17.2 MB\): on the agent host at \/state\/chat-artifacts\/chat-m1\/1-run.webm/);
		assert.match(out, /- huge.webm \(video\/webm, 858.3 MB\): not kept \(larger than 200 MB\)/);
	});

	it("redacts secret-like text, respects multi-byte budgets and says how many did not fit", () => {
		const secret = `ghp_${"a".repeat(36)}`;
		assert.ok(!describeCaptured([text({ preview: `token ${secret}` })], 3000).includes(secret));
		const many = Array.from({ length: 20 }, (_, i) => text({ filename: `f${i}.md`, preview: "é".repeat(100), sizeBytes: 200 }));
		const out = describeCaptured(many, 900);
		assert.ok(Buffer.byteLength(out) <= 900);
		assert.match(out, /\(\d+ more not shown here; they are in the chat artifact folder on the agent host\)/);
	});

	it("says nothing when there is nothing, or no room", () => {
		assert.equal(describeCaptured([], 3000), "");
		assert.equal(describeCaptured([text()], 100), "");
	});
});

describe("an instruction whose job produces artifacts, end to end through the handler (a domain that refuses every task-bound call)", () => {
	const profile: AgentProfile = {
		id: "t",
		capabilities: [{ id: "code.thing", version: "1" }],
		approvalPatterns: [],
		defaultBudget: { maxTokens: 1000, maxMinutes: 1 },
		git: { push: true, pullRequest: true, branchPrefix: "agent" },
		skills: { allow: [] },
	};

	function build(options: { hooks?: Record<string, unknown> } = {}) {
		const { remote } = makeRemote();
		const root = mkdtempSync(join(tmpdir(), "chat-handler-"));
		const domain = new FakeDomain();
		const artifacts = new ChatArtifacts({ dir: join(root, "chat-artifacts") });
		const posts: any[] = [];
		const messages = { async get() { return {}; }, async post(_path: string, body: any) { posts.push(body); return {}; } };
		const runtime: AgentRuntime = {
			start: async () => undefined,
			health: () => ({ ready: true }),
			close: async () => undefined,
			execute: async (request) => {
				writeFileSync(join(request.workspace, "fix.txt"), "fixed\n");
				return { status: "done", answer: "done by the model", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: 0 } };
			},
		};
		const handler = createHandler({
			runtime,
			session: { env: new NodeExecutionEnv({ cwd: root }), identity: { name: "t", email: "t@t" } },
			host: new FakeHost(),
			workspaceRoot: join(root, "ws"),
			client: artifacts.wrap(domain),
			limits: { maxTokensCap: 1_000_000, maxMinutesCap: 60 },
			profile,
			hooks: options.hooks as any,
			source: "chat",
		});
		const ledger = new DailyLedger(join(root, "ledger.json"), 1_000_000, undefined, undefined, { share: 0.5 });
		const responder = new ModelChatResponder({
			client: messages as any,
			agentId: "agent/me",
			role: "t",
			settings: { ...DEFAULT_CHAT_MODEL, busyAfterSeconds: 60 },
			ledger,
			ask: { runtime: runtime as any, tools: ["read"], instructions: "x", state: async () => "", fallbackWorkspace: root },
			instruct: { handler, input: () => ({ capability: { id: "code.thing", version: "1" }, input: { repository: { url: remote, ref: "HEAD" }, instruction: "go" } }), gate: new JobGate(1), approvals: new ChatApprovals({ client: messages as any, log: () => undefined, timeoutMinutes: 1 }), artifacts },
			log: () => undefined,
			now: () => Date.parse("2026-10-05T12:00:00Z"),
		});
		return { domain, responder, posts, artifacts, remote };
	}

	const message = { messageId: "m1", type: "chat.message", sender: { kind: "agent", id: "agent/manager" }, conversationId: "c1", createdAt: "2026-10-05T11:59:59Z", text: "instruct: go" };

	it("completes, puts the patch into the reply and never calls the domain for the chat job", async () => {
		const h = build();
		assert.deepEqual(await h.responder.handle(message), { answered: true });
		assert.deepEqual(h.domain.calls, [], "no task-bound call reached the domain");
		const reply = h.posts.at(-1).content.data as string;
		assert.match(reply, /^Done/);
		assert.match(reply, /Branch: agent\/chat-m1/);
		assert.match(reply, /Attachments were not uploaded to the domain/);
		assert.match(reply, /chat-m1\.diff \(text\/x-diff/);
		assert.match(reply, /\+fixed/);
		assert.ok(Buffer.byteLength(reply) <= DEFAULT_CHAT_MODEL.replyMaxBytes);
	});

	it("keeps the reply inside 4 KB when the artifacts are large, and names the full copy", async () => {
		const h = build({
			hooks: {
				async result(_base: unknown, context: any) {
					await context.client.uploadArtifact({ filename: "report.md", mediaType: "text/markdown", bytes: "finding\n".repeat(3000), sourceTaskId: context.taskId });
					await context.client.uploadArtifact({ filename: "evidence.webm", mediaType: "video/webm", bytes: Buffer.alloc(100_000, 1), sourceTaskId: context.taskId });
				},
			},
		});
		await h.responder.handle(message);
		const reply = h.posts.at(-1).content.data as string;
		assert.ok(Buffer.byteLength(reply) <= DEFAULT_CHAT_MODEL.replyMaxBytes, `${Buffer.byteLength(reply)}`);
		assert.match(reply, /\[truncated: \d+ of 24000 bytes shown; full copy on the agent host at .*chat-artifacts\/chat-m1\/\d-report\.md\]/);
		assert.match(reply, /evidence\.webm \(video\/webm, 98 KB\)/);
		assert.deepEqual(h.domain.calls, []);
	});
});

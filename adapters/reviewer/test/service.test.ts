import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { approvalPolicy, PiDurableRuntime, skillsExtension, type AgentRuntime } from "@somework/agent-kit";
import { makeRemote, sh } from "@somework/agent-kit/testing";
import { sleep, Worker, type Job, type JobControl, type SomeWorkClient } from "@somework/sdk";
import { startDomain, type Domain } from "../../../sdk/typescript/test/harness.ts";
import { createReviewerHandler } from "../src/handler.ts";
import { profile } from "../src/profile.ts";
import { answer, closeServers, codeHost, offeredTools, REVIEW_JSON, TOKEN, turnModels } from "./support.ts";

const here = new URL(".", import.meta.url).pathname;
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	closeServers();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface Stack {
	domain: Domain;
	remote: string;
	author: SomeWorkClient;
	contexts: any[];
	workspaceRoot: string;
	startWorker(): void;
	submit(over?: Record<string, unknown>): Promise<string>;
	terminal(taskId: string, ms?: number): Promise<any>;
}

/** A real domain, the SDK worker, the reviewer's handler and runtime, a scripted model, and a local repository with a `feature` branch to review. */
async function stack(turns: string[][], options: { github?: { token: string; apiBase: string; tokenHosts?: string[] } } = {}): Promise<Stack> {
	const domain = await startDomain({ cardFile: join(here, "../card.json") });
	cleanups.push(() => domain.close());
	const { dir, remote } = makeRemote();
	const seed = join(dir, "seed");
	sh(seed, "checkout", "-b", "feature");
	writeFileSync(join(seed, "feature.txt"), "item = list[0]\n");
	sh(seed, "add", "-A");
	sh(seed, "commit", "-m", "read the first item");
	sh(seed, "push", "origin", "feature");

	const contexts: any[] = [];
	const fake = turnModels(turns, (context) => contexts.push(context));
	const work = mkdtempSync(join(tmpdir(), "reviewer-svc-"));
	const workspaceRoot = join(work, "workspaces");
	const env = (cwd: string | undefined) => new NodeExecutionEnv({ cwd: cwd ?? workspaceRoot });
	const runtime = new PiDurableRuntime({
		storagePath: join(work, "pi.sqlite"),
		models: fake.models,
		model: fake.model,
		env,
		policy: approvalPolicy([], profile.approvalPatterns),
		instructions: profile.systemPrompt,
		allowedTools: profile.allowedTools,
	});
	await runtime.start();
	cleanups.push(() => runtime.close());
	const handler = createReviewerHandler({
		runtime,
		session: { env: env(workspaceRoot), identity: { name: "Reviewer", email: "reviewer@test.invalid" } },
		workspaceRoot,
		client: domain.worker(),
		limits: { maxTokensCap: 5_000_000, maxMinutesCap: 60 },
		github: options.github,
	});
	const author = domain.author;
	return {
		domain,
		remote,
		author,
		contexts,
		workspaceRoot,
		startWorker() {
			const abort = new AbortController();
			const finished = new Worker(domain.worker(), { handler, leaseSeconds: 2, shutdownGraceMs: 5000 }).run(abort.signal);
			cleanups.push(async () => {
				abort.abort();
				await finished;
			});
		},
		async submit(over = {}) {
			const task = await author.submitTask({
				capability: { id: "code.review", version: "3" },
				input: { repository: { url: remote, ref: "feature" }, ticket: "ABC-12", focus: "empty lists", budget: { maxTokens: 1_000_000, maxMinutes: 5 }, ...over },
			});
			return task.taskId as string;
		},
		terminal: (taskId, ms = 60_000) => author.waitTerminal(taskId, ms),
	};
}

const toolResults = (contexts: any[]): string => JSON.stringify(contexts.at(-1)?.messages?.filter((message: any) => message.role === "toolResult") ?? []);

describe("reviewer service, end to end", () => {
	it("accepts its card in a real domain and returns the review as the result, with the report as an artifact", async () => {
		const s = await stack([[`final:${answer()}`]]);
		s.startWorker();
		const taskId = await s.submit();
		const task = await s.terminal(taskId);
		assert.equal(task.state, "succeeded", JSON.stringify(task.failure));
		assert.equal(task.result.verdict, "request_changes");
		assert.equal(task.result.findings[0].severity, "P1");
		assert.equal(task.result.findings[0].file, "feature.txt");
		assert.deepEqual(task.result.openQuestions, ["is the old path still used?"]);
		assert.equal(task.result.draftComments[0].body, "please guard this");
		assert.ok(task.result.usage.totalTokens >= 0);
		assert.equal(task.resultArtifacts?.length, 1);
		assert.equal(task.resultArtifacts[0].filename, `${taskId}-review.md`);
		assert.equal(task.resultArtifacts[0].mediaType, "text/markdown");
	});

	it("tells the model what to review and how, and offers it only read and bash", async () => {
		const s = await stack([[`final:${answer()}`]]);
		s.startWorker();
		await s.terminal(await s.submit());
		const request = s.contexts[0];
		assert.deepEqual(offeredTools(request), ["bash", "read"]);
		const sent = JSON.stringify(request);
		assert.match(sent, /You are a code reviewer/);
		assert.match(sent, /branch `feature` of/);
		assert.match(sent, /ticket ABC-12/);
		assert.match(sent, /empty lists/);
	});

	it("makes one repair turn when the answer has no usable result, and reports the usage of both turns", async () => {
		const s = await stack([["final:I think it is fine, no structured result."], [`final:${answer()}`]]);
		s.startWorker();
		const task = await s.terminal(await s.submit());
		assert.equal(task.state, "succeeded", JSON.stringify(task.failure));
		assert.equal(task.result.verdict, "request_changes");
		assert.equal(s.contexts.length, 2, "exactly two model calls: the review and the repair");
		assert.match(JSON.stringify(s.contexts[1]), /could not be used as the structured result: the answer has no JSON result/);
	});

	it("fails with invalid_review_output after one repair turn, and keeps the raw answer as an artifact", async () => {
		const s = await stack([["final:no result here"], ["final:still no result"]]);
		s.startWorker();
		const task = await s.terminal(await s.submit());
		assert.equal(task.state, "failed");
		assert.equal(task.failure.code, "invalid_review_output");
		assert.equal(task.failure.retryable, false);
		assert.match(task.failure.message, /after one repair turn/);
		assert.ok(task.failure.details.rawAnswer.artifactId, "the raw answer is referenced from the failure");
		assert.equal(s.contexts.length, 2);
	});

	it("never lets the model change anything: a push and a file write are refused without asking anyone, reading still works", async () => {
		const s = await stack([["bash:git push origin HEAD:refs/heads/evil", "bash:echo x > hacked.txt", "bash:git log --oneline -3", `final:${answer()}`]]);
		s.startWorker();
		const taskId = await s.submit();
		const task = await s.terminal(taskId);
		// nobody was asked: an approval request would have left the task in input_required with no one to answer
		assert.equal(task.state, "succeeded", JSON.stringify(task.failure));
		assert.equal(sh(s.remote, "branch", "--list", "evil").trim(), "", "the push never happened");
		const seen = toolResults(s.contexts);
		assert.match(seen, /read-only/);
		assert.match(seen, /read the first item/, "git log ran");
		const files = readdirSync(s.workspaceRoot, { recursive: true }).map(String);
		assert.ok(files.some((file) => file.endsWith("feature.txt")), "the workspace is where we looked");
		assert.ok(!files.some((file) => file.endsWith("hacked.txt")), "the redirect never wrote a file");
	});

	it("asks the requester before a command that is not plain inspection, and respects a refusal", async () => {
		const s = await stack([["bash:node --version", `final:${answer()}`]]);
		s.startWorker();
		const taskId = await s.submit();
		for (let i = 0; i < 200 && (await s.author.getTask(taskId)).state !== "input_required"; i++) await sleep(100);
		const waiting = await s.author.getTask(taskId);
		assert.equal(waiting.state, "input_required");
		assert.match(JSON.stringify(waiting), /not plain read-only inspection/);
		await s.author.provideInput(taskId, { approved: false, reason: "not needed" });
		const task = await s.terminal(taskId);
		assert.equal(task.state, "succeeded", JSON.stringify(task.failure));
		assert.match(toolResults(s.contexts), /denied by the requester: not needed/);
	});

	it("rejects a job without a budget when it is submitted", async () => {
		const s = await stack([[`final:${answer()}`]]);
		await assert.rejects(() => s.author.submitTask({ capability: { id: "code.review", version: "3" }, input: { repository: { url: s.remote, ref: "feature" } } }), /schema_violation/);
	});
});

describe("reviewer handler", () => {
	const control = { signal: new AbortController().signal, stopReason: undefined, progress: () => {}, requestInput: async () => ({}) } as unknown as JobControl;
	const job = (capability: { id: string; version: string }, input: unknown): Job => ({ task: { conversationId: "conv_1" }, input, capability, fencingToken: 1, taskId: "task_1", runtimeInstanceId: "r" }) as Job;
	const never: AgentRuntime = { start: async () => {}, health: () => ({ ready: true }), close: async () => {}, execute: async () => assert.fail("the model must not run") };
	const deps = { runtime: never, session: { env: undefined as never, identity: { name: "r", email: "r@test.invalid" } }, workspaceRoot: "/nowhere", client: { uploadArtifact: async () => ({}) }, limits: { maxTokensCap: 1_000_000, maxMinutesCap: 60 } };

	it("refuses a capability it does not serve", async () => {
		const outcome = await createReviewerHandler(deps)(job({ id: "code.agent", version: "1" }, { repository: { url: "u", ref: "r" }, budget: { maxTokens: 1000, maxMinutes: 1 } }), control);
		assert.equal(outcome.type, "failed");
		assert.equal((outcome as any).failure.code, "unsupported_capability");
		const other = await createReviewerHandler(deps)(job({ id: "code.review", version: "2" }, { repository: { url: "u", ref: "r" }, budget: { maxTokens: 1000, maxMinutes: 1 } }), control);
		assert.equal((other as any).failure.code, "unsupported_capability");
	});

	it("refuses a job without a budget and input it cannot use, before anything runs", async () => {
		const handler = createReviewerHandler(deps);
		const noBudget = await handler(job({ id: "code.review", version: "3" }, { repository: { url: "u", ref: "r" } }), control);
		assert.equal((noBudget as any).failure.code, "budget_required");
		const badPr = await handler(job({ id: "code.review", version: "3" }, { repository: { url: "u", ref: "r" }, pullRequest: -1, budget: { maxTokens: 1000, maxMinutes: 1 } }), control);
		assert.equal((badPr as any).failure.code, "invalid_input");
	});
});

describe("pull request context in a real review", () => {
	it("adds the description, files, checks and threads to what the model is asked, and keeps the token out of everything it sees", async () => {
		const host = await codeHost();
		// the code host's clone URL is served by a local repository, so the whole path runs without a network
		const { dir, remote } = makeRemote();
		const seed = join(dir, "seed");
		sh(seed, "checkout", "-b", "feature");
		writeFileSync(join(seed, "feature.txt"), "x\n");
		sh(seed, "add", "-A");
		sh(seed, "commit", "-m", "feature");
		sh(seed, "push", "origin", "feature");
		const saved = { count: process.env.GIT_CONFIG_COUNT, key: process.env.GIT_CONFIG_KEY_0, value: process.env.GIT_CONFIG_VALUE_0 };
		process.env.GIT_CONFIG_COUNT = "1";
		process.env.GIT_CONFIG_KEY_0 = `url.${remote}.insteadOf`;
		process.env.GIT_CONFIG_VALUE_0 = "https://github.com/o/r.git";
		cleanups.push(() => {
			for (const [name, value] of [["GIT_CONFIG_COUNT", saved.count], ["GIT_CONFIG_KEY_0", saved.key], ["GIT_CONFIG_VALUE_0", saved.value]] as const) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
		});

		const domain = await startDomain({ cardFile: join(here, "../card.json") });
		cleanups.push(() => domain.close());
		const contexts: any[] = [];
		const fake = turnModels([[`final:${answer()}`]], (context) => contexts.push(context));
		const work = mkdtempSync(join(tmpdir(), "reviewer-pr-"));
		const workspaceRoot = join(work, "workspaces");
		const env = (cwd: string | undefined) => new NodeExecutionEnv({ cwd: cwd ?? workspaceRoot });
		const runtime = new PiDurableRuntime({ storagePath: join(work, "pi.sqlite"), models: fake.models, model: fake.model, env, policy: approvalPolicy([], profile.approvalPatterns), instructions: profile.systemPrompt, allowedTools: profile.allowedTools });
		await runtime.start();
		cleanups.push(() => runtime.close());
		const handler = createReviewerHandler({
			runtime,
			session: { env: env(workspaceRoot), identity: { name: "r", email: "r@test.invalid" } },
			workspaceRoot,
			client: domain.worker(),
			limits: { maxTokensCap: 5_000_000, maxMinutesCap: 60 },
			github: { token: TOKEN, apiBase: host.apiBase },
		});
		const abort = new AbortController();
		const finished = new Worker(domain.worker(), { handler, leaseSeconds: 2, shutdownGraceMs: 5000 }).run(abort.signal);
		cleanups.push(async () => {
			abort.abort();
			await finished;
		});
		const task = await domain.author.waitTerminal(
			(await domain.author.submitTask({ capability: { id: "code.review", version: "3" }, input: { repository: { url: "https://github.com/o/r.git", ref: "feature" }, pullRequest: 7, budget: { maxTokens: 1_000_000, maxMinutes: 5 } } })).taskId,
			60_000,
		);
		assert.equal(task.state, "succeeded", JSON.stringify(task.failure));
		const sent = JSON.stringify(contexts[0]);
		assert.match(sent, /pull request #7/);
		assert.match(sent, /Guard empty lists/);
		assert.match(sent, /lint: failure/);
		assert.match(sent, /1 unresolved of 2/);
		assert.ok(!sent.includes(TOKEN));
		assert.ok(!JSON.stringify(task).includes(TOKEN));
		assert.ok(host.seen.every((call) => call.auth === `Bearer ${TOKEN}`));
	});
});

describe("repository skills", () => {
	it("exposes only the skills the deployment allows, and none of the others", async () => {
		const root = mkdtempSync(join(tmpdir(), "reviewer-skills-"));
		const write = (path: string, text: string) => {
			mkdirSync(join(root, path, ".."), { recursive: true });
			writeFileSync(join(root, path), text);
		};
		write("AGENTS.md", "# Repo rules\nAlways check encodings.\n");
		write(".agents/skills/review-skill/SKILL.md", "---\nname: review-skill\ndescription: Review someone else's pull request.\n---\n# PR review\n");
		write(".claude/skills/style-skill/SKILL.md", "---\nname: style-skill\ndescription: Deep style review.\n---\n");
		write(".agents/skills/qa/SKILL.md", "---\nname: qa\ndescription: Verify tickets in a browser.\n---\n");
		write(".agents/skills/autofix/SKILL.md", "---\nname: autofix\ndescription: Apply review fixes.\n---\n");

		const contexts: any[] = [];
		const fake = turnModels([[`final:${answer()}`]], (context) => contexts.push(context));
		const work = mkdtempSync(join(tmpdir(), "reviewer-skills-run-"));
		const runtime = new PiDurableRuntime({
			storagePath: join(work, "pi.sqlite"),
			models: fake.models,
			model: fake.model,
			env: (cwd) => new NodeExecutionEnv({ cwd: cwd ?? work }),
			instructions: profile.systemPrompt,
			allowedTools: profile.allowedTools,
			extensions: [skillsExtension({ allow: ["review-skill", "style-skill"], cacheMs: 0 })],
		});
		await runtime.start();
		cleanups.push(() => runtime.close());
		const outcome = await runtime.execute({ requestId: "r1", agentKey: "k", instruction: "review", workspace: root, budget: { maxTokens: 1_000_000, maxMinutes: 5 } }, { signal: new AbortController().signal, onProgress: () => {}, requestApproval: async () => ({ approved: false }) });
		assert.equal(outcome.status, "done");
		const sent = JSON.stringify(contexts[0]);
		assert.match(sent, /Always check encodings\./);
		assert.match(sent, /Review someone else's pull request\./);
		assert.match(sent, /Deep style review\./);
		assert.doesNotMatch(sent, /Verify tickets in a browser|Apply review fixes/);
		assert.deepEqual(offeredTools(contexts[0]), ["bash", "read"]);
		assert.equal(REVIEW_JSON.verdict, "request_changes");
	});
});

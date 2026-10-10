import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { AgentOutcome, AgentRequest, AgentRuntime, RunHooks } from "@somework/agent-kit";
import { jobRig } from "@somework/agent-kit/testing";
import { createQaHooks } from "../src/hooks.ts";
import { isUnreachable, JiraClient, JiraError } from "../src/jira.ts";
import { createJiraTools } from "../src/jira-tools.ts";
import { QaSession } from "../src/session.ts";
import { PAT, FakeJira, testIssue } from "./fake-jira.ts";
import { makeTls, type TestTls } from "./tls.ts";

const REPORT = `\`\`\`json\n${JSON.stringify({ verdict: "verified", acceptanceChecks: [{ criterion: "the total is right", passed: true, evidence: "saw it" }], fixtures: [], notes: "the total was right" })}\n\`\`\``;
const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: 0 };

describe("what counts as an outage of the ticket system", () => {
	it("is no answer, a timeout or a 5xx; an answer that says no is not", () => {
		assert.equal(isUnreachable(new JiraError(0, "cannot reach the ticket system: request timed out")), true);
		assert.equal(isUnreachable(new JiraError(503, "GET /rest/api/2/issue answered 503")), true);
		assert.equal(isUnreachable(new JiraError(404, "GET /rest/api/2/issue answered 404")), false);
		assert.equal(isUnreachable(new JiraError(403, "answered 403")), false);
		assert.equal(isUnreachable(new JiraError(0, "the attachment is larger than 10 bytes")), false);
		assert.equal(isUnreachable(new Error("cannot reach the ticket system")), false);
	});
});

describe("a ticket system that answers fast or not at all", () => {
	let tls: TestTls;
	let jira: FakeJira;
	const clientFor = (extra: Record<string, unknown> = {}) => new JiraClient({ baseUrl: jira.url, token: PAT, pfx: tls.clientPfx, passphrase: tls.clientPassphrase, ca: tls.ca, readTimeoutMs: 300, timeoutMs: 600, ...extra });
	before(async () => {
		tls = makeTls(mkdtempSync(join(tmpdir(), "qa-retry-tls-")));
		jira = await FakeJira.start(tls);
		jira.issues.set("QA-1", testIssue("QA-1"));
	});
	after(async () => {
		await jira.close();
	});

	it("gives up on a read that hangs and asks again, so a flaky answer costs a moment instead of a failed verification", async () => {
		const client = clientFor();
		jira.hang = 2;
		const started = Date.now();
		assert.equal((await client.getIssue("QA-1")).key, "QA-1");
		assert.equal(jira.requests.filter((request) => request.path.includes("/issue/QA-1")).length >= 3, true);
		assert.equal(Date.now() - started < 3000, true);
		client.close();
	});

	it("tries a read again after a 503 and reports the outage once the tries are used up", async () => {
		const client = clientFor({ readAttempts: 3 });
		jira.fail = 2;
		assert.equal((await client.getIssue("QA-1")).key, "QA-1");
		jira.fail = 3;
		await assert.rejects(client.getIssue("QA-1"), (error: unknown) => isUnreachable(error));
		client.close();
	});

	it("sends a comment only once: a try that was lost may have been applied", async () => {
		const client = clientFor();
		jira.hang = 1;
		const before = jira.requests.filter((request) => request.method === "POST").length;
		await assert.rejects(client.addComment("QA-1", "hello"), (error: unknown) => isUnreachable(error));
		assert.equal(jira.requests.filter((request) => request.method === "POST").length - before, 1);
		client.close();
	});
});

describe("a verification while the ticket system is down", () => {
	let tls: TestTls;
	let jira: FakeJira;
	let client: JiraClient;
	let down: JiraClient;
	const session = new QaSession();

	before(async () => {
		tls = makeTls(mkdtempSync(join(tmpdir(), "qa-outage-tls-")));
		jira = await FakeJira.start(tls);
		client = new JiraClient({ baseUrl: jira.url, token: PAT, pfx: tls.clientPfx, passphrase: tls.clientPassphrase, ca: tls.ca, timeoutMs: 500 });
		// nothing listens on port 1: the connection is refused, which the client reports like a ticket system that does not answer
		down = new JiraClient({ baseUrl: "https://127.0.0.1:1", token: PAT, pfx: tls.clientPfx, passphrase: tls.clientPassphrase, ca: tls.ca, timeoutMs: 500 });
	});
	after(async () => {
		client.close();
		down.close();
		await jira.close();
	});

	const tools = (jiraClient: JiraClient = client) => createJiraTools({ jira: jiraClient, session, pattern: /^QA-[0-9]+$/, testStatus: "Test", inProgressStatus: "In Progress", verifiedLabel: "AgentTested" }).extension.tools as readonly any[];
	const read = async (name: string, args: Record<string, unknown> = {}, jiraClient?: JiraClient) => (await tools(jiraClient).find((tool) => tool.name === name).execute(args, {}, {})).content.map((part: any) => part.text).join("");
	const start = (dir: string) => {
		jira.issues.clear();
		jira.issues.set("QA-1", testIssue("QA-1"));
		jira.beforeRequest = undefined;
		return session.start({ taskId: "task_1", ticket: "QA-1", evidenceDir: dir });
	};

	it("counts the calls that got no answer or a 5xx, and not the ones that were refused", async () => {
		const job = start(mkdtempSync(join(tmpdir(), "qa-outage-")));
		assert.match(await read("jira_get_issue", { key: "QA-404" }), /answered with an error/);
		assert.equal(job.jiraUnreachable.count, 0, "a 404 is an answer");
		await read("jira_get_issue", {}, down);
		await read("jira_get_comments", {}, down);
		assert.equal(session.job!.jiraUnreachable.count, 2);
		assert.match(session.job!.jiraUnreachable.last ?? "", /cannot reach the ticket system/);
	});

	describe("the result of the job", () => {
		const resultFor = async (setup: (job: NonNullable<QaSession["job"]>) => void) => {
			const dir = mkdtempSync(join(tmpdir(), "qa-outage-result-"));
			const root = join(dir, "workspaces").replaceAll("\\", "/");
			mkdirSync(join(root, ".qa", "task_1"), { recursive: true });
			const rig = jobRig({ stateDir: dir });
			const hooks = createQaHooks({
				root,
				ticketPattern: /^QA-[0-9]+$/,
				profiles: {},
				session,
				appEnv: () => ({}) as never,
				browser: async () => ({}) as never,
				allowHosts: [],
				cliPath: "cli.ts",
				extensions: [],
				hasTicketSystem: true,
				verifiedLabel: "AgentTested",
				client: rig.client,
				secrets: [],
			});
			const inner: AgentRuntime = { start: async () => {}, health: () => ({ ready: true }), close: async () => {}, execute: async (_request: AgentRequest, _hooks: RunHooks): Promise<AgentOutcome> => ({ status: "done", answer: REPORT, usage }) };
			const wrapped = hooks.wrapRuntime!(inner);
			const job = start(join(root, ".qa", "task_1"));
			setup(job);
			await wrapped.execute({ requestId: "somework:task_1", agentKey: "k", instruction: "go", workspace: root, budget: { maxTokens: 10_000, maxMinutes: 1 } }, { signal: new AbortController().signal, onProgress() {}, requestApproval: async () => ({ approved: true }) });
			return hooks.result!({ usage } as never, { taskId: "task_1", input: { ticket: "QA-1" }, baseSha: "abc123abc123", blocked: undefined } as never);
		};

		it("fails, retryably, when the ticket system could not be reached and nothing was written to the ticket", async () => {
			const patch: any = await resultFor((job) => (job.jiraUnreachable = { count: 3, last: "cannot reach the ticket system: request timed out" }));
			assert.equal(patch.result, undefined, "not a completed job");
			assert.deepEqual([patch.failure.code, patch.failure.retryable], ["ticket_system_unreachable", true]);
			assert.match(patch.failure.message, /could not be reached \(3 calls failed, the last: cannot reach the ticket system: request timed out\), so nothing was written to QA-1/);
			assert.equal(patch.failure.details.verdict, "verified");
		});

		it("does not fail a job that got its verdict into the ticket in spite of an earlier failed call", async () => {
			const patch: any = await resultFor((job) => {
				job.jiraUnreachable = { count: 1, last: "cannot reach the ticket system: request timed out" };
				job.jira.commented = true;
			});
			assert.notEqual(patch.failure?.code, "ticket_system_unreachable");
		});

		it("is unchanged when the ticket system never failed", async () => {
			const patch: any = await resultFor(() => undefined);
			assert.notEqual(patch.failure?.code, "ticket_system_unreachable");
		});
	});
});

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { approvalPolicy, createHandler, Metrics, PiDurableRuntime } from "@somework/agent-kit";
import { scriptedModels } from "@somework/agent-kit/providers/faux";
import { FakeHost, makeRemote, sh } from "@somework/agent-kit/testing";
import { localEnvFactory } from "@somework/agent-kit/windows";
import { Worker } from "@somework/sdk";
import { freePort, startDomain, type Domain } from "../../../sdk/typescript/test/harness.ts";
import type { AppProfile } from "../src/app.ts";
import type { BrowserBackend } from "../src/browser/backend.ts";
import { FakeBackend } from "../src/browser/fake.ts";
import { PlaywrightBackend } from "../src/browser/playwright.ts";
import { createQaHooks } from "../src/hooks.ts";
import { JiraClient } from "../src/jira.ts";
import { createJiraTools, jiraToolApprovals } from "../src/jira-tools.ts";
import { qaProfile } from "../src/profile.ts";
import { QaSession } from "../src/session.ts";
import card from "../card.json" with { type: "json" };
import { DEFAULT_TRANSITIONS, FakeJira, PAT, testIssue } from "./fake-jira.ts";
import { makeTls, type TestTls } from "./tls.ts";

const cliPath = fileURLToPath(new URL("../src/browser/cli.ts", import.meta.url));
const cardFile = fileURLToPath(new URL("../card.json", import.meta.url));
const EDGE = ["/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"].find((path) => existsSync(path));

const PAGE = `<!doctype html><html><head><title>Invoice form</title></head><body><h1>Invoice</h1>
<label for="c">Customer</label><input id="c" type="text">
<button onclick="fetch('/calc?c='+encodeURIComponent(document.getElementById('c').value)).then(r=>r.text()).then(t=>document.getElementById('o').textContent=t)">Calculate</button>
<p id="o">Total: 0</p></body></html>`;
// the server logs what the page asked for, so a test can tell that the browser really clicked
const APP_SERVER = `import { createServer } from "node:http";
createServer((q, r) => {
	const url = new URL(q.url, "http://x");
	if (url.pathname === "/calc") { const name = url.searchParams.get("c"); console.log("calc " + name); return r.end("Total: " + name.length * 10); }
	r.setHeader("content-type", "text/html"); r.end(${JSON.stringify(PAGE)});
}).listen(Number(process.argv[2]), "127.0.0.1");\n`;

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

let tls: TestTls;
before(() => {
	tls = makeTls(mkdtempSync(join(tmpdir(), "qa-e2e-tls-")));
});

const REPORT = (verdict: string, extra = "") => `\`\`\`json\n${JSON.stringify({ verdict, acceptanceChecks: [{ criterion: "the total is right", passed: verdict === "verified", evidence: "saw it" }], fixtures: [{ description: "an invoice", keys: "INV-1" }], notes: `done${extra}` })}\n\`\`\``;

interface Options {
	plan: string[] | ((context: { root: string; url: string }) => string[]);
	issue?: ReturnType<typeof testIssue>;
	browser?: (port: number, allowHosts: readonly string[]) => Promise<BrowserBackend>;
	app?: Partial<AppProfile>;
	ticketPattern?: RegExp;
}

async function stack(options: Options) {
	const domain: Domain = await startDomain({ cardFile, mayInvoke: "qa.*" });
	cleanups.push(() => domain.close());
	const jira = await FakeJira.start(tls, [options.issue ?? testIssue("QA-1")]);
	cleanups.push(() => jira.close());
	const jiraClient = new JiraClient({ baseUrl: jira.url, token: PAT, pfx: tls.clientPfx, passphrase: tls.clientPassphrase, ca: tls.ca });
	cleanups.push(() => jiraClient.close());

	const { dir: remoteDir, remote } = makeRemote();
	const seed = join(remoteDir, "seed");
	writeFileSync(join(seed, "server.mjs"), APP_SERVER);
	sh(seed, "add", "-A");
	sh(seed, "commit", "-m", "app");
	sh(seed, "push", "origin", "HEAD:main");
	const sha = sh(remote, "rev-parse", "main").trim();

	const dir = realpathSync(mkdtempSync(join(tmpdir(), "qa-e2e-")));
	const root = join(dir, "workspaces").replaceAll("\\", "/");
	const port = await freePort();
	const url = `http://127.0.0.1:${port}/`;
	const profiles: Record<string, AppProfile> = {
		default: { start: `nohup node server.mjs ${port} > .qa-app.log 2>&1 < /dev/null & echo $! > .qa-app.pid`, health: [url], stop: "kill $(cat .qa-app.pid)", env: {}, startupTimeoutSeconds: 20, ...options.app },
	};

	const session = new QaSession();
	const tools = createJiraTools({ jira: jiraClient, session, pattern: options.ticketPattern ?? /^QA-[0-9]+$/, testStatus: "Test", inProgressStatus: "In Progress", verifiedLabel: "AgentTested" });
	const profile = qaProfile({ toolNames: tools.toolNames, toolApprovals: jiraToolApprovals(session, "AgentTested", "In Progress") });
	const envFor = localEnvFactory({ root, baseEnv: { PATH: process.env.PATH ?? "", HOME: root }, flavour: "posix" });
	const hooks = createQaHooks({
		root,
		ticketPattern: options.ticketPattern ?? /^QA-[0-9]+$/,
		profiles,
		session,
		appEnv: (cwd) => envFor(cwd) as never,
		browser: (allowHosts) => (options.browser ?? (async () => new FakeBackend({ [url]: { title: "Invoice form", lines: ["# Invoice", '[e1] textbox "Customer"', '[e2] button "Calculate"'] } })))(port, allowHosts),
		allowHosts: ["127.0.0.1", "localhost"],
		cliPath,
		extensions: [tools.extension],
		hasTicketSystem: true,
		verifiedLabel: "AgentTested",
		client: domain.worker(),
		secrets: [PAT],
	});

	const fake = scriptedModels(typeof options.plan === "function" ? options.plan({ root, url }) : options.plan);
	const runtime = new PiDurableRuntime({ storagePath: join(dir, "pi.sqlite"), models: fake.models, model: fake.model, env: envFor, policy: approvalPolicy([], profile.approvalPatterns, profile.toolApprovals), allowedTools: profile.allowedTools, extensions: hooks.extensions });
	await runtime.start();
	cleanups.push(() => runtime.close());
	const handler = createHandler({ runtime: hooks.wrapRuntime!(runtime), envFor, session: { env: envFor(root), identity: { name: "QA", email: "qa@test.invalid" } }, host: new FakeHost(), workspaceRoot: root, client: domain.worker(), limits: { maxTokensCap: 5_000_000, maxMinutesCap: 60 }, metrics: new Metrics(), profile, hooks });
	const abort = new AbortController();
	const worker = new Worker(domain.worker(), { handler, leaseSeconds: 2, shutdownGraceMs: 5000 }).run(abort.signal);
	cleanups.push(async () => {
		abort.abort();
		await worker;
	});

	const asked: string[] = [];
	return {
		domain,
		jira,
		url,
		port,
		root,
		sha,
		asked,
		async submit(input: Record<string, unknown> = {}): Promise<string> {
			const task = await domain.author.submitTask({ capability: { id: "qa.verify", version: "1" }, input: { ticket: "QA-1", repository: { url: remote, ref: sha }, budget: { maxTokens: 1_000_000, maxMinutes: 5 }, ...input } });
			return task.taskId as string;
		},
		/** Answers each approval the task asks for with `decide(summary)`, until it ends. */
		async finish(taskId: string, decide: (summary: string) => boolean = () => true): Promise<any> {
			const deadline = Date.now() + 120_000;
			let answered = "";
			while (Date.now() < deadline) {
				const task = await domain.author.getTask(taskId);
				if (["succeeded", "failed", "canceled"].includes(task.state)) return task;
				if (task.state === "input_required") {
					const question = task.blocker?.question;
					const key = JSON.stringify(question);
					if (key !== answered) {
						answered = key;
						const summary = String(question?.summary ?? question?.question?.summary ?? key);
						asked.push(summary);
						await domain.author.provideInput(taskId, decide(summary) ? { approved: true } : { approved: false, reason: "not now" });
					}
				}
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			throw new Error("the task did not finish");
		},
		async healthy(): Promise<boolean> {
			return fetch(url, { signal: AbortSignal.timeout(1000) }).then(() => true, () => false);
		},
		evidenceFiles(taskId: string): string[] {
			try {
				return readdirSync(join(root, ".qa", taskId, "videos"));
			} catch {
				return [];
			}
		},
	};
}

/** The qa-browser command line the harness wrote for the job, resolved by the shell so the plan does not need the task id. */
const wrapper = (root: string) => `"$(ls ${root}/.qa/*/qa)"`;

const verifiedPlan = (root: string, url: string): string[] => [
	'call:jira_get_issue:{}',
	`bash:${wrapper(root)} open ${url}`,
	`bash:${wrapper(root)} snapshot`,
	`bash:${wrapper(root)} video-start`,
	`bash:${wrapper(root)} fill e1 ACME`,
	`bash:${wrapper(root)} click e2`,
	`bash:${wrapper(root)} video-stop`,
	'call:qa_record_verdict:{"verdict":"verified"}',
	'call:jira_attach:{"file":"videos/qa-video-1.webm"}',
	'call:jira_comment:{"body":"Verified on the revision: the total is right. Fixture INV-1. Video: qa-video-1.webm"}',
	'call:jira_add_label:{"label":"AgentTested"}',
	`final:${REPORT("verified")}`,
];

const evidenceKinds = (task: any): string[] => task.result.evidence.map((item: any) => item.kind).sort();

describe("QA role end to end", () => {
	it("is the card it claims to be", () => {
		const profile = qaProfile();
		assert.deepEqual(profile.capabilities, [{ id: "qa.verify", version: "1" }]);
		assert.equal(card.agentId, "agent/qa");
		assert.equal(card.capabilities[0]!.sideEffects, "write");
		assert.deepEqual([profile.git.push, profile.git.pullRequest], [false, false], "nothing leaves the workspace through git");
		assert.deepEqual(profile.skills.allow, [], "no repository skill is exposed unless the deployment names it");
		assert.equal(profile.requireBudget, true);
	});

	it("verifies a ticket: app up, browser driven, video recorded, three approved writes, app down", async () => {
		const s = await stack({ plan: ({ root, url }) => verifiedPlan(root, url) });
		const taskId = await s.submit();
		const task = await s.finish(taskId);
		assert.equal(task.state, "succeeded", JSON.stringify(task.failure));
		assert.equal(task.result.verdict, "verified");
		assert.equal(task.result.ticket, "QA-1");
		assert.equal(task.result.revision.frontendSha, s.sha, "the revision that was checked out is reported");
		assert.equal(task.result.acceptanceChecks[0].passed, true);
		assert.deepEqual(task.result.jira, { commented: true, labelled: true, transitioned: false, attached: true });
		assert.deepEqual(evidenceKinds(task), ["video"]);
		assert.equal(s.asked.length, 3, `attach, comment and label each waited for approval: ${s.asked.join(" | ")}`);
		assert.match(s.asked[0]!, /attach videos\/qa-video-1\.webm to QA-1/);
		assert.match(s.asked[1]!, /post a comment on QA-1/);
		assert.match(s.asked[2]!, /add the label AgentTested to QA-1/);

		const issue = s.jira.issues.get("QA-1")!;
		assert.deepEqual(issue.labels, ["Frontend", "AgentTested"]);
		assert.equal(issue.comments.length, 1);
		assert.equal(issue.attachments[0]!.filename, "QA-1-qa-video-1.webm");
		assert.equal(issue.status.name, "Test", "the ticket was not moved");
		assert.ok(!s.jira.requests.some((request) => request.path.includes("transitions") && request.method === "POST"));
		assert.equal(await s.healthy(), false, "the application was stopped after the run");
		assert.ok(JSON.stringify(task).indexOf(PAT) === -1, "the token is nowhere in the result");
	});

	it("does not write anything the requester declined, and still reports", async () => {
		const s = await stack({ plan: ({ root, url }) => verifiedPlan(root, url) });
		const task = await s.finish(await s.submit(), (summary) => !/post a comment/.test(summary));
		assert.equal(task.state, "succeeded", JSON.stringify(task.failure));
		const issue = s.jira.issues.get("QA-1")!;
		assert.equal(issue.comments.length, 0, "the declined comment was not posted");
		assert.deepEqual(issue.attachments.map((a) => a.filename), ["QA-1-qa-video-1.webm"], "the approved attachment was");
		assert.ok(!issue.labels.includes("AgentTested"), "the label needs the comment first, so it was refused");
		assert.equal(task.result.jira.commented, false);
		assert.equal(task.result.jira.labelled, false);
	});

	it("a verified report without a video is not verified", async () => {
		const s = await stack({ plan: ({ root, url }) => ["call:qa_record_verdict:{\"verdict\":\"verified\"}", `bash:${wrapper(root)} open ${url}`, `final:${REPORT("verified")}`] });
		const task = await s.finish(await s.submit());
		assert.equal(task.state, "succeeded", JSON.stringify(task.failure));
		assert.equal(task.result.verdict, "blocked");
		assert.match(task.result.notes, /no playable video/);
		assert.equal(s.asked.length, 0, "no write was attempted");
	});

	it("hands a not-fixed ticket back to its previous assignee with a comment, and never to a done status", async () => {
		const plan = ({ root, url }: { root: string; url: string }) => [
			`bash:${wrapper(root)} open ${url}`,
			`bash:${wrapper(root)} screenshot failure`,
			'call:qa_record_verdict:{"verdict":"not_fixed"}',
			'call:jira_transition_to_in_progress_and_reassign:{"comment":"Still wrong: expected 40, saw 0"}',
			`final:${REPORT("not_fixed")}`,
		];
		const s = await stack({ plan });
		s.jira.transitions = [{ ...DEFAULT_TRANSITIONS[0]!, assignTo: undefined }, DEFAULT_TRANSITIONS[1]!];
		const task = await s.finish(await s.submit());
		assert.equal(task.state, "succeeded", JSON.stringify(task.failure));
		assert.equal(task.result.verdict, "not_fixed");
		assert.deepEqual(evidenceKinds(task), ["screenshot"]);
		const issue = s.jira.issues.get("QA-1")!;
		assert.equal(issue.status.name, "In Progress");
		assert.equal(issue.assignee?.name, "dana", "back to who had it before");
		assert.match(issue.comments[0]!.body, /expected 40/);
		assert.equal(task.result.jira.transitioned, true);
		assert.match(s.asked[0]!, /hand QA-1 back/);
	});

	it("refuses to write when the ticket changed under it, after it was approved", async () => {
		const s = await stack({ plan: ({ root, url }) => verifiedPlan(root, url) });
		s.jira.beforeRequest = (method, path) => {
			if (method === "POST" && path.endsWith("/attachments")) throw new Error("not reached: the guard re-reads before writing");
		};
		s.jira.issues.get("QA-1")!.assignee = { name: "eve", displayName: "Eve" };
		const task = await s.finish(await s.submit());
		assert.equal(task.state, "succeeded", JSON.stringify(task.failure));
		assert.deepEqual(s.jira.issues.get("QA-1")!.attachments, [], "nothing was attached");
		assert.equal(s.jira.issues.get("QA-1")!.comments.length, 0);
		assert.equal(task.result.verdict, "verified", "the verdict is the verification's, the ticket just did not change");
		assert.deepEqual(task.result.jira, { commented: false, labelled: false, transitioned: false, attached: false });
	});

	it("skips a ticket key it does not handle without starting anything or calling the ticket system", async () => {
		const s = await stack({ plan: ["final:the model must not run"], ticketPattern: /^QA-[0-9]+$/ });
		const task = await s.finish(await s.submit({ ticket: "OTHER-9" }));
		assert.equal(task.state, "succeeded", JSON.stringify(task.failure));
		assert.equal(task.result.verdict, "skipped");
		assert.match(task.result.jira.skippedReason, /does not match/);
		assert.equal(s.jira.requests.length, 0, "no call reached the ticket system");
		assert.equal(await s.healthy(), false, "no application was started");
		assert.equal(task.result.usage?.totalTokens ?? 0, 0, "no tokens were spent");
	});

	it("an application that does not come up is a blocked verification, not a failed task", async () => {
		const s = await stack({ plan: ["final:the model must not run"], app: { start: "true", startupTimeoutSeconds: 5 } });
		const task = await s.finish(await s.submit());
		assert.equal(task.state, "succeeded", JSON.stringify(task.failure));
		assert.equal(task.result.verdict, "blocked");
		assert.match(task.result.notes, /did not (start|become healthy)/);
		assert.equal(s.jira.requests.length, 0);
	});

	it("an answer without a usable report gets one repair turn and then fails with the raw answer kept", async () => {
		const s = await stack({ plan: ["final:I looked around and it seems fine."] });
		const task = await s.finish(await s.submit());
		assert.equal(task.state, "failed");
		assert.equal(task.failure.code, "invalid_qa_report");
		assert.ok(task.failure.details.rawAnswer.artifactId);
		assert.equal(await s.healthy(), false);
	});

	it("an unknown application profile is refused as invalid input", async () => {
		const s = await stack({ plan: ["final:x"] });
		const task = await s.finish(await s.submit({ app: "nope" }));
		assert.equal(task.state, "failed");
		assert.equal(task.failure.code, "invalid_input");
		assert.equal(task.failure.retryable, false);
	});

	it("rejects a task without a budget at submission", async () => {
		const s = await stack({ plan: ["final:x"] });
		await assert.rejects(() => s.domain.author.submitTask({ capability: { id: "qa.verify", version: "1" }, input: { ticket: "QA-1", repository: { url: "x", ref: "main" } } }), /schema_violation/);
	});
});

describe("QA role end to end: the real browser", { skip: EDGE ? false : "no installed Edge on this machine" }, () => {
	it("verifies in Edge: the page is driven by refs and the recording is a real WebM that is attached", async () => {
		const real = (_port: number, allowHosts: readonly string[]) => PlaywrightBackend.launch({ channel: "msedge", allowHosts, executablePath: EDGE });
		const plan = ({ root, url }: { root: string; url: string }) => [
			`bash:${wrapper(root)} open ${url}`,
			`bash:${wrapper(root)} snapshot`,
			`bash:${wrapper(root)} video-start`,
			`bash:${wrapper(root)} fill e1 ACME`,
			`bash:${wrapper(root)} click e2`,
			`bash:${wrapper(root)} wait --text "Total: 40"`,
			`bash:${wrapper(root)} video-stop`,
			'call:qa_record_verdict:{"verdict":"verified"}',
			'call:jira_attach:{"file":"videos/qa-video-1.webm"}',
			'call:jira_comment:{"body":"Verified in the browser."}',
			'call:jira_add_label:{"label":"AgentTested"}',
			`final:${REPORT("verified")}`,
		];
		const s = await stack({ plan, browser: real });
		const task = await s.finish(await s.submit());
		assert.equal(task.state, "succeeded", JSON.stringify(task.failure));
		assert.equal(task.result.verdict, "verified");
		assert.deepEqual(evidenceKinds(task), ["video"]);
		const attached = s.jira.issues.get("QA-1")!.attachments[0]!;
		assert.ok(attached.size > 1000, `a real recording was attached (${attached.size} bytes)`);
		assert.ok(s.jira.issues.get("QA-1")!.labels.includes("AgentTested"));
		assert.equal(await s.healthy(), false);
		const appLog = readdirSync(s.root).map((name) => join(s.root, name, ".qa-app.log")).find((path) => existsSync(path));
		assert.ok(appLog, "the application's log is in the workspace");
		assert.match(readFileSync(appLog!, "utf8"), /calc ACME/, "the page really sent what was typed, after the recording had started");
	});
});

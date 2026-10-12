import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { Metrics, Preflight, type ServiceContext } from "@somework/agent-kit";
import { BRANCHES_THROUGH_GIT, jiraCheck, qaPreflight } from "../src/preflight.ts";
import { JiraClient } from "../src/jira.ts";
import { FakeJira, PAT } from "./fake-jira.ts";
import { makeTls, type TestTls } from "./tls.ts";

const TOKEN = "xq9-plain-literal-token-0123456789";
const REPO = "https://github.com/acme/web.git";

const context = (over: Record<string, unknown> = {}): ServiceContext =>
	({
		env: { CHAT_REPOSITORY_URL: REPO },
		config: { git: { tokenHosts: ["github.com"], mirror: undefined } },
		gitToken: TOKEN,
		ownerTokens: {},
		...over,
	}) as unknown as ServiceContext;

function githubAnswering(answers: Record<string, number | "network">) {
	const calls: { path: string; authorization: string | null }[] = [];
	const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(String(input));
		const key = url.pathname + url.search;
		calls.push({ path: key, authorization: new Headers(init?.headers).get("authorization") });
		const answer = answers[key] ?? 200;
		if (answer === "network") throw new TypeError("fetch failed");
		return new Response(answer === 200 ? "[]" : `{"message":"Resource not accessible by personal access token"}`, { status: answer });
	}) as typeof fetch;
	return { fetcher, calls };
}

const signal = new AbortController().signal;
const jiraAnswering = (answer: { name?: string; displayName?: string } | Error) => ({ myself: async () => (answer instanceof Error ? Promise.reject(answer) : answer) });

describe("the QA agent's preflight: the git token", () => {
	it("passes when the token reads the repository and its pull requests", async () => {
		const { fetcher, calls } = githubAnswering({});
		const checks = await qaPreflight(context(), { fetch: fetcher })!({ log: () => {}, signal });
		assert.deepEqual(checks.map(({ name, ok }) => [name, ok]), [["github-repository", true], ["github-pull-requests", true]]);
		assert.deepEqual(calls.map((call) => call.path), ["/repos/acme/web/contents", "/repos/acme/web/pulls?per_page=1"]);
		assert.ok(calls.every((call) => call.authorization === `Bearer ${TOKEN}`));
	});

	it("a 403 on the pull requests is the failed warning github-pull-requests, and the repository still reads", async () => {
		const { fetcher } = githubAnswering({ "/repos/acme/web/pulls?per_page=1": 403 });
		const checks = await qaPreflight(context(), { fetch: fetcher })!({ log: () => {}, signal });
		assert.deepEqual(checks, [
			{ name: "github-repository", ok: true, severity: "error" },
			{ name: "github-pull-requests", ok: false, severity: "warning", detail: `the token lacks Pull requests: read; ${BRANCHES_THROUGH_GIT}` },
		]);
		assert.equal(checks[1]!.detail, "the token lacks Pull requests: read; branches are found through git instead");
	});

	it("a token that cannot read the repository is a failed error", async () => {
		const { fetcher } = githubAnswering({ "/repos/acme/web/contents": 404 });
		const [contents] = await qaPreflight(context(), { fetch: fetcher })!({ log: () => {}, signal });
		assert.equal(contents!.name, "github-repository");
		assert.equal(contents!.ok, false);
		assert.equal(contents!.severity, "error");
	});

	it("uses the owner's own token and the repositories of the mirror", async () => {
		const { fetcher, calls } = githubAnswering({});
		const hooks = qaPreflight(context({ env: {}, ownerTokens: { acme: "owner-token-xyz-0123" }, config: { git: { tokenHosts: ["github.com"], mirror: { dir: "/m", repositories: [REPO], refreshMinutes: 30 } } } }), { fetch: fetcher })!;
		await hooks({ log: () => {}, signal });
		assert.ok(calls.length === 2 && calls.every((call) => call.authorization === "Bearer owner-token-xyz-0123"));
	});

	it("has no GitHub checks without a repository to ask about, and none at all without a token or a ticket system", () => {
		assert.equal(qaPreflight(context({ env: {} })), undefined);
		assert.equal(qaPreflight(context({ gitToken: undefined })), undefined);
		assert.ok(qaPreflight(context({ env: {} }), { jira: jiraAnswering({ name: "qa-bot" }) }));
	});
});

describe("the QA agent's preflight: the ticket system", () => {
	it("passes when /myself answers with a user", async () => {
		assert.deepEqual(await jiraCheck(jiraAnswering({ name: "qa-bot" })), { name: "jira", ok: true, severity: "error" });
		assert.equal((await jiraCheck(jiraAnswering({ displayName: "QA Bot" }))).ok, true);
	});

	it("fails when it answers nobody or does not answer", async () => {
		assert.equal((await jiraCheck(jiraAnswering({}))).ok, false);
		const down = await jiraCheck(jiraAnswering(new Error("cannot reach the ticket system: request timed out")));
		assert.deepEqual(down, { name: "jira", ok: false, severity: "error", detail: "cannot reach the ticket system: request timed out" });
	});

	describe("against the real client", () => {
		let tls: TestTls;
		let fake: FakeJira;
		const client = (token = PAT) => new JiraClient({ baseUrl: fake.url, token, pfx: tls.clientPfx, passphrase: tls.clientPassphrase, ca: tls.ca });
		before(async () => {
			tls = makeTls(mkdtempSync(join(tmpdir(), "qa-preflight-tls-")));
			fake = await FakeJira.start(tls);
		});
		after(async () => {
			await fake.close();
		});

		it("passes with the token the ticket system knows, and fails with a short, token-free detail for one it does not", async () => {
			assert.equal((await jiraCheck(client())).ok, true);
			const wrong = await jiraCheck(client("pat_wrong_token_0123456789"));
			assert.equal(wrong.ok, false);
			assert.match(wrong.detail!, /answered 401/);
			assert.ok(!wrong.detail!.includes("pat_wrong_token"));
		});

		it("gives up quickly on a ticket system that does not answer", async () => {
			fake.hang = 1;
			const started = Date.now();
			const slow = await jiraCheck(client());
			assert.equal(slow.ok, false);
			assert.ok(Date.now() - started < 8000, "one quick try, not four slow ones");
		});
	});
});

describe("the preflight of the QA agent in the kit's runner", () => {
	it("turns the missing permission into the gauge, one warning in the log and a detail without the token", async () => {
		const { fetcher } = githubAnswering({ "/repos/acme/web/pulls?per_page=1": 403 });
		const hooks = qaPreflight(context(), { fetch: fetcher, jira: jiraAnswering({ name: "qa-bot" }) })!;
		const lines: { level: string; event: string; fields: Record<string, unknown> }[] = [];
		const metrics = new Metrics();
		const preflight = new Preflight({ checks: hooks, log: (level, event, fields) => lines.push({ level, event, fields: fields ?? {} }), metrics, secrets: [TOKEN] });
		await preflight.run();
		await preflight.run();
		assert.match(metrics.render(), /somework_preflight_ok\{check="github-pull-requests"\} 0/);
		assert.match(metrics.render(), /somework_preflight_ok\{check="github-repository"\} 1/);
		assert.match(metrics.render(), /somework_preflight_ok\{check="jira"\} 1/);
		const failures = lines.filter((line) => line.event === "preflight_failed");
		assert.equal(failures.length, 1);
		assert.deepEqual(failures[0], { level: "warn", event: "preflight_failed", fields: { check: "github-pull-requests", severity: "warning", blocking: false, detail: "the token lacks Pull requests: read; branches are found through git instead" } });
		assert.ok(!JSON.stringify([lines, preflight.results()]).includes(TOKEN));
		assert.equal(preflight.blocking().length, 0);
		assert.equal(preflight.results().length, 3);
	});
});

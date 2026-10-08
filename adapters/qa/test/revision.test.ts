import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createQaHooks } from "../src/hooks.ts";
import { pullRequestInText, saysNotMerged } from "../src/revision.ts";
import { QaSession } from "../src/session.ts";

describe("which pull request holds the fix", () => {
	it("reads the preview address, a pull request link and PR numbers, and the latest mention wins", () => {
		assert.equal(pullRequestInText("Testa den i PR:ens preview-miljö:\nhttps://preview-pr-5252-437ad8.administration-test.pages.dev"), 5252);
		assert.equal(pullRequestInText("see https://github.com/acme/app/pull/77 for the change"), 77);
		assert.equal(pullRequestInText("first PR #10, replaced by PR #12 later"), 12);
		assert.equal(pullRequestInText("no pull request is named here, only SAD-123 and #5 as a plain number"), undefined);
	});
	it("knows when a ticket says the fix is not merged", () => {
		assert.equal(saysNotMerged("PR:en är inte merge:ad än, så fixen ligger inte i stage"), true);
		assert.equal(saysNotMerged("the fix is not merged yet"), true);
		assert.equal(saysNotMerged("Klart! Fixen ligger i stage."), false);
	});
});

describe("choosing the revision to verify", () => {
	const make = (text: string | Error) =>
		createQaHooks({
			root: "/w",
			ticketPattern: /^SAD-[0-9]+$/,
			profiles: { default: { start: "x", health: ["http://127.0.0.1:1/"], stop: "y", startupTimeoutSeconds: 5 } as never },
			session: new QaSession(),
			appEnv: (() => { throw new Error("not used"); }) as never,
			browser: (async () => { throw new Error("not used"); }) as never,
			allowHosts: [],
			cliPath: "/cli",
			hasTicketSystem: true,
			ticketText: async () => { if (text instanceof Error) throw text; return text; },
			verifiedLabel: "AgentTested",
			client: {} as never,
		});
	const job = (ref?: string) => ({ ticket: "SAD-1", repository: { url: "https://example.test/r.git", ...(ref ? { ref } : {}) } });

	it("checks out the pull request the ticket names instead of the default branch", async () => {
		const prepared = await make("Klart! preview-pr-5252-abc.pages.dev").prepareInput!(job("HEAD"), { taskId: "t", log: () => {} });
		assert.equal(prepared.repository.ref, "refs/pull/5252/head");
		assert.equal(prepared.testedPullRequest, 5252);
		assert.match(make("x").instruction!(prepared, { taskId: "t" }), /pull request #5252 as its fix/);
	});
	it("leaves an explicit ref alone", async () => {
		const prepared = await make("preview-pr-5252-abc").prepareInput!(job("refs/heads/feature/x"), { taskId: "t", log: () => {} });
		assert.equal(prepared.repository.ref, "refs/heads/feature/x");
	});
	it("refuses to judge a ticket whose fix is unmerged and names no pull request, without running the model", async () => {
		const hooks = make("PR:en är inte merge:ad än");
		const prepared = await hooks.prepareInput!(job("HEAD"), { taskId: "t", log: () => {} });
		assert.equal(hooks.instruction!(prepared, { taskId: "t" }), "not testable");
		const blocked = await hooks.beforeRun!({ input: prepared, taskId: "t", workspace: "/w" } as never);
		assert.match((blocked as any).blocked.reason, /not merged and names no pull request/);
	});
	it("falls back to the default branch when the ticket cannot be read", async () => {
		const prepared = await make(new Error("jira down")).prepareInput!(job("HEAD"), { taskId: "t", log: () => {} });
		assert.equal(prepared.repository.ref, "HEAD");
	});
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createQaHooks } from "../src/hooks.ts";
import { GitHubPullFinder, type PullFinder, type PullInfo } from "../src/github-pulls.ts";
import { chooseRevision, pullRequestInText, pullRequestsInText, relation, saysNotMerged, type RevisionPull } from "../src/revision.ts";
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

const pull = (number: number, over: Partial<RevisionPull> = {}): RevisionPull => ({ number, title: "", body: "", state: "open", merged: false, headRef: `feature/${number}`, baseRef: "tremendous", updatedAt: "2026-10-01T00:00:00Z", ...over });

describe("which pull request is the ticket's own", () => {
	it("tells a pull request that names the ticket from one written for another ticket", () => {
		assert.equal(relation(pull(1, { title: "SAD-2273: series dropdown" }), "SAD-2273"), "linked");
		assert.equal(relation(pull(1, { headRef: "feature/sad-2273-series" }), "SAD-2273"), "linked");
		assert.equal(relation(pull(2, { title: "SAD-2227: control values" }), "SAD-2273"), "foreign");
		assert.equal(relation(pull(3, { title: "SAD-22730 other" }), "SAD-2273"), "foreign", "a longer number is another ticket");
		assert.equal(relation(pull(4, { title: "fix the dropdown" }), "SAD-2273"), "neutral");
		assert.deepEqual(pullRequestsInText("PR 4987 first, then preview-pr-5058-x and PR 4987 again"), [4987, 5058]);
	});

	it("never takes the backend pull request of another ticket as the revision: SAD-2273 named SAD-2227's PR 4987", () => {
		const backend = pull(4987, { title: "SAD-2227: publish voucher series on control values", state: "closed", merged: true, mergedAt: "2026-09-17T11:00:00Z" });
		const choice = chooseRevision("SAD-2273", [], [backend]);
		assert.ok(choice && "none" in choice);
		assert.match(choice.none, /#4987.*SAD-2227.*not to SAD-2273/);
	});

	it("takes the pull request that names the ticket over one the text merely mentions, and the newest of them", () => {
		const backend = pull(4987, { title: "SAD-2227: backend", state: "closed", merged: true });
		const front = pull(5058, { title: "SAD-2273: series dropdown from control values", updatedAt: "2026-10-09T09:00:00Z" });
		const older = pull(5001, { title: "SAD-2273: first try", updatedAt: "2026-10-01T09:00:00Z" });
		const choice = chooseRevision("SAD-2273", [older, front], [backend]);
		assert.deepEqual(choice && "ref" in choice ? [choice.ref, choice.pullRequest, choice.source] : choice, ["refs/pull/5058/head", 5058, "linked"]);
	});

	it("tests the target branch of a merged pull request, whose own head is a stale snapshot", () => {
		const merged = pull(77, { title: "SAD-5: the fix", state: "closed", merged: true, mergedAt: "2026-10-02T00:00:00Z", baseRef: "tremendous" });
		const choice = chooseRevision("SAD-5", [merged], []);
		assert.deepEqual(choice && "ref" in choice ? [choice.ref, choice.source] : choice, ["tremendous", "merged"]);
	});

	it("keeps the old rule for a pull request that names no ticket: the last one the text names", () => {
		const first = pull(10, { title: "dropdown" });
		const second = pull(12, { title: "dropdown, again" });
		const choice = chooseRevision("SAD-9", [], [first, second]);
		assert.deepEqual(choice && "ref" in choice ? [choice.ref, choice.source] : choice, ["refs/pull/12/head", "mentioned"]);
	});

	it("has no opinion when nothing usable is named (the caller then falls back as before)", () => {
		assert.equal(chooseRevision("SAD-9", [], []), undefined);
		assert.equal(chooseRevision("SAD-9", [pull(1, { title: "SAD-9", state: "closed", merged: false })], []), undefined, "an abandoned pull request is no revision");
	});
});

describe("the GitHub pull request finder", () => {
	const raw = (number: number, over: Record<string, unknown> = {}) => ({ number, title: `SAD-7: change ${number}`, body: "body", state: "open", merged_at: null, head: { ref: `feature/${number}`, sha: "a".repeat(40) }, base: { ref: "tremendous" }, updated_at: "2026-10-09T08:00:00Z", ...over });

	function finder(answers: Record<string, unknown>) {
		const seen: { url: string; authorization?: string }[] = [];
		const fetcher = (async (url: string, init: RequestInit) => {
			seen.push({ url, authorization: (init.headers as Record<string, string>).authorization });
			const path = url.replace("https://api.github.com", "");
			const body = answers[path];
			return body === undefined ? new Response("{}", { status: 404 }) : new Response(JSON.stringify(body), { status: 200 });
		}) as unknown as typeof fetch;
		return { seen, finder: new GitHubPullFinder({ token: (owner) => (owner === "Acme" ? "tok-acme" : undefined), fetch: fetcher }) };
	}

	it("finds the pull requests that name a ticket and reads each, with the token of the repository's owner", async () => {
		const q = encodeURIComponent("repo:Acme/app is:pr SAD-7 in:title,body,comments");
		const { seen, finder: f } = finder({ [`/search/issues?q=${q}&sort=updated&order=desc&per_page=8`]: { items: [{ number: 5 }, { number: 6 }] }, "/repos/Acme/app/pulls/5": raw(5), "/repos/Acme/app/pulls/6": raw(6, { state: "closed", merged_at: "2026-10-01T00:00:00Z" }) });
		const found = await f.forTicket("https://github.com/Acme/app.git", "SAD-7");
		assert.deepEqual(found.map((p: PullInfo) => [p.number, p.state, p.merged, p.baseRef]), [[5, "open", false, "tremendous"], [6, "closed", true, "tremendous"]]);
		assert.ok(seen.every((call) => call.authorization === "Bearer tok-acme"));
	});

	it("answers nothing for an address or a ticket it does not understand, and says nothing exists for a 404", async () => {
		const { seen, finder: f } = finder({});
		assert.deepEqual(await f.forTicket("https://example.test/r.git", "SAD-7"), []);
		assert.deepEqual(await f.forTicket("https://github.com/Acme/app", "sad 7; drop"), []);
		assert.equal(await f.get("https://github.com/Acme/app", 99), undefined);
		assert.equal(await f.get("https://github.com/Acme/app", -1), undefined);
		assert.equal(seen.length, 1);
	});
});

describe("choosing the revision with the repository's pull requests", () => {
	const make = (text: string, pulls: PullFinder) =>
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
			ticketText: async () => text,
			pulls,
			verifiedLabel: "AgentTested",
			client: {} as never,
		});
	const info = (number: number, over: Partial<PullInfo> = {}): PullInfo => ({ number, title: "", body: "", state: "open", merged: false, headRef: `feature/${number}`, headSha: "a".repeat(40), baseRef: "tremendous", updatedAt: "2026-10-09T00:00:00Z", ...over });
	const job = { ticket: "SAD-2273", repository: { url: "https://github.com/Visma-Administration/visma.administration.git", ref: "HEAD" } };

	it("blocks, without running the model, a ticket whose only named pull request belongs to another ticket", async () => {
		const pulls: PullFinder = { forTicket: async () => [], get: async (_url, n) => info(n, { title: "SAD-2227: backend", state: "closed", merged: true }) };
		const hooks = make("The backend fix in SAD-2227 (backend PR 4987) ... preview-pr-4987-85df54.pages.dev", pulls);
		const prepared = await hooks.prepareInput!(job, { taskId: "t", log: () => {} });
		assert.equal(hooks.instruction!(prepared, { taskId: "t" }), "not testable");
		const blocked = await hooks.beforeRun!({ input: prepared, taskId: "t", workspace: "/w" } as never);
		assert.match((blocked as any).blocked.reason, /#4987.*SAD-2227/);
	});

	it("checks out the pull request that names the ticket and says why in the brief and for the result", async () => {
		const pulls: PullFinder = { forTicket: async () => [info(5058, { title: "SAD-2273: series dropdown" })], get: async (_url, n) => info(n, { title: "SAD-2227: backend", state: "closed", merged: true }) };
		const hooks = make("PR 4987 is the backend", pulls);
		const prepared = await hooks.prepareInput!(job, { taskId: "t", log: () => {} });
		assert.equal(prepared.repository.ref, "refs/pull/5058/head");
		assert.equal(prepared.revisionSource, "linked");
		assert.match(hooks.instruction!(prepared, { taskId: "t" }), /revision under test is pull request #5058 \(it names SAD-2273\)/);
	});

	it("falls back to the text's last pull request when GitHub cannot be read", async () => {
		const pulls: PullFinder = { forTicket: async () => { throw new Error("GitHub answered 403"); }, get: async () => undefined };
		const prepared = await make("see PR 5252", pulls).prepareInput!(job, { taskId: "t", log: () => {} });
		assert.equal(prepared.repository.ref, "refs/pull/5252/head");
	});
});

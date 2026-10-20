import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { type ResultContext } from "@somework/agent-kit";
import { AikidoError } from "../src/aikido/client.ts";
import { createAikidoLookupTools } from "../src/aikido/tool.ts";
import { AttemptLedger } from "../src/attempts.ts";
import { ATTEMPTS_FILE, FIXER_CHAT_INSTRUCTIONS, fixerChat } from "../src/chat.ts";
import { createFixerHooks } from "../src/hooks.ts";
import { profile } from "../src/profile.ts";
import { loadSettings } from "../src/settings.ts";

const REPO = "https://github.com/Acme/Shop.git";
const group = { id: 12, title: "Prototype pollution in lodash", type: "open_source", severity: "high", group_status: "new", description: "Long description" };
const issue = { id: 99, group_id: 12, status: "open", affected_package: "lodash", installed_version: "4.17.20", patched_versions: ["4.17.21"], code_repo_name: "Acme/Shop" };

function setup(env: NodeJS.ProcessEnv = {}) {
	const stateDir = mkdtempSync(join(tmpdir(), "aikido-chat-"));
	const clock = { now: new Date("2026-10-06T09:00:00Z") };
	const resolved: string[] = [];
	const settings = loadSettings({ AIKIDO_REPOSITORY_URL: REPO, ...env });
	const aikido = { resolveIssue: async (id: string | number) => (resolved.push(String(id)), { group, issue }) };
	const chat = fixerChat({ settings, aikido, stateDir, now: () => clock.now });
	return { stateDir, clock, resolved, settings, aikido, chat };
}

const run = async (chat: ReturnType<typeof setup>["chat"], name: string, args: object = {}): Promise<string> => {
	const tool = (chat.extension!.tools as any[]).find((candidate) => candidate.name === name);
	assert.ok(tool, `${name} is registered`);
	return (await tool.execute(args, {}, {})).content[0].text;
};

describe("the fixer in conversations", () => {
	it("raises today's cap through raise_daily_cap, needs the owner's approval for it, and stops at the handler's ceiling", async () => {
		const { chat, settings } = setup({ AIKIDO_DAILY_CAP: "2" });
		const approval = (profile.toolApprovals as any).raise_daily_cap({ extra: 3, reason: "owner asked for more today" });
		assert.match(approval, /raise today's cap of fix attempts by 3 \(owner asked for more today\)/);
		assert.match(await run(chat, "raise_daily_cap", { extra: 3, reason: "the owner said so" }), /Today's cap is now 5 fix attempts \(3 added today\)\. It goes back to 2 tomorrow/);
		assert.match(await run(chat, "fixer_status"), /Fix tasks today: 0 of 5 \(raised by 3 today\)/);
		const tooMany = await run(chat, "raise_daily_cap", { extra: 6, reason: "more" });
		assert.match(tooMany, /Cap not changed: today's cap can be raised by at most 8 fix attempts in all \(3 already\)/);
		assert.equal(settings.dailyCap, 2, "the setting itself is untouched");
		assert.match(FIXER_CHAT_INSTRUCTIONS, /raise_daily_cap.*owner is asked to approve/s);
	});

	const tool = (chat: ReturnType<typeof setup>["chat"], name: string) => chat.jobTools!.find((candidate) => candidate.name === name)!;

	it("reads with fixer_status and aikido_lookup next to the kit's tools, may raise today's cap (only with the owner's approval), and has not the job's own aikido_issue", () => {
		const { chat } = setup();
		assert.deepEqual(chat.toolNames, ["fixer_status", "raise_daily_cap", "aikido_lookup"]);
		assert.ok(!chat.toolNames!.some((name) => ["bash", "write", "edit", "aikido_issue"].includes(name)));
		assert.deepEqual((chat.extension!.tools as any[]).map((candidate) => candidate.name).sort(), ["aikido_lookup", "fixer_status", "raise_daily_cap"]);
	});

	it("offers the two jobs as tools", () => {
		assert.deepEqual(setup().chat.jobTools!.map((candidate) => candidate.name), ["fix_issue", "follow_up_pull_request"]);
	});

	describe("follow_up_pull_request", () => {
		const opened = (ledger: AttemptLedger, taskId: string, groupId: string, number: number, at: string, clock: { now: Date }) => {
			clock.now = new Date(at);
			ledger.recordOutcome(taskId, { groupId, outcome: "pr_opened", branch: `agent/aikido-${groupId}-abc12345`, prUrl: `https://github.com/Acme/Shop/pull/${number}` });
		};
		const withPullRequests = () => {
			const s = setup();
			const ledger = new AttemptLedger(join(s.stateDir, ATTEMPTS_FILE), { maxAttemptsPerIssue: 2, cooldownMinutes: 180, dailyCap: 5 }, () => s.clock.now);
			opened(ledger, "t1", "11", 41, "2026-10-06T08:00:00Z", s.clock);
			opened(ledger, "t2", "12", 42, "2026-10-06T09:00:00Z", s.clock);
			return s;
		};
		const followUp = (number: number, groupId: string) => ({ capability: { id: "code.fix.followup", version: "1" }, input: { issue: { id: groupId }, repository: { url: REPO, ref: `agent/aikido-${groupId}-abc12345` }, followUp: { pullRequest: `https://github.com/Acme/Shop/pull/${number}`, branch: `agent/aikido-${groupId}-abc12345`, round: 1 } }, label: `follow up on pull request #${number}` });

		it("follows up on the latest pull request it opened when none is named", async () => {
			const { chat } = withPullRequests();
			assert.deepEqual(await tool(chat, "follow_up_pull_request").plan({}), followUp(42, "12"));
		});

		it("follows up on the one named by address, number or hash, when it is one of its own", async () => {
			const { chat } = withPullRequests();
			const plan = (pullRequest: string) => tool(chat, "follow_up_pull_request").plan({ pullRequest });
			assert.deepEqual(await plan("https://github.com/Acme/Shop/pull/41"), followUp(41, "11"));
			assert.deepEqual(await plan("41"), followUp(41, "11"));
			assert.deepEqual(await plan("#41"), followUp(41, "11"));
			assert.match(((await plan("99")) as any).refuse, /#99 is not one of them/);
			assert.match(((await plan("the big one")) as any).refuse, /number or its address/);
		});

		it("passes on what the asker said is wrong, as their own words, and not a bare request", async () => {
			const { chat } = withPullRequests();
			const planned = (await tool(chat, "follow_up_pull_request").plan({ pullRequest: "41", hint: "CI fails because bun.lock is stale after the override, run bun install and commit it" })) as any;
			assert.match(planned.input.hint, /bun\.lock is stale/);
			assert.equal(((await tool(chat, "follow_up_pull_request").plan({ pullRequest: "41", hint: "please" })) as any).input.hint, undefined);
		});

		it("says so when it has no pull request on record", async () => {
			assert.match(((await tool(setup().chat, "follow_up_pull_request").plan({})) as any).refuse, /no pull request of my own on record/);
		});
	});

	it("reads a checkout of the configured repository", () => {
		assert.deepEqual(setup().chat.checkout!(), { repoUrl: REPO });
	});

	describe("fix_issue", () => {
		it("becomes a code.fix job on the configured repository", async () => {
			const { chat } = setup();
			assert.deepEqual(await tool(chat, "fix_issue").plan({ issue: "1234" }), { capability: { id: "code.fix", version: "1" }, input: { issue: { id: "1234" }, repository: { url: REPO } }, label: "fix Aikido issue 1234" });
			assert.deepEqual(((await tool(chat, "fix_issue").plan({ issue: "#77" })) as any).input.issue, { id: "77" });
		});

		it("passes the hint on, which the role frames as the requester's", async () => {
			const planned = (await tool(setup().chat, "fix_issue").plan({ issue: "1234", hint: "prefer the minimal bump" })) as any;
			assert.equal(planned.input.issue.id, "1234");
			assert.match(planned.input.hint, /prefer the minimal bump/);
		});

		it("refuses anything that is not one whole issue number", async () => {
			const { chat } = setup();
			for (const issue of ["", "the security problems", "12 and 13", "https://app.aikido.dev/queue/99", "v4.17.21"]) assert.match(((await tool(chat, "fix_issue").plan({ issue })) as any).refuse, /exactly one Aikido issue/, issue);
		});

		it("only fixes the repository it is configured for", async () => {
			const { chat } = setup({ AIKIDO_ALLOWED_REPOSITORIES: `${REPO},https://github.com/Acme/Other.git` });
			assert.equal(((await tool(chat, "fix_issue").plan({ issue: "5", repository: "https://github.com/acme/other" })) as any).input.repository.url, "https://github.com/Acme/Other.git");
			assert.match(((await tool(chat, "fix_issue").plan({ issue: "5", repository: "https://github.com/evil/repo" })) as any).refuse, /configured for/);
			assert.match(((await tool(setup().chat, "fix_issue").plan({ issue: "5", repository: "https://github.com/Acme/Other" })) as any).refuse, /configured for/);
		});
	});

	describe("what it can state about itself", () => {
		it("says there is nothing yet, with the limits", async () => {
			const { chat } = setup({ AIKIDO_DAILY_CAP: "4" });
			const text = await chat.context!();
			assert.match(text, /Repository: https:\/\/github.com\/Acme\/Shop.git/);
			assert.match(text, /Fix tasks today: 0 of 4/);
			assert.match(text, /No fix attempt has finished/);
			assert.equal(text, await run(chat, "fixer_status"));
		});

		it("reports the recorded attempts with how each ended, newest first, and today's count", async () => {
			const { chat, stateDir, clock, settings } = setup();
			const ledger = new AttemptLedger(join(stateDir, ATTEMPTS_FILE), { maxAttemptsPerIssue: settings.maxAttemptsPerIssue, cooldownMinutes: settings.cooldownMinutes, dailyCap: settings.dailyCap }, () => clock.now);
			ledger.begin("12", "t1");
			ledger.recordOutcome("t1", { groupId: "12", outcome: "pr_opened", branch: "agent/aikido-12-abcd1234", prUrl: "https://github.com/Acme/Shop/pull/9", tokens: 4321 });
			clock.now = new Date("2026-10-06T09:30:00Z");
			ledger.begin("13", "t2");
			ledger.recordOutcome("t2", { groupId: "13", outcome: "no_fix" });
			const text = await chat.context!();
			assert.match(text, new RegExp(`Fix tasks today: 2 of ${settings.dailyCap}`));
			const lines = text.split("\n").filter((line) => line.startsWith("- issue"));
			assert.match(lines[0]!, /issue 13: no_fix/);
			assert.match(lines[1]!, /issue 12: pr_opened .*branch agent\/aikido-12-abcd1234, https:\/\/github.com\/Acme\/Shop\/pull\/9, 4321 tokens \(attempts so far: 1\)/);
		});

		it("says how fresh its local clone is only when it knows", async () => {
			assert.match(await setup().chat.context!(), /not refreshed since this service started/);
		});
	});
});

describe("the aikido_lookup tool", () => {
	const lookup = (resolve?: (id: string | number) => Promise<any>) => {
		const calls: string[] = [];
		const { extension, toolNames } = createAikidoLookupTools({ aikido: { resolveIssue: async (id) => (calls.push(String(id)), resolve ? resolve(id) : { group, issue }) } });
		const run = async (args: object) => {
			const result = await (extension.tools as any[])[0].execute(args, {}, {});
			return { text: result.content[0].text as string, isError: result.isError === true };
		};
		return { calls, toolNames, run };
	};

	it("reads one issue by its whole-number id, framed as data, and has no other tool", async () => {
		const t = lookup();
		assert.deepEqual(t.toolNames, ["aikido_lookup"]);
		const { text, isError } = await t.run({ id: "12" });
		assert.equal(isError, false);
		assert.match(text, /^<<<AIKIDO-[0-9a-f]{16} \(untrusted data/);
		assert.match(text, /package: lodash/);
		assert.deepEqual(t.calls, ["12"]);
	});

	it("refuses an id that is not a whole number, without calling Aikido", async () => {
		const t = lookup();
		for (const id of ["../../admin", "12; drop", "", "1.5", "-3", "9".repeat(13)]) {
			const { text, isError } = await t.run({ id });
			assert.ok(isError, id);
			assert.match(text, /whole number/);
		}
		assert.deepEqual(t.calls, []);
	});

	it("reports an Aikido error as a tool error and lets a bug through", async () => {
		const failing = lookup(async () => {
			throw new AikidoError("not_found", "no such issue", 404);
		});
		assert.deepEqual(await failing.run({ id: "5" }), { text: "Aikido could not be read: no such issue", isError: true });
		const buggy = lookup(async () => {
			throw new TypeError("bug");
		});
		await assert.rejects(buggy.run({ id: "5" }), TypeError);
	});
});

describe("the host's record of how attempts ended", () => {
	const ledger = () => {
		const clock = { now: new Date("2026-10-06T09:00:00Z") };
		const file = join(mkdtempSync(join(tmpdir(), "aikido-outcomes-")), "attempts.json");
		return { clock, file, ledger: new AttemptLedger(file, { maxAttemptsPerIssue: 2, cooldownMinutes: 60, dailyCap: 5 }, () => clock.now) };
	};

	it("keeps the first record of a task and lists the newest first with the limits", () => {
		const { ledger: l, clock } = ledger();
		l.begin("1", "a");
		l.recordOutcome("a", { groupId: "1", outcome: "blocked" });
		l.recordOutcome("a", { groupId: "1", outcome: "pr_opened" });
		clock.now = new Date("2026-10-06T11:00:00Z");
		l.begin("1", "b");
		l.recordOutcome("b", { groupId: "1", outcome: "pr_opened", prUrl: "https://x.test/pr/1" });
		const facts = l.facts();
		assert.deepEqual({ cap: facts.dailyCap, per: facts.maxAttemptsPerIssue, cool: facts.cooldownMinutes, today: facts.today }, { cap: 5, per: 2, cool: 60, today: 2 });
		assert.deepEqual(facts.recent.map((entry) => [entry.taskId, entry.outcome, entry.attempts]), [["b", "pr_opened", 2], ["a", "blocked", 2]]);
	});

	it("starts empty on a missing file and reads a file written before outcomes were kept", () => {
		const { ledger: l, file } = ledger();
		assert.deepEqual(l.facts().recent, []);
		writeFileSync(file, JSON.stringify({ issues: { 1: { attempts: [{ taskId: "a", at: "2026-10-06T08:00:00Z" }] } }, days: {}, branches: {} }));
		assert.deepEqual(l.facts().recent, []);
		l.recordOutcome("a", { groupId: "1", outcome: "no_fix" });
		assert.equal(l.facts().recent[0]!.attempts, 1);
		writeFileSync(file, "{broken");
		assert.deepEqual(l.facts().recent, []);
	});

	it("is written by the result hook of a settled task", async () => {
		const stateDir = mkdtempSync(join(tmpdir(), "aikido-result-"));
		const settings = loadSettings({ AIKIDO_REPOSITORY_URL: REPO });
		const hooks = createFixerHooks({ settings, stateDir, aikido: { resolveIssue: async () => ({ group, issue }) } as any });
		await hooks.prepareInput!({ issue: { id: 12 }, repository: { url: REPO }, budget: { maxTokens: 1, maxMinutes: 1 } }, { taskId: "t9", log: () => undefined });
		const context = { taskId: "t9", input: {}, instruction: "", workspace: "/w", baseSha: "b".repeat(40), baseBranch: "main", envFor: undefined as any, client: undefined as any, log: () => undefined, answer: "", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 }, finalize: { status: "completed", branch: "agent/aikido-12-bbbbbbbb", commits: ["c1"], prUrl: "https://x.test/pr/2", patch: "" } } as ResultContext;
		const patch = (await hooks.result!({ usage: { totalTokens: 77, costUsd: 0 } }, context)) as any;
		assert.equal(patch.result.outcome, "pr_opened");
		const recorded = new AttemptLedger(join(stateDir, ATTEMPTS_FILE), { maxAttemptsPerIssue: 3, cooldownMinutes: 1, dailyCap: 9 }).facts().recent;
		assert.deepEqual(recorded.map((entry) => [entry.taskId, entry.groupId, entry.outcome, entry.branch, entry.prUrl, entry.tokens]), [["t9", "12", "pr_opened", "agent/aikido-12-bbbbbbbb", "https://x.test/pr/2", 77]]);
	});
});

describe("seeding the account with earlier attempts (AIKIDO_LEDGER_IMPORT)", () => {
	const dir = () => mkdtempSync(join(tmpdir(), "aikido-import-"));
	const limits = { maxAttemptsPerIssue: 2, cooldownMinutes: 60, dailyCap: 5 };
	const rows = [
		{ issueId: 101, outcome: "pr_opened", at: "2026-10-01T09:00:00Z", branch: "agent/aikido-101-abcd1234", prUrl: "https://github.com/Acme/Shop/pull/3", tokens: 1200 },
		{ issueId: "102", outcome: "no_fix", at: "2026-10-02T09:00:00+02:00" },
		{ issueId: 103, outcome: "failed:branch_exhausted", at: "2026-10-03T09:00:00Z" },
	];
	const withFile = (content: unknown) => {
		const d = dir();
		const file = join(d, "past.json");
		writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
		return { d, file, ledger: new AttemptLedger(join(d, "attempts.json"), limits, () => new Date("2026-10-06T09:00:00Z")) };
	};

	it("imports valid rows once, newest first in the account, marked as imported history", () => {
		const { ledger, file } = withFile(rows);
		assert.deepEqual(ledger.importHistory(file), { imported: 3, alreadyThere: 0, invalid: 0 });
		const recent = ledger.facts().recent;
		assert.deepEqual(recent.map((entry) => [entry.groupId, entry.outcome, entry.imported]), [["103", "failed:branch_exhausted", true], ["102", "no_fix", true], ["101", "pr_opened", true]]);
		assert.equal(recent[2]!.at, "2026-10-01T09:00:00.000Z");
		assert.equal(recent[1]!.at, "2026-10-02T07:00:00.000Z", "stored as UTC");
		assert.deepEqual([recent[2]!.branch, recent[2]!.prUrl, recent[2]!.tokens], ["agent/aikido-101-abcd1234", "https://github.com/Acme/Shop/pull/3", 1200]);
	});

	it("is idempotent: the same file, or an overlapping one, adds nothing twice", () => {
		const { ledger, file, d } = withFile({ attempts: rows });
		ledger.importHistory(file);
		assert.deepEqual(ledger.importHistory(file), { imported: 0, alreadyThere: 3, invalid: 0 });
		const more = join(d, "more.json");
		writeFileSync(more, JSON.stringify([...rows, { issueId: 104, outcome: "blocked", at: "2026-10-04T09:00:00Z" }]));
		assert.deepEqual(ledger.importHistory(more), { imported: 1, alreadyThere: 3, invalid: 0 });
		assert.equal(ledger.facts(50).recent.length, 4);
	});

	it("does not count against the daily cap, the attempt limits or the cool-down, and keeps what the new build recorded", () => {
		const { ledger, file } = withFile(rows);
		ledger.begin("101", "t-live");
		ledger.recordOutcome("t-live", { groupId: "101", outcome: "pr_opened" });
		ledger.importHistory(file);
		const facts = ledger.facts(50);
		assert.equal(facts.today, 1);
		assert.ok(facts.recent.some((entry) => entry.taskId === "t-live" && !entry.imported));
		assert.equal(ledger.begin("102", "t2").ok, true);
		assert.equal(ledger.begin("101", "t3").ok, false, "only the live attempt counts for the limit (and its cool-down)");
	});

	it("skips rows that are not valid and says how many", () => {
		const { ledger, file } = withFile([
			...rows.slice(0, 1),
			{ issueId: "../x", outcome: "pr_opened", at: "2026-10-01T09:00:00Z" },
			{ issueId: 1, outcome: "exploded", at: "2026-10-01T09:00:00Z" },
			{ issueId: 1, outcome: "no_fix", at: "yesterday" },
			{ issueId: 1, outcome: "no_fix", at: "2026-10-01T09:00:00Z", prUrl: "http://evil.test/x" },
			{ issueId: 1, outcome: "no_fix", at: "2026-10-01T09:00:00Z", branch: "has space" },
			{ issueId: 1, outcome: "no_fix", at: "2026-10-01T09:00:00Z", tokens: -4 },
			null,
			"text",
		]);
		assert.deepEqual(ledger.importHistory(file), { imported: 1, alreadyThere: 0, invalid: 8 });
	});

	it("fails loudly on a file that cannot be read or is not a list", () => {
		const { ledger, d } = withFile(rows);
		assert.throws(() => ledger.importHistory(join(d, "missing.json")), /AIKIDO_LEDGER_IMPORT .* cannot be read/);
		assert.throws(() => ledger.importHistory(withFile("{broken").file), /cannot be read as JSON/);
		assert.throws(() => ledger.importHistory(withFile({ not: "a list" }).file), /must hold a list/);
	});

	it("keeps the newest 200 when a file holds more", () => {
		const many = Array.from({ length: 230 }, (_, i) => ({ issueId: i + 1, outcome: "no_fix", at: new Date(Date.UTC(2026, 0, 1) + i * 3_600_000).toISOString() }));
		const { ledger, file } = withFile(many);
		ledger.importHistory(file);
		const kept = ledger.facts(500).recent;
		assert.equal(kept.length, 200);
		assert.equal(kept.at(-1)!.groupId, "31");
	});

	it("runs once at startup through the setting and shows in the chat's account", async () => {
		const { d, file } = withFile(rows);
		const settings = loadSettings({ AIKIDO_REPOSITORY_URL: REPO, AIKIDO_LEDGER_IMPORT: file });
		assert.equal(settings.ledgerImport, file);
		const logged: string[] = [];
		const options = { settings, stateDir: d, aikido: { resolveIssue: async () => ({ group, issue }) } as any, log: (_l: string, event: string, fields?: any) => void logged.push(`${event}:${fields?.imported}`) };
		createFixerHooks(options);
		createFixerHooks(options);
		assert.deepEqual(logged, ["fixer_ledger_imported:3", "fixer_ledger_imported:0"], "the second start imports nothing");
		const chat = fixerChat({ settings, aikido: options.aikido, stateDir: d });
		const text = await chat.context!();
		assert.match(text, /- issue 101: pr_opened at 2026-10-01T09:00:00.000Z \(imported history\), branch agent\/aikido-101-abcd1234, https:\/\/github.com\/Acme\/Shop\/pull\/3, 1200 tokens$/m);
		assert.ok(!text.includes("attempts so far"), "imported rows do not claim an attempt count");
		assert.equal(loadSettings({ AIKIDO_REPOSITORY_URL: REPO }).ledgerImport, undefined);
	});

	it("does not start with an unreadable import file", () => {
		const settings = loadSettings({ AIKIDO_REPOSITORY_URL: REPO, AIKIDO_LEDGER_IMPORT: "/nonexistent/past.json" });
		assert.throws(() => createFixerHooks({ settings, stateDir: dir(), aikido: {} as any }), /AIKIDO_LEDGER_IMPORT/);
	});
});

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import { DEFAULT_EVENTS, HandlerStore, handlersDir, parseDecision, type HandlerEvent, type ResultContext } from "@somework/agent-kit";
import card from "../card.json" with { type: "json" };
import type { FeedbackItem, PullRequestReader, PullRequestState } from "../src/followup.ts";
import { AttemptLedger } from "../src/attempts.ts";
import { createFixerHooks, nextCheck } from "../src/hooks.ts";
import { renderWatchHandler, seedHandler, WATCH_HANDLER, WATCH_TOPIC } from "../src/seed.ts";
import { loadSettings } from "../src/settings.ts";

const REPO = "https://github.com/Acme/Shop.git";
const PR = "https://github.com/Acme/Shop/pull/42";
const BRANCH = "agent/aikido-12-abcdef12";
const group = { id: 12, title: "Prototype pollution in lodash", type: "open_source", severity: "high", group_status: "new" };
const issue = { id: 99, group_id: 12, status: "open", affected_package: "lodash", installed_version: "4.17.20", patched_versions: ["4.17.21"], code_repo_name: "Acme/Shop" };
const settings = (env: NodeJS.ProcessEnv = {}) => loadSettings({ AIKIDO_REPOSITORY_URL: REPO, ...env });

/** The handler as the sandbox runs it. */
async function installed(env: NodeJS.ProcessEnv = {}) {
	const root = mkdtempSync(join(tmpdir(), "aikido-watch-"));
	mkdirSync(join(root, ".somework-events"));
	const file = join(root, ".somework-events", `h-watch-${Math.random().toString(16).slice(2)}.mjs`);
	writeFileSync(file, renderWatchHandler(settings(env)));
	const module = await import(pathToFileURL(file).href);
	let n = 0;
	return {
		run: (data: unknown, key = `github:watch:w1:d${++n}`, now = "2026-10-20T10:00:00.000Z") =>
			module.default({ event: { id: `evt_${n}`, seq: n, topic: WATCH_TOPIC, source: "hub", key, data, classification: "internal", verified: true, depth: 0, untrusted: true }, agent: { id: "agent/aikido-fixer", role: "aikido-fixer" }, now }),
	};
}
const watchEvent = (topic: string, event: Record<string, unknown>, over: Record<string, unknown> = {}) => ({ watchId: "w1", topic, repository: "acme/shop", number: 42, event: { sender: "reviewer", ...event }, ...over });
const changes = watchEvent("github.pull_request_review.submitted", { review: { state: "changes_requested", author: "reviewer" } });
const failedCheck = watchEvent("github.check_run.completed", { conclusion: "failure", name: "build" });

describe("the watch handler", () => {
	it("turns a review that asks for changes into one follow-up task that names only the pull request, and the card and the kit accept it", async () => {
		const h = await installed();
		const decision = await h.run(changes);
		assert.equal(decision.action, "submit");
		assert.match(decision.reason, /a review \(changes_requested\) on pull request #42/);
		assert.deepEqual(decision.task, {
			capability: { id: "code.fix.followup", version: "1" },
			input: { repository: { url: REPO }, followUp: { pullRequest: PR, round: 1, source: "watch" } },
			budget: { maxTokens: 300_000, maxMinutes: 30 },
		});
		const schema = card.capabilities.find((c) => c.id === "code.fix.followup")!.inputSchema as any;
		const input = { ...decision.task.input, budget: decision.task.budget };
		for (const key of schema.required) assert.ok(key in input, key);
		assert.deepEqual(Object.keys(input).filter((key) => !(key in schema.properties)), []);
		for (const key of schema.properties.followUp.required) assert.ok(key in input.followUp, key);
		assert.deepEqual(Object.keys(input.followUp).filter((key) => !(key in schema.properties.followUp.properties)), []);
		assert.match(PR, new RegExp(schema.properties.followUp.properties.pullRequest.pattern));
		const parsed = parseDecision(decision, { id: "evt_1", topic: WATCH_TOPIC, classification: "internal" } as HandlerEvent, { submitBudgetCap: { maxTokens: 300_000, maxMinutes: 30 }, classificationLevels: DEFAULT_EVENTS.classificationLevels } as never);
		assert.ok(parsed.ok, parsed.ok ? "" : parsed.error);
	});

	it("looks at reviews with comments, review comments, comments on the pull request and failed checks, and at nothing else", async () => {
		const h = await installed({ AIKIDO_WATCH_COOLDOWN_SECONDS: "1" });
		const at = (n: number) => `2026-10-20T10:${String(n * 5).padStart(2, "0")}:00.000Z`;
		let n = 0;
		for (const worth of [
			watchEvent("github.pull_request_review.submitted", { review: { state: "commented" } }),
			watchEvent("github.pull_request_review_comment.created", { comment: { author: "reviewer", body: "this is wrong" } }),
			watchEvent("github.issue_comment.created", { isPullRequest: true, comment: { author: "reviewer" } }),
			watchEvent("github.check_run.completed", { conclusion: "timed_out" }),
			failedCheck,
		]) assert.equal((await h.run(worth, undefined, at(n++))).action, "submit", worth.topic);
		for (const idle of [
			watchEvent("github.pull_request_review.submitted", { review: { state: "approved" } }),
			watchEvent("github.pull_request_review.dismissed", {}),
			watchEvent("github.issue_comment.created", { isPullRequest: false }),
			watchEvent("github.check_run.completed", { conclusion: "success" }),
			watchEvent("github.pull_request.synchronize", {}),
			watchEvent("github.pull_request.merged", { merged: true }),
			watchEvent("github.pull_request.closed", {}),
		]) assert.equal((await h.run(idle, undefined, at(n++))).action, "drop", idle.topic);
	});

	it("drops another repository, a bad number and the logins it was told to ignore", async () => {
		const h = await installed({ AIKIDO_WATCH_IGNORE_SENDERS: "Fixer-Bot, other" });
		assert.equal((await h.run({ ...changes, repository: "acme/other" })).action, "drop");
		for (const number of [0, -1, 1.5, "x", undefined]) assert.equal((await h.run({ ...changes, number })).action, "drop", String(number));
		assert.equal((await h.run(watchEvent("github.pull_request_review.submitted", { sender: "fixer-bot", review: { state: "commented" } }))).action, "drop");
	});

	it("handles a delivery once, starts one follow-up per pull request in a cool-down, then again, and stops at the per-pull-request and daily limits", async () => {
		const h = await installed({ AIKIDO_WATCH_MAX_PER_PR: "3", AIKIDO_FOLLOWUP_CAP_PER_DAY: "10" });
		assert.equal((await h.run(changes, "github:watch:w1:a", "2026-10-20T10:00:00.000Z")).action, "submit");
		assert.equal((await h.run(changes, "github:watch:w1:a", "2026-10-20T10:10:00.000Z")).action, "drop", "the same delivery again");
		const burst = await h.run(failedCheck, "github:watch:w1:b", "2026-10-20T10:00:50.000Z");
		assert.equal(burst.action, "drop");
		assert.match(burst.reason, /started 50 s ago/);
		assert.equal((await h.run(failedCheck, "github:watch:w1:c", "2026-10-20T10:03:00.000Z")).action, "submit", "after the cool-down");
		assert.equal((await h.run(failedCheck, "github:watch:w1:d", "2026-10-20T10:07:00.000Z")).action, "submit");
		const capped = await h.run(failedCheck, "github:watch:w1:e", "2026-10-20T10:11:00.000Z");
		assert.equal(capped.action, "deliver");
		assert.match(capped.reason, /3 follow-ups of pull request #42/);
		assert.equal((await h.run(watchEvent("github.pull_request_review.submitted", { review: { state: "commented" } }, { number: 43 }), "github:watch:w2:a", "2026-10-20T10:12:00.000Z")).action, "submit", "another pull request");
		const small = await installed({ AIKIDO_FOLLOWUP_CAP_PER_DAY: "1" });
		assert.equal((await small.run(changes, "k1", "2026-10-20T10:00:00.000Z")).action, "submit");
		const daily = await small.run(watchEvent("github.pull_request_review.submitted", { review: { state: "commented" } }, { number: 43 }), "k2", "2026-10-20T11:00:00.000Z");
		assert.equal(daily.action, "deliver");
		assert.match(daily.reason, /daily cap/);
		assert.equal((await small.run(changes, "k3", "2026-10-21T10:00:00.000Z")).action, "submit", "a new day");
	});

	it("is installed only when the service can watch pull requests and follow-ups are on", () => {
		const dir = mkdtempSync(join(tmpdir(), "aikido-seed-"));
		seedHandler({ stateDir: dir, settings: settings(), log: () => undefined });
		assert.equal(new HandlerStore(handlersDir(dir)).current(WATCH_HANDLER), undefined, "no WATCH_URL");
		seedHandler({ stateDir: dir, settings: settings(), log: () => undefined, watches: true });
		const current = new HandlerStore(handlersDir(dir)).current(WATCH_HANDLER)!;
		assert.ok(current);
		assert.deepEqual(current.topics, [WATCH_TOPIC]);
		const off = mkdtempSync(join(tmpdir(), "aikido-seed-"));
		seedHandler({ stateDir: off, settings: settings({ AIKIDO_FOLLOWUP_MINUTES: "off" }), log: () => undefined, watches: true });
		assert.equal(new HandlerStore(handlersDir(off)).current(WATCH_HANDLER), undefined, "follow-ups off");
	});
});

const open = (feedback: FeedbackItem[], state: PullRequestState["state"] = "open"): PullRequestReader => ({ read: async () => ({ state, headSha: "a".repeat(40), author: "fixer-bot", feedback, ci: { visible: false, pending: 0 } }) });
const feedback: FeedbackItem[] = [{ kind: "review", author: "anna", at: "2026-10-20T10:05:00Z", body: "CHANGES_REQUESTED: add a test" }];
const resultContext = (over: Partial<ResultContext> = {}) => ({ taskId: "t1", ...over }) as ResultContext;
const noChange = { finalize: { status: "no_changes", branch: BRANCH, commits: [], patch: "" } as never };

function rig(options: { opened?: boolean; reader?: PullRequestReader; watching?: boolean; watchFails?: boolean } = {}) {
	const stateDir = mkdtempSync(join(tmpdir(), "aikido-watch-hooks-"));
	if (options.opened !== false) new AttemptLedger(join(stateDir, "aikido-attempts.json"), { maxAttemptsPerIssue: 2, cooldownMinutes: 0, dailyCap: 5 }).recordOutcome("t0", { groupId: "12", outcome: "pr_opened", branch: BRANCH, prUrl: PR });
	const requests: any[] = [];
	const watched: string[] = [];
	const hooks = createFixerHooks({
		settings: settings(),
		stateDir,
		boundary: () => "b",
		reader: options.reader ?? open(feedback),
		timers: { request: async (ask) => (requests.push(ask), { id: "tmr_9", key: String(ask.key), dueAt: "2026-10-20T14:00:00.000Z", note: ask.note }) },
		...(options.watching === false ? {} : { watches: { watch: async (ask) => { if (options.watchFails) throw new Error("the hub could not be reached"); watched.push(String(ask.url)); return { id: "w1", created: true } as never; } } }),
		aikido: { resolveIssue: async () => ({ group, issue }) },
	});
	return { hooks, requests, watched };
}
const watchInput = { repository: { url: REPO }, followUp: { pullRequest: PR.toLowerCase(), round: 1, source: "watch" } };
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe("a follow-up that a watch started", () => {
	it("takes the issue and the branch from the agent's own record of the pull request, and works on that branch", async () => {
		const { hooks } = rig();
		const prepared = (await hooks.prepareInput!(watchInput, { taskId: "t1" } as never)) as any;
		assert.equal(prepared.agentKey, "aikido-followup:12");
		assert.equal(prepared.repository.ref, BRANCH);
		assert.equal(await hooks.beforeWorkspace!(prepared, { taskId: "t1" } as never), undefined, "feedback to act on: not skipped");
		assert.equal(hooks.branchName!({ input: prepared, taskId: "t1", baseSha: "a".repeat(40) }), BRANCH);
	});

	it("refuses a pull request the agent did not open and record", async () => {
		const { hooks } = rig({ opened: false });
		await assert.rejects(hooks.prepareInput!(watchInput, { taskId: "t1" } as never), /not one this agent opened/);
		const other = rig();
		await assert.rejects(other.hooks.prepareInput!({ ...watchInput, followUp: { ...watchInput.followUp, pullRequest: "https://github.com/Acme/Shop/pull/99" } }, { taskId: "t2" } as never), /not one this agent opened/);
	});

	it("renews the watch after the follow-up while the pull request is open, and asks for no timer", async () => {
		const r = rig();
		await r.hooks.prepareInput!(watchInput, { taskId: "t1" } as never);
		r.hooks.result!({}, resultContext(noChange));
		r.hooks.onSettled!("t1", { type: "completed" } as never);
		await settle();
		assert.deepEqual(r.watched, [PR], "the address the agent recorded");
		assert.deepEqual(r.requests, [], "the events decide when to look again");
	});
});

describe("the pull requests the agent opens", () => {
	const opened = { finalize: { status: "completed", branch: BRANCH, commits: ["b".repeat(40)], prUrl: PR, patch: "" } as never };
	const fixInput = { issue: { id: 12 }, repository: { url: REPO }, budget: { maxTokens: 300_000, maxMinutes: 30 } };

	it("are watched from the moment they are opened, with one late timer as the safety net", async () => {
		const r = rig({ opened: false });
		await r.hooks.prepareInput!(fixInput, { taskId: "fix1", log: () => undefined } as never);
		const reported = r.hooks.result!({ usage: { totalTokens: 10 } }, resultContext({ taskId: "fix1", ...opened })) as any;
		assert.equal(reported.result.outcome, "pr_opened");
		r.hooks.onSettled!("fix1", { type: "completed" } as never);
		await settle();
		assert.deepEqual(r.watched, [PR]);
		assert.equal(r.requests.length, 1);
		assert.equal(r.requests[0].delaySeconds, 240 * 60, "the safety net");
		assert.equal(r.requests[0].payload.round, 1);
	});

	it("keep the old timer table when the service cannot watch, and a hub that cannot be reached costs only the events", async () => {
		const plain = rig({ opened: false, watching: false });
		await plain.hooks.prepareInput!(fixInput, { taskId: "fix1", log: () => undefined } as never);
		plain.hooks.result!({}, resultContext({ taskId: "fix1", ...opened }));
		plain.hooks.onSettled!("fix1", { type: "completed" } as never);
		await settle();
		assert.equal(plain.requests[0].delaySeconds, 10 * 60, "the first delay of the table");
		const down = rig({ opened: false, watchFails: true });
		await down.hooks.prepareInput!(fixInput, { taskId: "fix1", log: () => undefined } as never);
		down.hooks.result!({}, resultContext({ taskId: "fix1", ...opened }));
		assert.doesNotThrow(() => down.hooks.onSettled!("fix1", { type: "completed" } as never));
		await settle();
		assert.equal(down.requests.length, 1, "the safety net is still asked for");
	});
});

describe("the timer while pull requests are watched", () => {
	const s = { followUpMinutes: [10, 20, 40], ciWatchMinutes: 10, safetyCheckMinutes: 240 };
	const fix = { summary: { groupId: "12" } } as never;
	const followUp = (round: number, pr = "open") => ({ followUp: { input: { pullRequest: PR, number: 42, branch: BRANCH, round }, pullRequest: { state: pr } } }) as never;
	it("is one late look after the pull request is opened, and nothing after any follow-up", () => {
		assert.deepEqual(nextCheck(s, fix, { outcome: "pr_opened", prUrl: PR, branch: BRANCH }, true), { round: 1, minutes: 240, pullRequest: PR, branch: BRANCH });
		for (const outcome of ["followup_pushed", "no_followup_needed", "skipped"]) assert.equal(nextCheck(s, followUp(1), { outcome }, true), undefined, outcome);
		assert.equal(nextCheck(s, fix, { outcome: "no_fix" }, true), undefined);
		assert.equal(nextCheck({ ...s, followUpMinutes: [] }, fix, { outcome: "pr_opened", prUrl: PR, branch: BRANCH }, true), undefined, "follow-ups off");
	});
	it("keeps the table of delays when the pull requests are not watched", () => {
		assert.deepEqual(nextCheck(s, fix, { outcome: "pr_opened", prUrl: PR, branch: BRANCH }), { round: 1, minutes: 10, pullRequest: PR, branch: BRANCH });
		assert.equal(nextCheck(s, followUp(1), { outcome: "no_followup_needed" })?.minutes, 20);
	});
});

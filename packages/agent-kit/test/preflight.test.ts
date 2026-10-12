import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { loadConfig } from "../src/config.ts";
import { describeAgent } from "../src/describe.ts";
import { createHealthServer } from "../src/health.ts";
import { githubPreflight, githubPreflightFor } from "../src/github-preflight.ts";
import type { LogFields } from "../src/log.ts";
import { Metrics } from "../src/metrics.ts";
import { Preflight, type PreflightCheck } from "../src/preflight.ts";
import type { AgentProfile, ServiceContext } from "../src/profile.ts";

interface Line {
	level: string;
	event: string;
	fields: LogFields;
}

function rig(options: { secrets?: string[]; everyMs?: number; timeoutMs?: number } = {}) {
	let next: PreflightCheck[] | Error = [];
	let calls = 0;
	const lines: Line[] = [];
	const metrics = new Metrics();
	const preflight = new Preflight({
		checks: async () => {
			calls++;
			if (next instanceof Error) throw next;
			return next;
		},
		log: (level, event, fields) => lines.push({ level, event, fields: fields ?? {} }),
		metrics,
		...options,
	});
	return {
		preflight,
		metrics,
		lines,
		calls: () => calls,
		answer: (checks: PreflightCheck[] | Error) => {
			next = checks;
		},
		failures: () => lines.filter((line) => line.event === "preflight_failed"),
	};
}

const pulls = (ok: boolean, detail?: string): PreflightCheck => ({ name: "github-pull-requests", ok, severity: "warning", ...(detail ? { detail } : {}) });

describe("the preflight runner", () => {
	it("keeps the latest results and counts each check as a gauge", async () => {
		const world = rig();
		world.answer([pulls(false, "the token lacks Pull requests: read"), { name: "jira", ok: true, severity: "error" }]);
		await world.preflight.run();
		assert.deepEqual(world.preflight.results().map(({ name, ok, severity }) => ({ name, ok, severity })), [
			{ name: "github-pull-requests", ok: false, severity: "warning" },
			{ name: "jira", ok: true, severity: "error" },
		]);
		const text = world.metrics.render();
		assert.match(text, /somework_preflight_ok\{check="github-pull-requests"\} 0/);
		assert.match(text, /somework_preflight_ok\{check="jira"\} 1/);
		assert.match(text, /# TYPE somework_preflight_ok gauge/);
	});

	it("logs preflight_failed once per change of state, never on every run", async () => {
		const world = rig();
		world.answer([pulls(false, "403")]);
		for (let run = 0; run < 4; run++) await world.preflight.run();
		assert.equal(world.failures().length, 1);
		assert.equal(world.failures()[0]!.level, "warn");
		assert.deepEqual(world.failures()[0]!.fields, { check: "github-pull-requests", severity: "warning", blocking: false, detail: "403" });

		world.answer([pulls(true)]);
		await world.preflight.run();
		assert.equal(world.lines.filter((line) => line.event === "preflight_recovered").length, 1);
		assert.match(world.metrics.render(), /somework_preflight_ok\{check="github-pull-requests"\} 1/);
		assert.equal(world.failures().length, 1, "recovery is not a failure");

		world.answer([pulls(false, "403")]);
		await world.preflight.run();
		assert.equal(world.failures().length, 2, "turning bad again is a new change");
	});

	it("says nothing about a check that passes from the first run", async () => {
		const world = rig();
		world.answer([pulls(true)]);
		await world.preflight.run();
		await world.preflight.run();
		assert.deepEqual(world.lines, []);
	});

	it("removes known secrets and token-shaped text from the detail, the log and the results", async () => {
		const secret = "tok-not-a-real-secret-12345";
		const world = rig({ secrets: [secret] });
		world.answer([pulls(false, `GitHub refused ${secret} and also ghp_${"a".repeat(30)}`)]);
		await world.preflight.run();
		const everything = JSON.stringify([world.lines, world.preflight.results(), world.metrics.render()]);
		assert.ok(!everything.includes(secret));
		assert.ok(!everything.includes("ghp_aaaa"));
		assert.match(world.preflight.results()[0]!.detail!, /GitHub refused/);
	});

	it("shows a hook that throws as one failed warning, and clears it when the hook works again", async () => {
		const world = rig({ secrets: ["hunter2-hunter2"] });
		world.answer(new Error("boom hunter2-hunter2"));
		await world.preflight.run();
		const [only] = world.preflight.results();
		assert.equal(only!.name, "preflight");
		assert.equal(only!.ok, false);
		assert.equal(only!.severity, "warning");
		assert.match(only!.detail!, /could not run: boom/);
		assert.ok(!JSON.stringify(world.lines).includes("hunter2-hunter2"));
		await world.preflight.run();
		assert.equal(world.failures().length, 1);

		world.answer([pulls(true)]);
		await world.preflight.run();
		assert.deepEqual(world.preflight.results().map((result) => result.name), ["github-pull-requests"]);
		assert.match(world.metrics.render(), /somework_preflight_ok\{check="preflight"\} 1/);
	});

	it("gives up on a hook that never answers", async () => {
		const metrics = new Metrics();
		const lines: Line[] = [];
		const preflight = new Preflight({ checks: () => new Promise(() => {}), log: (level, event, fields) => lines.push({ level, event, fields: fields ?? {} }), metrics, timeoutMs: 30 });
		await preflight.run();
		assert.match(preflight.results()[0]!.detail!, /took too long/);
		assert.equal(lines.length, 1);
	});

	it("joins a run that is still going instead of starting another", async () => {
		const world = rig();
		world.answer([pulls(true)]);
		await Promise.all([world.preflight.run(), world.preflight.run(), world.preflight.run()]);
		assert.equal(world.calls(), 1);
	});

	it("only a failed error check marked blocking keeps the agent from being ready", async () => {
		const world = rig();
		world.answer([
			{ name: "a", ok: false, severity: "warning", blocking: true },
			{ name: "b", ok: false, severity: "error" },
			{ name: "c", ok: true, severity: "error", blocking: true },
			{ name: "d", ok: false, severity: "error", blocking: true },
		]);
		await world.preflight.run();
		assert.deepEqual(world.preflight.blocking(), ["d"]);
	});

	it("runs again every interval, and only once with no interval", async () => {
		const timed = rig({ everyMs: 15 });
		const stop = new AbortController();
		timed.answer([pulls(false, "403")]);
		timed.preflight.start(stop.signal);
		const deadline = Date.now() + 3000;
		while (timed.calls() < 3 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
		stop.abort();
		assert.ok(timed.calls() >= 3);
		assert.equal(timed.failures().length, 1, "three runs, one line");
		const after = timed.calls();
		await new Promise((resolve) => setTimeout(resolve, 60));
		assert.ok(timed.calls() <= after + 1, "stopped with the service");

		const once = rig({ everyMs: 0 });
		once.answer([pulls(true)]);
		once.preflight.start(new AbortController().signal);
		await new Promise((resolve) => setTimeout(resolve, 80));
		assert.equal(once.calls(), 1);
	});
});

describe("/ready", () => {
	const serve = async (preflight?: Preflight) => {
		const server = createHealthServer({ runtime: { health: () => ({ ready: true }) } as any, metrics: new Metrics(), ...(preflight ? { preflight } : {}) });
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() };
	};

	it("lists the preflight checks, and a warning or a plain error does not take the agent down", async () => {
		const world = rig();
		world.answer([pulls(false, "the token lacks Pull requests: read"), { name: "jira", ok: false, severity: "error", detail: "no answer" }]);
		await world.preflight.run();
		const health = await serve(world.preflight);
		try {
			const response = await fetch(`${health.base}/ready`);
			assert.equal(response.status, 200);
			const body = (await response.json()) as any;
			assert.equal(body.ready, true);
			assert.deepEqual(body.failed, []);
			assert.deepEqual(body.preflight.map((check: any) => [check.name, check.ok, check.severity, check.detail]), [
				["github-pull-requests", false, "warning", "the token lacks Pull requests: read"],
				["jira", false, "error", "no answer"],
			]);
		} finally {
			health.close();
		}
	});

	it("answers 503 for a failed error check the role marked blocking, and names it", async () => {
		const world = rig();
		world.answer([{ name: "git-token", ok: false, severity: "error", blocking: true, detail: "expired" }]);
		await world.preflight.run();
		const health = await serve(world.preflight);
		try {
			const response = await fetch(`${health.base}/ready`);
			assert.equal(response.status, 503);
			const body = (await response.json()) as any;
			assert.equal(body.ready, false);
			assert.deepEqual(body.failed, ["preflight: git-token"]);
		} finally {
			health.close();
		}
	});

	it("keeps the old answer when the role has no preflight", async () => {
		const health = await serve();
		try {
			assert.deepEqual(await (await fetch(`${health.base}/ready`)).json(), { ready: true, failed: [] });
		} finally {
			health.close();
		}
	});
});

describe("settings and /profile", () => {
	const base = { SOMEWORK_URL: "http://127.0.0.1:1", SOMEWORK_KEY_FILE: "/k", SANDBOX_URL: "http://127.0.0.1:2" };

	it("PREFLIGHT_MINUTES defaults to 15, accepts 0 and refuses nonsense", () => {
		assert.equal(loadConfig(base).preflight.minutes, 15);
		assert.equal(loadConfig({ ...base, PREFLIGHT_MINUTES: "0" }).preflight.minutes, 0);
		assert.equal(loadConfig({ ...base, PREFLIGHT_MINUTES: "5" }).preflight.minutes, 5);
		for (const bad of ["-1", "1.5", "soon"]) assert.throws(() => loadConfig({ ...base, PREFLIGHT_MINUTES: bad }), /PREFLIGHT_MINUTES/);
	});

	it("/profile shows the checks, and they are not part of the setup hash", () => {
		const profile: AgentProfile = { id: "role", capabilities: [{ id: "x.y", version: "1" }], approvalPatterns: [], defaultBudget: { maxTokens: 1, maxMinutes: 1 }, git: { push: false, pullRequest: false, branchPrefix: "agent" }, skills: { allow: [] } };
		const input = { profile, agentId: "agent/x", model: { provider: "p", modelId: "m" }, allowedModels: [], limits: { maxTokensCap: 1, maxMinutesCap: 1, dailyTokenLimit: 1 }, concurrency: 1, approvalPatterns: [], git: { app: false, token: false, tokenHosts: [], draft: false }, chat: { mode: "off" }, events: { enabled: false }, observe: { enabled: false }, includePrompt: false };
		const without = describeAgent(input);
		const withChecks = describeAgent({ ...input, preflight: { everyMinutes: 15, checks: [{ name: "jira", ok: false, severity: "error", detail: "no answer", checkedAt: "2026-10-12T10:00:00.000Z" }] } });
		assert.equal(without.preflight, undefined);
		assert.equal(withChecks.preflight?.checks[0]?.name, "jira");
		assert.equal(withChecks.preflight?.everyMinutes, 15);
		assert.equal(withChecks.hash, without.hash);
	});
});

describe("GitHub checks of a role that holds a git token", () => {
	const TOKEN = "github_pat_NOTAREALTOKEN_0123456789abcdef";
	type Answer = number | "network" | "timeout";

	function github(answers: Record<string, Answer>) {
		const seen: { url: string; authorization: string | null }[] = [];
		const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			seen.push({ url, authorization: new Headers(init?.headers).get("authorization") });
			const answer = answers[new URL(url).pathname + new URL(url).search] ?? 200;
			if (answer === "network") throw new TypeError(`fetch failed for ${TOKEN}`);
			if (answer === "timeout") throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
			return new Response(answer === 200 ? "[]" : `{"message":"nope ${TOKEN}"}`, { status: answer });
		}) as typeof fetch;
		return { fetcher, seen };
	}

	const options = (fetcher: typeof fetch, extra: Partial<Parameters<typeof githubPreflight>[0]> = {}) => ({
		repositories: ["https://github.com/acme/web.git"],
		token: async () => TOKEN,
		tokenHosts: ["github.com"],
		withoutPullRequests: "branches are found through git instead",
		fetch: fetcher,
		...extra,
	});

	it("passes when the token reads both the contents and the pull requests", async () => {
		const { fetcher, seen } = github({});
		const checks = await githubPreflight(options(fetcher))();
		assert.deepEqual(checks, [
			{ name: "github-repository", ok: true, severity: "error" },
			{ name: "github-pull-requests", ok: true, severity: "warning" },
		]);
		assert.deepEqual(seen.map((call) => call.url), ["https://api.github.com/repos/acme/web/contents", "https://api.github.com/repos/acme/web/pulls?per_page=1"]);
		assert.ok(seen.every((call) => call.authorization === `Bearer ${TOKEN}`));
	});

	it("a 403 on the pull requests is a failed warning that says what is missing and what still works", async () => {
		const { fetcher } = github({ "/repos/acme/web/pulls?per_page=1": 403 });
		const checks = await githubPreflight(options(fetcher))();
		assert.deepEqual(checks[1], { name: "github-pull-requests", ok: false, severity: "warning", detail: "the token lacks Pull requests: read; branches are found through git instead" });
		assert.equal(checks[0]!.ok, true);
	});

	it("a token that cannot read the contents is a failed error", async () => {
		for (const status of [401, 403, 404]) {
			const { fetcher } = github({ "/repos/acme/web/contents": status });
			const [contents] = await githubPreflight(options(fetcher))();
			assert.equal(contents!.name, "github-repository");
			assert.equal(contents!.ok, false);
			assert.equal(contents!.severity, "error", String(status));
			assert.match(contents!.detail!, new RegExp(String(status)));
		}
	});

	it("GitHub being down is a warning, not a verdict on the token, and no body or token reaches the detail", async () => {
		for (const answer of [502, "network", "timeout"] as const) {
			const { fetcher } = github({ "/repos/acme/web/contents": answer, "/repos/acme/web/pulls?per_page=1": answer });
			const checks = await githubPreflight(options(fetcher))();
			assert.deepEqual(checks.map((check) => [check.ok, check.severity]), [[false, "warning"], [false, "warning"]], String(answer));
			assert.ok(!JSON.stringify(checks).includes("NOTAREALTOKEN"));
			assert.ok(!JSON.stringify(checks).includes("nope"));
		}
	});

	it("names the repository when there are several, and uses the owner's own token", async () => {
		const { fetcher, seen } = github({ "/repos/other/api/pulls?per_page=1": 403 });
		const checks = await githubPreflight(
			options(fetcher, { repositories: ["https://github.com/acme/web.git", "https://github.com/other/api"], token: async (owner) => (owner === "other" ? "other-owner-token-xyz" : TOKEN) }),
		)();
		assert.equal(checks[1]!.detail, "other/api: the token lacks Pull requests: read; branches are found through git instead");
		assert.equal(seen.find((call) => call.url.includes("/repos/other/api/contents"))!.authorization, "Bearer other-owner-token-xyz");
	});

	it("does not check what it cannot: no token, a host the token must not go to, a repository that is not on GitHub", async () => {
		const { fetcher, seen } = github({});
		const checks = await githubPreflight(
			options(fetcher, { repositories: ["https://github.com/acme/web.git", "https://gitlab.example.com/acme/web.git", "https://github.com/free/open"], tokenHosts: ["github.com"], token: async (owner) => (owner === "free" ? undefined : TOKEN) }),
		)();
		assert.equal(checks.length, 2);
		assert.deepEqual([...new Set(seen.map((call) => new URL(call.url).pathname.split("/")[3]))], ["web"]);
		assert.deepEqual(await githubPreflight(options(fetcher, { repositories: [] }))(), []);
	});

	it("a GitHub App's live token and a GitHub Enterprise address are used as the service holds them", async () => {
		const { fetcher, seen } = github({});
		const context = {
			env: { CHAT_REPOSITORY_URL: "https://github.com/acme/web" },
			config: { git: { tokenHosts: ["github.com"], githubApi: "https://ghe.example/api/v3/", mirror: { dir: "/m", repositories: ["https://github.com/acme/web", "https://github.com/acme/docs"], refreshMinutes: 30 } } },
			gitToken: "first-hour-token",
			gitTokenSource: async () => "live-app-token",
			ownerTokens: {},
		} as unknown as ServiceContext;
		const hook = githubPreflightFor(context, { withoutPullRequests: "x", fetch: fetcher })!;
		const checks = await hook({ log: () => {}, signal: new AbortController().signal });
		assert.equal(checks.length, 2);
		assert.equal(seen.length, 4, "the chat repository and the mirror's two are one list without a duplicate");
		assert.ok(seen.every((call) => call.url.startsWith("https://ghe.example/api/v3/repos/acme/") && call.authorization === "Bearer live-app-token"));
	});

	it("offers nothing to a role without a token or without a repository", () => {
		const config = { git: { tokenHosts: ["github.com"], mirror: undefined } };
		assert.equal(githubPreflightFor({ env: { CHAT_REPOSITORY_URL: "https://github.com/a/b" }, config } as unknown as ServiceContext, { withoutPullRequests: "x" }), undefined);
		assert.equal(githubPreflightFor({ env: {}, config, gitToken: "t" } as unknown as ServiceContext, { withoutPullRequests: "x" }), undefined);
	});
});

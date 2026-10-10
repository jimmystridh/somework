import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, afterEach, before, describe, it } from "node:test";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { Outcome } from "@somework/agent-kit";
import { approvalPolicy, createHandler, Metrics, PiDurableRuntime } from "@somework/agent-kit";
import { scriptedModels } from "@somework/agent-kit/providers/faux";
import { FakeHost, jobRig, makeRemote, runHandler, sh } from "@somework/agent-kit/testing";
import { AikidoError } from "../src/aikido/client.ts";
import { createFixerHooks } from "../src/hooks.ts";
import { FIXER_APPROVAL_PATTERNS, profile } from "../src/profile.ts";
import { renderHandler } from "../src/seed.ts";
import { loadSettings } from "../src/settings.ts";

const REPO = "https://example.test/Acme/Shop.git";
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const saved: Record<string, string | undefined> = {};
let remote: string;
before(() => {
	remote = makeRemote().remote;
	// the repository URL the agent is configured for resolves to a local bare repository
	for (const [name, value] of Object.entries({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `url.${remote}.insteadOf`, GIT_CONFIG_VALUE_0: REPO })) {
		saved[name] = process.env[name];
		process.env[name] = value;
	}
});
after(() => {
	for (const [name, value] of Object.entries(saved)) value === undefined ? delete process.env[name] : (process.env[name] = value);
});

const group = (extra: Record<string, unknown> = {}) => ({ id: 12, title: "Prototype pollution in lodash", type: "open_source", severity: "high", group_status: "new", how_to_fix: "Upgrade lodash to 4.17.21", ...extra });
const issue = { id: 99, group_id: 12, status: "open", affected_package: "lodash", installed_version: "4.17.20", patched_versions: ["4.17.21"], code_repo_name: "Acme/Shop" };

async function stack(plan: string[], found: () => Promise<any> = async () => ({ group: group(), issue })) {
	const dir = mkdtempSync(join(tmpdir(), "aikido-svc-"));
	const rig = jobRig({ stateDir: dir });
	const workspaceRoot = join(dir, "workspaces");
	const mirrorDir = join(workspaceRoot, ".mirrors");
	const seen: any[] = [];
	const fake = scriptedModels(plan, (context) => seen.push(context));
	const host = new FakeHost();
	const envFor = (cwd?: string) => new NodeExecutionEnv({ cwd: cwd ?? workspaceRoot });
	const env = envFor();
	const settings = loadSettings({ AIKIDO_REPOSITORY_URL: REPO });
	const resolved: string[] = [];
	const hooks = createFixerHooks({ settings, stateDir: dir, aikido: { resolveIssue: async (id) => (resolved.push(String(id)), found()) } });
	// the real service passes the hooks' extension to the runtime; here it is built once, with the hooks that own the tool
	const runtime = new PiDurableRuntime({ storagePath: join(dir, "pi2.sqlite"), models: fake.models, model: fake.model, env: envFor, policy: approvalPolicy([], FIXER_APPROVAL_PATTERNS, profile.toolApprovals), allowedTools: profile.allowedTools, extensions: hooks.extensions });
	await runtime.start();
	cleanups.push(() => runtime.close());
	const handler = createHandler({
		runtime: hooks.wrapRuntime!(runtime),
		envFor,
		session: { env, identity: { name: "SomeWork Aikido fixer", email: "aikido-fixer@somework.invalid" }, mirrorDir },
		host,
		workspaceRoot,
		client: rig.client,
		limits: { maxTokensCap: 5_000_000, maxMinutesCap: 60 },
		metrics: new Metrics(),
		profile,
		hooks,
	});
	/** What the shipped handler decides for an Aikido event, run the way the sandbox runs it. */
	const decide = async (data: Record<string, unknown>, now = "2026-10-06T09:00:00.000Z") => {
		const root = mkdtempSync(join(tmpdir(), "aikido-evt-"));
		mkdirSync(join(root, ".somework-events"));
		const file = join(root, ".somework-events", "h-aikido-test.mjs");
		writeFileSync(file, renderHandler(settings));
		const module = await import(pathToFileURL(file).href);
		return module.default({ event: { id: "evt_1", seq: 1, topic: "aikido.issue.created", source: "aikido", key: `k${Math.random()}`, data, classification: "internal", verified: true, depth: 0, untrusted: true }, agent: {}, now }, {});
	};
	/** The job the handler's `submit` decision describes, started the way the kit starts it, then run to the end. */
	const fixFromEvent = async (data: Record<string, unknown>) => {
		const decision = await decide(data);
		assert.equal(decision.action, "submit", JSON.stringify(decision));
		return runHandler(handler, { capability: decision.task.capability, input: { ...decision.task.input, budget: decision.task.budget } });
	};
	return { host, seen, resolved, mirrorDir, fixFromEvent, dir, rig };
}

/** The result of a job that completed; fails the test with the failure otherwise. */
function completed(outcome: Outcome): { result: any; artifacts: unknown[] } {
	assert.equal(outcome.type, "completed", JSON.stringify(outcome));
	const done = outcome as Extract<Outcome, { type: "completed" }>;
	return { result: done.result, artifacts: done.artifacts ?? [] };
}

const remoteBranches = (): string => sh(remote, "for-each-ref", "--format=%(refname)", "refs/heads").trim();
const eventData = { issueId: "12", severity: "high", repository: "acme/shop", url: "https://app.aikido.dev/issues/12" };

describe("Aikido fixer end to end", () => {
	it("an Aikido event becomes a fix: a pull request on agent/aikido-<issue>-<sha>, from a mirror, with a commit that cites the issue", async () => {
		const s = await stack(["call:aikido_issue:{}", `write:package.json:{"dependencies":{"lodash":"4.17.21"}}`, "final:FIXED: bump lodash to 4.17.21\n\nChanged package.json to the patched version."]);
		const base = sh(remote, "rev-parse", "refs/heads/main").trim();
		const done = completed(await s.fixFromEvent(eventData));
		const result = done.result;
		assert.equal(result.outcome, "pr_opened");
		assert.equal(result.branch, `agent/aikido-12-${base.slice(0, 8)}`);
		assert.equal(result.prUrl, `https://example.test/pr/${result.branch}`);
		assert.deepEqual(result.files, ["package.json"]);
		assert.equal(result.aikidoIssueId, 12);
		assert.equal(result.baseSha, base);
		assert.equal(sh(remote, "rev-parse", `refs/heads/${result.branch}`).trim(), result.sha);
		assert.equal(sh(remote, "log", "-1", "--format=%s", result.branch).trim(), "fix(security): bump lodash to 4.17.21 (Aikido #12)");
		assert.match(sh(remote, "log", "-1", "--format=%b", result.branch), /Aikido issue #12: https:\/\/app\.aikido\.dev\/issues\/12/);
		assert.equal(s.host.created.length, 1);
		assert.equal(s.host.created[0]!.base, "main");
		assert.ok(existsSync(s.mirrorDir), "the clone came from the persistent mirror");
		const toolResults = JSON.stringify(s.seen.flatMap((context) => context.messages.filter((m: any) => m.role === "toolResult")));
		assert.match(toolResults, /<<<AIKIDO-[0-9a-f]{16} \(untrusted data/, "the model read the issue through the tool, framed as data");
		assert.equal(done.artifacts.length, 1, "the patch is an artifact");
		assert.ok(s.rig.domain.uploaded.some((name) => name.endsWith(".diff")), "and it went to the domain");
	});

	it("says no_fix, and pushes nothing, when the agent finds no safe fix even if it had started to change things", async () => {
		const s = await stack(["write:speculative.txt:maybe", "final:NO_FIX: no patched version exists\n\nThe fix needs a major upgrade of the framework."]);
		const before = remoteBranches();
		const { result } = completed(await s.fixFromEvent(eventData));
		assert.equal(result.outcome, "no_fix");
		assert.match(result.summary, /no patched version exists/);
		assert.equal(remoteBranches(), before);
		assert.equal(s.host.created.length, 0);
	});

	it("skips an issue below the severity threshold before the model runs", async () => {
		const s = await stack(["final:FIXED: should never run"], async () => ({ group: group({ severity: "low" }), issue }));
		const { result } = completed(await s.fixFromEvent({ ...eventData, severity: undefined }));
		assert.equal(result.outcome, "skipped");
		assert.match(result.summary, /severity low is below the threshold high/);
		assert.equal(s.seen.length, 0, "no model call, no tokens");
		assert.equal(s.host.created.length, 0);
	});

	it("blocks a change that touches a workflow file, and nothing leaves the workspace", async () => {
		const s = await stack(["write:.github/workflows/ci.yml:on: push", "final:FIXED: changed the workflow\n\nSorry."]);
		const before = remoteBranches();
		const { result } = completed(await s.fixFromEvent(eventData));
		assert.equal(result.outcome, "blocked");
		assert.match(result.summary, /protected path/);
		assert.equal(remoteBranches(), before);
		assert.equal(s.host.created.length, 0);
	});

	it("refuses a push the model tries itself (nobody answers for it), and the service's own push is the only one", async () => {
		const s = await stack(["bash:git push origin HEAD:refs/heads/hijack", "final:NO_FIX: I could not push, which is fine"]);
		const before = remoteBranches();
		const { result } = completed(await s.fixFromEvent(eventData));
		assert.equal(result.outcome, "no_fix");
		assert.equal(remoteBranches(), before);
		assert.ok(!remoteBranches().includes("hijack"));
	});

	it("fails a job for an issue Aikido does not know as invalid input, without spending a token", async () => {
		const s = await stack(["final:FIXED: never"], async () => {
			throw new AikidoError("not_found", "Aikido has nothing at /issues/groups/12", 404);
		});
		const outcome = await s.fixFromEvent(eventData);
		assert.equal(outcome.type, "failed");
		const failure = (outcome as Extract<Outcome, { type: "failed" }>).failure;
		assert.equal(failure.code, "invalid_input");
		assert.match(failure.message, /Aikido has nothing/);
		assert.equal(s.seen.length, 0);
	});
});

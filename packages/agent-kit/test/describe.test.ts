import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { describeAgent, isoDateOrUndefined, withChangeMarker, type DescribeInput } from "../src/describe.ts";
import type { AgentProfile } from "../src/profile.ts";

const profile: AgentProfile = {
	id: "developer",
	capabilities: [{ id: "code.agent", version: "2" }],
	systemPrompt: "You are the developer. Never push to main.",
	allowedTools: ["read", "bash"],
	approvalPatterns: [[/\bgit push\b/, "pushing needs approval"]],
	toolApprovals: { jira_comment: () => undefined, deploy: () => undefined },
	defaultBudget: { maxTokens: 100_000, maxMinutes: 20 },
	git: { push: true, pullRequest: true, branchPrefix: "agent" },
	skills: { allow: ["review"] },
};

const input = (over: Partial<DescribeInput> = {}): DescribeInput => ({
	profile,
	agentId: "agent/pi-agent",
	version: "pilot-12",
	model: { provider: "openai-codex", modelId: "gpt-5.5" },
	allowedModels: [{ provider: "openai-codex", modelId: "gpt-5.5" }],
	limits: { maxTokensCap: 500_000, maxMinutesCap: 60, dailyTokenLimit: 1_000_000 },
	concurrency: 2,
	approvalPatterns: ["^terraform apply"],
	git: { app: false, token: true, tokenHosts: ["github.com"], tokenExpires: "2026-11-05", draft: false },
	chat: { mode: "model", askers: ["agent/manager"], instructors: ["agent/manager"] },
	events: { enabled: true, notifyTo: "agent/manager" },
	observe: { enabled: false },
	includePrompt: true,
	...over,
});

test("the description names the setup and holds nothing secret", () => {
	const described = describeAgent(input());
	assert.equal(described.agentId, "agent/pi-agent");
	assert.equal(described.version, "pilot-12");
	assert.deepEqual(described.tools.commandApprovals, [{ pattern: "\\bgit push\\b", reason: "pushing needs approval" }]);
	assert.deepEqual(described.tools.toolApprovals, ["deploy", "jira_comment"]);
	assert.equal(described.tools.extraApprovalPatterns, 1, "the deployment's own patterns are counted, not listed");
	assert.equal(described.repository.credential, "token");
	assert.equal(described.repository.tokenExpires, "2026-11-05");
	assert.equal(described.systemPrompt.text, profile.systemPrompt);
	assert.deepEqual(Object.keys(described.systemPrompt).sort(), ["characters", "sha256", "text"]);
});

test("the prompt text can be left out; its hash stays, and the setup hash does not depend on the version or on showing the text", () => {
	const shown = describeAgent(input());
	const hidden = describeAgent(input({ includePrompt: false, version: "pilot-13" }));
	assert.equal(hidden.systemPrompt.text, undefined);
	assert.equal(hidden.systemPrompt.sha256, shown.systemPrompt.sha256);
	assert.equal(hidden.hash, shown.hash);
});

test("a changed prompt, tool list, budget or credential changes the hash", () => {
	const base = describeAgent(input()).hash;
	assert.notEqual(describeAgent(input({ profile: { ...profile, systemPrompt: "different" } })).hash, base);
	assert.notEqual(describeAgent(input({ profile: { ...profile, allowedTools: ["read"] } })).hash, base);
	assert.notEqual(describeAgent(input({ limits: { maxTokensCap: 1, maxMinutesCap: 1, dailyTokenLimit: 1 } })).hash, base);
	assert.notEqual(describeAgent(input({ git: { app: true, token: false, tokenHosts: ["github.com"], draft: false, identity: "somework-developer[bot]" } })).hash, base);
});

test("the credential kind is reported without the credential", () => {
	const app = describeAgent(input({ git: { app: true, token: false, tokenHosts: ["github.com"], draft: false, identity: "somework-developer[bot]" } }));
	assert.equal(app.repository.credential, "github-app");
	assert.equal(app.repository.githubIdentity, "somework-developer[bot]");
	assert.equal(describeAgent(input({ git: { app: false, token: false, tokenHosts: [], draft: false } })).repository.credential, "none");
	assert.doesNotMatch(JSON.stringify(app), /PRIVATE KEY|ghs_|ghp_/);
});

test("a role without a tool list offers all tools; a role without a repository says so", () => {
	const described = describeAgent(input({ profile: { ...profile, allowedTools: undefined, noRepository: true, git: { push: false, pullRequest: false, branchPrefix: "agent" } } }));
	assert.equal(described.tools.allowed, "all");
	assert.equal(described.repository.noRepository, true);
});

test("the change marker keeps its date while the setup is the same and moves when it changes", () => {
	const file = join(mkdtempSync(join(tmpdir(), "describe-")), "state", "profile-hash.json");
	const first = withChangeMarker(describeAgent(input()), file, () => new Date("2026-10-06T10:00:00Z"));
	assert.equal(first.changedAt, "2026-10-06T10:00:00.000Z");
	const restarted = withChangeMarker(describeAgent(input()), file, () => new Date("2026-10-07T10:00:00Z"));
	assert.equal(restarted.changedAt, "2026-10-06T10:00:00.000Z");
	const changed = withChangeMarker(describeAgent(input({ concurrency: 1 })), file, () => new Date("2026-10-08T10:00:00Z"));
	assert.equal(changed.changedAt, "2026-10-08T10:00:00.000Z");
});

test("an unreadable or unwritable marker only loses the date", () => {
	const dir = mkdtempSync(join(tmpdir(), "describe-"));
	const blocker = join(dir, "file");
	writeFileSync(blocker, "x");
	assert.equal(withChangeMarker(describeAgent(input()), join(blocker, "nested", "marker.json")).changedAt, undefined);
});

test("only a plain date is shown as a token expiry", () => {
	assert.equal(isoDateOrUndefined("2026-11-05"), "2026-11-05");
	assert.equal(isoDateOrUndefined("2026-11-05T00:00:00Z"), "2026-11-05T00:00:00Z");
	assert.equal(isoDateOrUndefined("soon; ghp_secret"), undefined);
	assert.equal(isoDateOrUndefined(undefined), undefined);
});

test("/profile serves the description and is absent when a service gives none", async () => {
	const { createHealthServer } = await import("../src/health.ts");
	const get = async (server: import("node:http").Server, path: string) => {
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const { port } = server.address() as import("node:net").AddressInfo;
		try {
			return await fetch(`http://127.0.0.1:${port}${path}`);
		} finally {
			server.close();
		}
	};
	const base = { runtime: { health: () => ({ ready: true }) } as any, metrics: { render: () => "" } as any };
	const described = describeAgent(input());
	const response = await get(createHealthServer({ ...base, profile: () => described }), "/profile");
	assert.equal(response.status, 200);
	assert.equal(((await response.json()) as { hash: string }).hash, described.hash);
	assert.equal((await get(createHealthServer(base), "/profile")).status, 404);
});

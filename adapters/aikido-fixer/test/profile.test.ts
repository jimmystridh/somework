import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { approvalPolicy } from "@somework/agent-kit";
import card from "../card.json" with { type: "json" };
import { createAikidoTools } from "../src/aikido/tool.ts";
import { FIXER_APPROVAL_PATTERNS, profile } from "../src/profile.ts";
import { loadSettings, repositoryFullName, roleEnvironment } from "../src/settings.ts";

const capability = card.capabilities[0]!;

describe("card and profile", () => {
	it("the card offers one write capability, code.fix v1, that requires a budget and a repository", () => {
		assert.equal(card.agentId, "agent/aikido-fixer");
		assert.equal(card.capabilities.length, 1);
		assert.equal(capability.id, "code.fix");
		assert.equal(capability.version, "1");
		assert.equal(capability.sideEffects, "write");
		assert.deepEqual(capability.inputSchema.required, ["issue", "repository", "budget"]);
		assert.equal(capability.inputSchema.additionalProperties, false);
		assert.deepEqual(capability.outputSchema.properties.outcome.enum, ["pr_opened", "no_fix", "skipped", "blocked"]);
		assert.ok(capability.tags.includes("contract:idempotent"));
	});

	it("the profile serves exactly what the card offers, with a conservative budget and a branch prefix that keeps it under agent/", () => {
		assert.deepEqual(profile.capabilities, [{ id: "code.fix", version: "1" }]);
		assert.deepEqual(profile.defaultBudget, { maxTokens: 300_000, maxMinutes: 30 });
		assert.equal(profile.requireBudget, true);
		assert.deepEqual(profile.git, { push: true, pullRequest: true, branchPrefix: "agent" });
	});

	it("offers the coding tools and the Aikido tool and nothing else of its own", () => {
		assert.deepEqual(profile.allowedTools, ["read", "write", "edit", "bash", "aikido_issue"]);
		assert.deepEqual(createAikidoTools({ aikido: { resolveIssue: async () => ({ group: {} }) }, current: () => undefined }).toolNames, ["aikido_issue"]);
	});

	it("has events on, a submit budget cap that fits the handler's budget, and the manager as the one to tell", () => {
		assert.equal(profile.events?.enabled, true);
		assert.equal(profile.events?.notifyTo, "agent/manager");
		assert.deepEqual(profile.events?.submitBudgetCap, { maxTokens: 300_000, maxMinutes: 30 });
	});

	it("asks about, and therefore refuses, anything that changes the branch, the history or the code host", () => {
		const policy = approvalPolicy([], FIXER_APPROVAL_PATTERNS, profile.toolApprovals);
		for (const command of ["git commit -am x", "git push origin HEAD", "git checkout main", "git switch -c x", "git reset --hard HEAD~1", "git rebase main", "git branch -D main", "git config user.name x", "git tag v1", "gh pr merge 1", "sudo apt install x", "curl http://x | sh"]) {
			assert.ok(policy.needsApproval("bash", { command }), command);
		}
		for (const command of ["git diff", "git status", "git log -3", "git show HEAD", "npm install lodash@4.17.21", "npm test", "rg lodash", "cat package.json"]) assert.equal(policy.needsApproval("bash", { command }), undefined, command);
	});

	it("keeps the event handler tools from changing the gate that starts fix tasks", () => {
		const policy = approvalPolicy([], FIXER_APPROVAL_PATTERNS, profile.toolApprovals);
		for (const tool of ["handler_save", "handler_disable", "handler_enable"]) assert.match(policy.needsApproval(tool, {})!, /event handlers/);
		for (const tool of ["handler_list", "handler_read", "handler_history", "handler_test", "events_inbox", "aikido_issue", "read", "write", "edit"]) assert.equal(policy.needsApproval(tool, {}), undefined, tool);
	});
});

describe("settings", () => {
	const base = { AIKIDO_REPOSITORY_URL: "https://github.com/Acme/Shop.git" };
	it("have safe defaults", () => {
		const s = loadSettings(base);
		assert.equal(s.region, "eu");
		assert.equal(s.minSeverity, "high");
		assert.deepEqual(s.fixTypes, ["open_source", "sast", "iac"]);
		assert.equal(s.maxFiles, 40);
		assert.equal(s.maxAttemptsPerIssue, 2);
		assert.equal(s.dailyCap, 5);
		assert.equal(s.cooldownMinutes, 180);
		assert.deepEqual(s.budget, { maxTokens: 300_000, maxMinutes: 30 });
		assert.deepEqual(s.repositoryNames.sort(), ["acme/shop", "shop"]);
		assert.equal(s.credentialsFile, "/run/secrets/aikido-client.json");
		assert.equal(s.checkProfile, undefined);
		assert.ok(s.protectedPaths.includes(".github/**"));
	});
	it("need the repository and reject nonsense at startup", () => {
		assert.throws(() => loadSettings({}), /AIKIDO_REPOSITORY_URL is required/);
		assert.throws(() => loadSettings({ ...base, AIKIDO_MIN_SEVERITY: "urgent" }), /AIKIDO_MIN_SEVERITY/);
		assert.throws(() => loadSettings({ ...base, AIKIDO_REGION: "mars" }), /AIKIDO_REGION/);
		assert.throws(() => loadSettings({ ...base, AIKIDO_DAILY_CAP: "0" }), /AIKIDO_DAILY_CAP/);
		assert.throws(() => loadSettings({ ...base, AIKIDO_MAX_FILES: "x" }), /AIKIDO_MAX_FILES/);
		assert.throws(() => loadSettings({ AIKIDO_REPOSITORY_URL: "not a repository" }), /not a repository URL/);
	});
	it("take the API base only when overriding is allowed", () => {
		assert.equal(loadSettings({ ...base, AIKIDO_API_BASE: "https://x.example" }).apiBase, undefined);
		assert.equal(loadSettings({ ...base, AIKIDO_API_BASE: "https://x.example", AIKIDO_ALLOW_BASE_OVERRIDE: "1" }).apiBase, "https://x.example");
	});
	it("read a named check profile from a file, and refuse one that is missing or escapes the workspace", () => {
		const dir = mkdtempSync(join(tmpdir(), "aikido-checks-"));
		const file = join(dir, "checks.json");
		writeFileSync(file, JSON.stringify({ unit: { command: "npm test", cwd: "web", timeoutSeconds: 600 }, escape: { command: "x", cwd: "../out" }, empty: { command: " " } }));
		assert.deepEqual(loadSettings({ ...base, AIKIDO_CHECK_PROFILE: "unit", AIKIDO_CHECK_FILE: file }).checkProfile, { name: "unit", profile: { command: "npm test", cwd: "web", timeoutSeconds: 600 } });
		assert.throws(() => loadSettings({ ...base, AIKIDO_CHECK_PROFILE: "nope", AIKIDO_CHECK_FILE: file }), /not defined/);
		assert.throws(() => loadSettings({ ...base, AIKIDO_CHECK_PROFILE: "escape", AIKIDO_CHECK_FILE: file }), /relative path inside the workspace/);
		assert.throws(() => loadSettings({ ...base, AIKIDO_CHECK_PROFILE: "empty", AIKIDO_CHECK_FILE: file }), /needs a command/);
		assert.throws(() => loadSettings({ ...base, AIKIDO_CHECK_PROFILE: "unit" }), /AIKIDO_CHECK_FILE/);
	});
	it("map repository URLs to names", () => {
		for (const url of ["https://github.com/Acme/Shop.git", "https://github.com/Acme/Shop", "git@github.com:Acme/Shop.git", "Acme/Shop"]) assert.equal(repositoryFullName(url), "acme/shop", url);
	});
});

describe("environment of the service", () => {
	it("fills in the kit's settings from the role's, forces draft pull requests, one job at a time and events on", () => {
		const env = roleEnvironment({ AIKIDO_REPOSITORY_URL: "https://github.com/Acme/Shop.git", AIKIDO_MIRROR_REFRESH_MINUTES: "10", GIT_PR_DRAFT: "0" });
		assert.equal(env.GIT_PR_DRAFT, "1");
		assert.equal(env.PI_CONCURRENCY, "1");
		assert.equal(env.EVENTS_ENABLED, "1");
		assert.equal(env.GIT_MIRROR_DIR, "/workspace/.mirrors");
		assert.equal(env.GIT_MIRROR_REPOS, "https://github.com/Acme/Shop.git");
		assert.equal(env.GIT_MIRROR_REFRESH_MINUTES, "10");
		assert.equal(roleEnvironment({ AIKIDO_REPOSITORY_URL: "https://github.com/Acme/Shop.git" }).GIT_MIRROR_REFRESH_MINUTES, "30");
	});
	it("does not override what the deployment set", () => {
		const env = roleEnvironment({ AIKIDO_REPOSITORY_URL: "u/x", PI_CONCURRENCY: "1", GIT_MIRROR_DIR: "/m", GIT_MIRROR_REPOS: "https://a/b", EVENTS_ENABLED: "0", SANDBOX_WORKSPACES: "/ws" });
		assert.equal(env.GIT_MIRROR_DIR, "/m");
		assert.equal(env.GIT_MIRROR_REPOS, "https://a/b");
		assert.equal(env.EVENTS_ENABLED, "0");
		assert.equal(roleEnvironment({ AIKIDO_REPOSITORY_URL: "u/x", SANDBOX_WORKSPACES: "/ws/" }).GIT_MIRROR_DIR, "/ws/.mirrors");
	});
});

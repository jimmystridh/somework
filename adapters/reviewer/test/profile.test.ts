import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateProfile, type AgentProfile } from "@somework/agent-kit";
import card from "../card.json" with { type: "json" };
import { profile } from "../src/profile.ts";
import { buildInstruction, CONTEXT_KEY, repairInstruction, SYSTEM_PROMPT } from "../src/prompt.ts";

describe("the reviewer profile", () => {
	it("is read-only: nothing is committed, pushed or opened as a pull request", () => {
		assert.deepEqual(profile.git, { push: false, pullRequest: false, branchPrefix: "review" });
		assert.throws(() => validateProfile({ ...profile, git: { ...profile.git, pullRequest: true } } as AgentProfile), /pull request needs the branch to be pushed/);
	});

	it("offers the model only the tools it needs to read", () => {
		assert.deepEqual(profile.allowedTools, ["read", "bash"]);
		assert.ok(!profile.allowedTools!.includes("write") && !profile.allowedTools!.includes("edit"));
	});

	it("serves exactly what the card declares, and requires a budget there and here", () => {
		assert.deepEqual(profile.capabilities, [{ id: "code.review", version: "3" }]);
		assert.equal(profile.requireBudget, true);
		const capability = card.capabilities[0]!;
		assert.equal(capability.sideEffects, "read");
		assert.ok(capability.inputSchema.required.includes("budget"));
		assert.equal(card.agentId, "agent/reviewer");
	});

	it("exposes no repository skill unless the deployment names it (SKILLS_ALLOW)", () => {
		assert.deepEqual(profile.skills.allow, []);
	});

	it("tells the model to be read-only, to return comments rather than post them, and how to end", () => {
		assert.match(SYSTEM_PROMPT, /You are read-only/);
		assert.match(SYSTEM_PROMPT, /never post, comment, approve, merge or change anything/);
		assert.match(SYSTEM_PROMPT, /draftComments/);
		assert.match(SYSTEM_PROMPT, /follow-up/);
		assert.match(SYSTEM_PROMPT, /exactly one fenced json block/);
		assert.equal(profile.systemPrompt, SYSTEM_PROMPT);
	});
});

describe("the instruction", () => {
	const input = { repository: { url: "https://example.test/o/r.git", ref: "feature" }, budget: { maxTokens: 1000, maxMinutes: 5 } };

	it("names the branch, and adds the pull request, ticket, focus and context when there are any", () => {
		const bare = buildInstruction(input);
		assert.match(bare, /branch `feature` of https:\/\/example\.test\/o\/r\.git/);
		assert.doesNotMatch(bare, /pull request #|ticket|asks you/);
		const full = buildInstruction({ ...input, pullRequest: 7, ticket: "ABC-12", focus: "error handling", [CONTEXT_KEY]: "CONTEXT TEXT" });
		assert.match(full, /pull request #7/);
		assert.match(full, /ticket ABC-12/);
		assert.match(full, /look at this first:\nerror handling/);
		assert.match(full, /CONTEXT TEXT/);
	});

	it("refuses input it cannot use", () => {
		for (const bad of [{}, { repository: { url: "u" } }, { ...input, pullRequest: 0 }, { ...input, pullRequest: "7" }, { ...input, ticket: "not a key; rm" }, { ...input, focus: "x".repeat(4001) }]) {
			assert.throws(() => buildInstruction(bad), /required|positive integer|look like|at most/);
		}
	});

	it("builds the repair instruction from the reason", () => {
		assert.match(repairInstruction("verdict must be one of approve, request_changes, needs_clarification"), /could not be used as the structured result: verdict must be one of/);
	});
});

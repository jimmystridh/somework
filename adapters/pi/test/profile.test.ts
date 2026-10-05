import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_APPROVAL_PATTERNS, validateProfile } from "@somework/agent-kit";
import card from "../card.json" with { type: "json" };
import { profile } from "../src/profile.ts";

describe("the developer role", () => {
	it("is a valid profile that serves exactly the capabilities of its card", () => {
		assert.doesNotThrow(() => validateProfile(profile));
		assert.deepEqual(profile.capabilities, card.capabilities.map(({ id, version }) => ({ id, version })));
		assert.deepEqual(profile.capabilities.map((c) => `${c.id}@${c.version}`), ["code.agent@1", "code.agent@2"]);
	});

	it("keeps the behaviour the service always had: budget required, push and pull request, agent/<task>, default approvals, no skills", () => {
		assert.equal(profile.requireBudget, true);
		assert.deepEqual(profile.git, { push: true, pullRequest: true, branchPrefix: "agent" });
		assert.equal(profile.approvalPatterns, DEFAULT_APPROVAL_PATTERNS);
		assert.deepEqual(profile.skills, { allow: [] });
		assert.equal(profile.allowedTools, undefined);
		assert.equal(profile.systemPrompt, undefined);
	});

	it("matches the card's contract: write side effects and a required budget", () => {
		for (const capability of card.capabilities) {
			assert.equal(capability.sideEffects, "write");
			assert.ok(capability.inputSchema.required.includes("budget"), `${capability.id}@${capability.version} requires a budget`);
		}
	});
});

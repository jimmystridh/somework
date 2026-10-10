import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { askToolNames, instructToolNames } from "@somework/agent-kit";
import { reviewerChat } from "../src/chat.ts";
import { profile } from "../src/profile.ts";

describe("the reviewer in chat", () => {
	const chat = reviewerChat({ CHAT_REPOSITORY_URL: "https://github.com/acme/app" } as NodeJS.ProcessEnv);

	it("answers questions read-only and instructions with the reviewer's own read and bash, whose guard is kept", () => {
		assert.deepEqual(askToolNames(profile.chat, chat), ["read", "agent_status"]);
		assert.deepEqual(instructToolNames(profile.chat, profile.allowedTools), ["read", "bash"]);
	});

	it("turns an instruction into a code.review task with the focus, pull request and ticket", () => {
		const planned = chat.instructInput!("pr: #42\nticket: ABC-7\nlook at the auth change") as any;
		assert.deepEqual(planned.capability, { id: "code.review", version: "3" });
		assert.deepEqual(planned.input, { repository: { url: "https://github.com/acme/app", ref: "HEAD" }, pullRequest: 42, ticket: "ABC-7", focus: "look at the auth change" });
	});

	it("reviews without a focus, and refuses a bad pull request number or ticket", () => {
		assert.deepEqual((chat.instructInput!("review it") as any).input.focus, "review it");
		assert.equal((chat.instructInput!("pr: 3") as any).input.focus, undefined);
		assert.ok("refuse" in chat.instructInput!("pr: abc\nreview"));
		assert.ok("refuse" in chat.instructInput!("pr: 0\nreview"));
		assert.ok("refuse" in chat.instructInput!("ticket: ; rm -rf /\nreview"));
	});

	it("says in words what the review found", () => {
		const text = chat.describeResult!({ verdict: "changes_requested", summary: "two problems", findings: [{ severity: "high" }, { severity: "low" }, { severity: "high" }] });
		assert.match(text!, /Review done: changes_requested\./);
		assert.match(text!, /Findings: 2 high, 1 low\./);
		assert.equal(chat.describeResult!({ nothing: true }), undefined);
		assert.match(chat.describeResult!({ verdict: "approve" })!, /No findings/);
	});
});

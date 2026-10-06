import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { askToolNames, instructToolNames } from "@somework/agent-kit";
import { qaChat } from "../src/chat.ts";
import { profile } from "../src/profile.ts";

describe("QA in chat", () => {
	const chat = qaChat({ CHAT_REPOSITORY_URL: "https://github.com/acme/app" } as NodeJS.ProcessEnv);

	it("answers questions read-only, and takes instructions with QA's own tools, whose writes still need approval", () => {
		assert.deepEqual(askToolNames(profile.chat, chat), ["read", "agent_status"]);
		const tools = instructToolNames(profile.chat, profile.allowedTools);
		assert.deepEqual(tools, profile.allowedTools);
		assert.ok(tools.includes("read") && tools.includes("bash"));
	});

	it("reads tickets and the repository in a conversation, and its standing orders say so", () => {
		const withTools = qaChat({ CHAT_REPOSITORY_URL: "https://github.com/acme/app", CHAT_REPOSITORY_REF: "main" } as NodeJS.ProcessEnv, undefined, { extension: { name: "qa-jira", tools: [] } as any });
		assert.deepEqual(askToolNames(profile.chat, withTools), ["read", "agent_status", "jira_get_issue", "jira_search", "jira_changelog", "jira_get_comments"]);
		assert.deepEqual(withTools.checkout!(), { repoUrl: "https://github.com/acme/app", ref: "main" });
		assert.equal(chat.checkout!()!.ref, undefined);
		assert.equal(qaChat({} as NodeJS.ProcessEnv).checkout, undefined, "no repository configured: nothing to read");
		assert.match(withTools.instructions!, /jira_get_issue/);
		assert.doesNotMatch(withTools.instructions!, /you never change the checkout/);
		assert.match(withTools.instructions!, /cannot do in a conversation is change code/);
		for (const writer of ["jira_comment", "jira_attach", "jira_add_label", "jira_remove_label", "jira_transition_to_in_progress_and_reassign", "qa_record_verdict"]) assert.ok(!askToolNames(profile.chat, withTools).includes(writer), `${writer} stays out of chat`);
	});

	it("turns an instruction into a qa.verify task for the ticket it names", () => {
		const planned = chat.instructInput!("repo: https://github.com/acme/web\nref: feature/x\nscenario: log in as admin\napp: shop\nverify ABC-123 please") as any;
		assert.deepEqual(planned.capability, { id: "qa.verify", version: "1" });
		assert.deepEqual(planned.input, { ticket: "ABC-123", repository: { url: "https://github.com/acme/web", ref: "feature/x" }, scenario: "log in as admin", app: "shop" });
		assert.deepEqual((chat.instructInput!("verify ABC-9") as any).input, { ticket: "ABC-9", repository: { url: "https://github.com/acme/app", ref: "HEAD" } });
	});

	it("refuses an instruction with no ticket, a ticket outside the configured pattern and a bad app name", () => {
		assert.match((chat.instructInput!("verify the thing") as any).refuse, /one named ticket/);
		const strict = qaChat({ CHAT_REPOSITORY_URL: "https://github.com/acme/app" } as NodeJS.ProcessEnv, /^QA-\d+$/);
		assert.ok("refuse" in strict.instructInput!("verify ABC-1"));
		assert.ok("input" in strict.instructInput!("verify QA-1"));
		assert.ok("refuse" in chat.instructInput!("app: ../../etc\nverify ABC-1"));
	});
});

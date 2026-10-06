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

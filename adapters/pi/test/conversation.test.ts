import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { askToolNames, instructToolNames } from "@somework/agent-kit";
import { developerChat } from "../src/chat.ts";
import { profile } from "../src/profile.ts";

describe("the developer in chat", () => {
	const chat = developerChat({ CHAT_REPOSITORY_URL: "https://github.com/acme/app", CHAT_REPOSITORY_REF: "main" } as NodeJS.ProcessEnv);

	it("answers questions with read and agent_status only, and takes instructions with the coding tools", () => {
		assert.deepEqual(askToolNames(profile.chat, chat), ["read", "agent_status"]);
		assert.deepEqual(instructToolNames(profile.chat, profile.allowedTools), ["read", "write", "edit", "bash"]);
	});

	it("turns an instruction into a code.agent task on the configured repository", () => {
		assert.deepEqual(chat.instructInput!("add a health endpoint"), { capability: { id: "code.agent", version: "2" }, input: { repository: { url: "https://github.com/acme/app", ref: "main" }, instruction: "add a health endpoint" } });
	});

	it("takes the repository and ref from leading lines, only over https", () => {
		const planned = chat.instructInput!("repo: https://github.com/acme/other\nref: develop\nfix the typo") as any;
		assert.deepEqual(planned.input.repository, { url: "https://github.com/acme/other", ref: "develop" });
		assert.equal(planned.input.instruction, "fix the typo");
		assert.ok("refuse" in chat.instructInput!("repo: ssh://git@github.com/a/b\nfix"));
		assert.ok("refuse" in chat.instructInput!("repo: https://github.com/a/b"), "no instruction after the lines");
	});

	it("refuses without a repository when none is configured", () => {
		assert.ok("refuse" in developerChat({} as NodeJS.ProcessEnv).instructInput!("do something"));
	});

	it("can only be told what to do with a card capability", () => {
		const planned = chat.instructInput!("x") as any;
		assert.ok(profile.capabilities.some((c) => c.id === planned.capability.id && c.version === planned.capability.version));
	});
});

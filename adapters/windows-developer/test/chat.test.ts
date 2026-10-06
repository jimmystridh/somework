import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { askToolNames, instructToolNames } from "@somework/agent-kit";
import { windowsDeveloperChat } from "../src/chat.ts";
import { profile } from "../src/profile.ts";

describe("the Windows developer in chat", () => {
	const chat = windowsDeveloperChat({ CHAT_REPOSITORY_URL: "https://github.com/acme/app", CHAT_REPOSITORY_REF: "main" } as NodeJS.ProcessEnv);

	it("answers questions read-only and takes instructions with the coding tools, in the confined environment", () => {
		assert.deepEqual(askToolNames(profile.chat, chat), ["read", "agent_status"]);
		assert.deepEqual(instructToolNames(profile.chat, profile.allowedTools), ["read", "write", "edit", "bash"]);
	});

	it("turns an instruction into a code.windows task, with named build and test profiles only", () => {
		const planned = chat.instructInput!("build: release\ntests: unit, smoke\nfix the path handling") as any;
		assert.deepEqual(planned.capability, { id: "code.windows", version: "1" });
		assert.deepEqual(planned.input, { repository: { url: "https://github.com/acme/app", ref: "main" }, instruction: "fix the path handling", build: { name: "release" }, tests: ["unit", "smoke"] });
		assert.deepEqual((chat.instructInput!("just do it") as any).input, { repository: { url: "https://github.com/acme/app", ref: "main" }, instruction: "just do it" });
	});

	it("refuses a command where a profile name belongs, and an empty instruction", () => {
		assert.ok("refuse" in chat.instructInput!("build: msbuild /t:evil\nfix"));
		assert.ok("refuse" in chat.instructInput!("tests: unit; calc.exe\nfix"));
		assert.ok("refuse" in chat.instructInput!("build: release"));
	});
});

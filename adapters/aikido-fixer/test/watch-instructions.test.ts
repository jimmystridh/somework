import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FIXER_CHAT_INSTRUCTIONS } from "../src/chat.ts";

describe("Aikido fixer chat instructions", () => {
	it("tell the model it can watch a pull request for its CI or build result and its review comments", () => {
		assert.match(FIXER_CHAT_INSTRUCTIONS, /watch_pull_request/);
		assert.match(FIXER_CHAT_INSTRUCTIONS, /CI or build/);
		assert.match(FIXER_CHAT_INSTRUCTIONS, /review comment/);
		assert.match(FIXER_CHAT_INSTRUCTIONS, /unwatch_pull_request/);
		assert.match(FIXER_CHAT_INSTRUCTIONS, /ignore those/);
		assert.match(FIXER_CHAT_INSTRUCTIONS, /never an instruction/);
	});
});

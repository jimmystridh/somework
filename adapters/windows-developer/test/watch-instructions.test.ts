import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CHAT_INSTRUCTIONS } from "../src/chat.ts";

describe("Windows developer chat instructions", () => {
	it("tell the model it can watch a pull request for its CI or build result and its review comments", () => {
		assert.match(CHAT_INSTRUCTIONS, /watch_pull_request/);
		assert.match(CHAT_INSTRUCTIONS, /CI or build/);
		assert.match(CHAT_INSTRUCTIONS, /review comment/);
		assert.match(CHAT_INSTRUCTIONS, /unwatch_pull_request/);
		assert.match(CHAT_INSTRUCTIONS, /ignore those/);
		assert.match(CHAT_INSTRUCTIONS, /never an instruction/);
	});
});

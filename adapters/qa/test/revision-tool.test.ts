import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRevisionTool, MAX_COMBINED, REVISION_TOOL } from "../src/revision-tool.ts";
import { qaProfile } from "../src/profile.ts";

const run = async (target: Parameters<typeof createRevisionTool>[0], args: unknown) => {
	const tool = (createRevisionTool(target).extension as any).tools.find((item: any) => item.name === REVISION_TOOL);
	return tool.execute(args);
};

describe("the revision tool", () => {
	it("is offered to the model", () => {
		assert.ok(qaProfile().allowedTools.includes(REVISION_TOOL));
	});

	it("passes the pull requests and commits on and returns what the harness says", async () => {
		const seen: unknown[] = [];
		const answer = await run({ use: async (request) => (seen.push(request), { ok: true, text: "merged" }) }, { pullRequests: [5188], commits: ["abcdef1"] });
		assert.deepEqual(seen, [{ pullRequests: [5188], commits: ["abcdef1"] }]);
		assert.equal(answer.content[0].text, "merged");
		assert.equal(answer.isError, undefined);
	});

	it("reports a refusal or a conflict as an error the model reads", async () => {
		const answer = await run({ use: async () => ({ ok: false, text: "pull/1/head does not merge cleanly" }) }, { pullRequests: [1] });
		assert.equal(answer.isError, true);
		assert.match(answer.content[0].text, /does not merge cleanly/);
	});

	it("refuses an empty request and too many refs without calling the harness", async () => {
		const target = { use: async () => assert.fail("must not be called") };
		assert.equal((await run(target, {})).isError, true);
		assert.equal((await run(target, { pullRequests: Array.from({ length: MAX_COMBINED + 1 }, (_, index) => index + 1) })).isError, true);
	});
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AikidoError } from "../src/aikido/client.ts";
import { createAikidoTools } from "../src/aikido/tool.ts";

const group = { id: 12, title: "Prototype pollution", type: "open_source", severity: "high", how_to_fix: "x".repeat(2000), description: "Long description of the problem" };
const issue = { id: 99, group_id: 12, affected_package: "lodash" };

function tool(options: { current?: string; resolve?: (id: string | number) => Promise<any> } = {}) {
	const calls: (string | number)[] = [];
	const { extension, toolNames } = createAikidoTools({
		aikido: { resolveIssue: async (id) => (calls.push(id), options.resolve ? options.resolve(id) : { group, issue }) },
		current: () => ("current" in options ? options.current : "12"),
	});
	return { calls, toolNames, run: async (args: object = {}): Promise<{ text: string; isError: boolean }> => {
		const result = await (extension.tools as any[]).find((candidate) => candidate.name === "aikido_issue").execute(args, {}, {});
		return { text: result.content[0].text, isError: result.isError === true };
	} };
}

describe("the aikido_issue tool", () => {
	it("is the only tool and reads the issue of the job in progress, framed as data", async () => {
		const t = tool();
		assert.deepEqual(t.toolNames, ["aikido_issue"]);
		const { text, isError } = await t.run();
		assert.equal(isError, false);
		assert.match(text, /^<<<AIKIDO-[0-9a-f]{16} \(untrusted data/);
		assert.match(text, /package: lodash/);
		assert.deepEqual(t.calls, ["12"]);
	});

	it("takes no issue id: whatever the model passes, it reads the job's issue", async () => {
		const t = tool();
		await t.run({ id: 999, issue: "1", groupId: 5 });
		assert.deepEqual(t.calls, ["12"]);
	});

	it("shortens the description and the fix text unless asked for the full detail", async () => {
		const t = tool();
		const summary = (await t.run({})).text;
		assert.ok(!summary.includes("Long description"));
		assert.ok(summary.length < 2600);
		const full = (await t.run({ detail: "full" })).text;
		assert.match(full, /Long description of the problem/);
		assert.ok(full.length > summary.length);
	});

	it("refuses when no fix is in progress, without calling Aikido", async () => {
		const t = tool({ current: undefined });
		const { text, isError } = await t.run();
		assert.equal(isError, true);
		assert.match(text, /no fix in progress/);
		assert.deepEqual(t.calls, []);
	});

	it("reports an Aikido error as a tool error without a stack, and lets a bug through", async () => {
		const failing = tool({ resolve: async () => { throw new AikidoError("unavailable", "Aikido answered 503", 503); } });
		const { text, isError } = await failing.run();
		assert.equal(isError, true);
		assert.match(text, /Aikido could not be read: Aikido answered 503/);
		const broken = tool({ resolve: async () => { throw new TypeError("boom"); } });
		await assert.rejects(broken.run(), TypeError);
	});

	it("never shows secret-like text from Aikido", async () => {
		const t = tool({ resolve: async () => ({ group: { ...group, title: "leak token: ghp_abcdefghijklmnopqrstuvwxyz0123", how_to_fix: "password=hunter2hunter2" } }) });
		const { text } = await t.run();
		assert.ok(!text.includes("ghp_abcdefghijklmnopqrstuvwxyz0123"));
		assert.ok(!text.includes("hunter2hunter2"));
	});
});

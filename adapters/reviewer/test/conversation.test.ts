import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { reviewerChat } from "../src/chat.ts";

describe("the reviewer in conversations", () => {
	const chat = reviewerChat({ CHAT_REPOSITORY_URL: "https://github.com/acme/app" } as NodeJS.ProcessEnv);
	const [tool] = chat.jobTools!;

	it("offers the review as one job tool and says so in its standing orders", () => {
		assert.deepEqual(chat.jobTools!.map((candidate) => candidate.name), ["review_code"]);
		assert.match(chat.instructions!, /review_code/);
		assert.doesNotMatch(chat.instructions!, /instruct:/);
	});

	it("plans a code.review job with the focus, pull request and ticket", async () => {
		assert.deepEqual(await tool!.plan({ pullRequest: 42, ticket: "ABC-7", focus: "look at the auth change" }), {
			capability: { id: "code.review", version: "3" },
			input: { repository: { url: "https://github.com/acme/app", ref: "HEAD" }, pullRequest: 42, ticket: "ABC-7", focus: "look at the auth change" },
			label: "review PR #42",
		});
	});

	it("reviews without a focus, and refuses a bad pull request number, ticket or repository", async () => {
		const plain = (await tool!.plan({ ref: "feature" })) as any;
		assert.equal(plain.input.focus, undefined);
		assert.equal(plain.label, "review feature");
		assert.ok("refuse" in (await tool!.plan({ pullRequest: 0 })));
		assert.ok("refuse" in (await tool!.plan({ ticket: "; rm -rf /" })));
		assert.ok("refuse" in (await tool!.plan({ repo: "http://x" })));
		assert.ok("refuse" in ((await reviewerChat({} as NodeJS.ProcessEnv).jobTools![0]!.plan({}))));
	});

	it("says in words what the review found", () => {
		const text = chat.describeResult!({ verdict: "changes_requested", summary: "two problems", findings: [{ severity: "high" }, { severity: "low" }, { severity: "high" }] });
		assert.match(text!, /Review done: changes_requested\./);
		assert.match(text!, /Findings: 2 high, 1 low\./);
		assert.equal(chat.describeResult!({ nothing: true }), undefined);
		assert.match(chat.describeResult!({ verdict: "approve" })!, /No findings/);
	});
});

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
		assert.match((chat.instructInput!("verify the thing") as any).refuse, /name the ticket\(s\).*in Test/);
		const strict = qaChat({ CHAT_REPOSITORY_URL: "https://github.com/acme/app" } as NodeJS.ProcessEnv, /^QA-\d+$/);
		assert.ok("refuse" in strict.instructInput!("verify ABC-1"));
		assert.ok("input" in strict.instructInput!("verify QA-1"));
		assert.ok("refuse" in chat.instructInput!("app: ../../etc\nverify ABC-1"));
	});

	describe("with several tickets, a state to work through, or a query", () => {
		const searched: { jql: string; max: number }[] = [];
		const found = [
			{ key: "ABC-1", labels: [] },
			{ key: "ABC-2", labels: ["AgentTested"] },
			{ key: "ABC-3", labels: ["x"] },
			{ key: "OTHER-9", labels: [] },
		];
		const queue = {
			testStatus: "Test",
			verifiedLabel: "AgentTested",
			search: async (jql: string, max: number) => (searched.push({ jql, max }), found),
		};
		const env = { CHAT_REPOSITORY_URL: "https://github.com/acme/app" } as NodeJS.ProcessEnv;
		const queued = qaChat(env, /^ABC-\d+$/, undefined, queue);
		const tickets = (planned: any) => planned.batch.map((job: any) => job.input.ticket);

		it("verifies every ticket it is told, one after another, at most five at a time", () => {
			const planned = queued.instructInput!("verify ABC-1, ABC-2 and ABC-1 again, plus OTHER-9") as any;
			assert.deepEqual(tickets(planned), ["ABC-1", "ABC-2"]);
			assert.match(planned.intro, /Verifying 2 tickets, one at a time: ABC-1, ABC-2/);
			const many = queued.instructInput!("verify ABC-1 ABC-2 ABC-3 ABC-4 ABC-5 ABC-6 ABC-7") as any;
			assert.equal(many.batch.length, 5);
			assert.match(many.intro, /2 more are left out/);
		});

		it("works through the tickets that wait in Test, skipping the ones already verified, and keeps scenario and app for each", async () => {
			searched.length = 0;
			const planned = (await queued.instructInput!("app: shop\nscenario: log in as admin\nPlease work through the tickets that are currently in Test. Verify them according to your QA process.")) as any;
			assert.deepEqual(searched, [{ jql: 'status = "Test" ORDER BY updated ASC', max: 20 }]);
			assert.deepEqual(tickets(planned), ["ABC-1", "ABC-3"], "labelled and foreign tickets are left out");
			assert.deepEqual(planned.batch[0].input, { ticket: "ABC-1", repository: { url: "https://github.com/acme/app", ref: "HEAD" }, scenario: "log in as admin", app: "shop" });
			assert.match(planned.intro, /Found 2 tickets to verify: ABC-1, ABC-3\. 1 already verified, skipped\./);
			const again = (await queued.instructInput!("verify the tickets in Test again")) as any;
			assert.deepEqual(tickets(again), ["ABC-1", "ABC-2", "ABC-3"]);
		});

		it("takes a status line or a query line, and refuses what is not a plain state name", async () => {
			searched.length = 0;
			await queued.instructInput!("status: Ready for QA\nverify them");
			await queued.instructInput!("jql: project = ABC AND labels = smoke\nverify them");
			assert.deepEqual(searched.map((entry) => entry.jql), ['status = "Ready for QA" ORDER BY updated ASC', "project = ABC AND labels = smoke"]);
			assert.ok("refuse" in (queued.instructInput!('status: x" OR 1=1 --\nverify them') as any));
			assert.equal(searched.length, 2, "an odd status never reaches the ticket system");
		});

		it("says why when nothing is waiting, when it cannot look tickets up, and how to ask", async () => {
			const none = qaChat(env, /^ABC-\d+$/, undefined, { ...queue, search: async () => [{ key: "ABC-2", labels: ["AgentTested"] }] });
			assert.match(((await none.instructInput!("verify the tickets in Test")) as any).refuse, /no ticket matches that state.*1 already carry the AgentTested label.*say "again"/);
			assert.match((chat.instructInput!("verify the tickets in Test") as any).refuse, /name the ticket\(s\)/, "without a ticket system the state means nothing");
			assert.match((chat.instructInput!("status: Test\nverify them") as any).refuse, /ticket system is not connected/);
		});
	});
});

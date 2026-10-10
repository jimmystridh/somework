import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { describeQaResult, qaChat } from "../src/chat.ts";

describe("QA in conversations", () => {
	const env = { CHAT_REPOSITORY_URL: "https://github.com/acme/app" } as NodeJS.ProcessEnv;
	const chat = qaChat(env);

	it("reads tickets and the repository in a conversation, and its standing orders say so", () => {
		const withTools = qaChat({ CHAT_REPOSITORY_URL: "https://github.com/acme/app", CHAT_REPOSITORY_REF: "main" } as NodeJS.ProcessEnv, undefined, { extension: { name: "qa-jira", tools: [] } as any });
		assert.deepEqual(withTools.toolNames, ["jira_get_issue", "jira_search", "jira_changelog", "jira_get_comments", "jira_get_attachments"]);
		for (const writer of ["jira_comment", "jira_attach", "jira_add_label", "jira_remove_label", "jira_transition_to_in_progress_and_reassign", "qa_record_verdict"]) assert.ok(!withTools.toolNames!.includes(writer), `${writer} stays with the job`);
		assert.deepEqual(withTools.checkout!(), { repoUrl: "https://github.com/acme/app", ref: "main" });
		assert.equal(chat.checkout!()!.ref, undefined);
		assert.equal(qaChat({} as NodeJS.ProcessEnv).checkout, undefined, "no repository configured: nothing to read");
		assert.match(withTools.instructions!, /jira_get_issue/);
		assert.match(withTools.instructions!, /verify_ticket/);
		assert.match(withTools.instructions!, /one after another/);
	});

	it("holds the application stack for every verification, whoever asked, and for nothing else", () => {
		assert.deepEqual(chat.jobResources!("qa.verify", { ticket: "ABC-1" }), ["app-stack"]);
		assert.equal(chat.jobResources!("something.else", {}), undefined);
	});

	describe("as a tool the model may call", () => {
		it("offers verify_ticket, which starts the job at once", () => {
			assert.deepEqual(chat.jobTools!.map((tool) => tool.name), ["verify_ticket"]);
			assert.match(chat.jobTools![0]!.description, /Verify one ticket/);
		});

		it("plans the verification of one ticket with its options and says why it cannot", async () => {
			const [tool] = qaChat(env, /^ABC-\d+$/).jobTools!;
			assert.deepEqual(await tool!.plan({ ticket: " ABC-7 ", scenario: "log in as admin", app: "shop" }), {
				capability: { id: "qa.verify", version: "1" },
				input: { ticket: "ABC-7", repository: { url: "https://github.com/acme/app", ref: "HEAD" }, scenario: "log in as admin", app: "shop" },
				label: "verify ABC-7",
			});
			assert.match(((await tool!.plan({ ticket: "OTHER-1" })) as any).refuse, /not a ticket key this agent handles/);
			assert.match(((await tool!.plan({ ticket: "ABC-1", app: "../x" })) as any).refuse, /application profile/);
			assert.match(((await tool!.plan({ ticket: "ABC-1", repo: "http://x" })) as any).refuse, /https/);
		});
	});

	describe("the account of a finished verification", () => {
		const result = {
			verdict: "not_fixed",
			ticket: "SAD-2258",
			revision: { frontendSha: "ac65396e88d81b2f3e60d026169e6dc53bfc68a1", backendRevision: "9f3c2" },
			notes: "The change is not in the application: the invoice screen sends no Datadog context and the source has no such call.",
			acceptanceChecks: [
				{ criterion: "the invoice screen sends the Datadog context", passed: false, evidence: "network log of the save shows no context headers" },
				{ criterion: "the screen still saves", passed: true, evidence: "saved and reloaded" },
			],
			fixtures: [{ description: "a test invoice", keys: "INV-77" }],
			evidence: [{ kind: "video", filename: "task-qa-video-1.webm" }],
			jira: { commented: true, labelled: false, transitioned: true, attached: true },
		};

		it("says the findings first, then every check with what was seen, and what was written to the ticket", () => {
			const text = describeQaResult(result)!;
			const lines = text.split("\n");
			assert.equal(lines[0], "SAD-2258: NOT FIXED");
			assert.ok(text.indexOf("Findings: The change is not in the application") < text.indexOf("Acceptance checks"), "the finding comes before the checks");
			assert.match(text, /Revision tested: front end ac65396e88d8 · back end 9f3c2/);
			assert.match(text, /Acceptance checks \(1 passed, 1 failed\):\n✘ the invoice screen sends the Datadog context — network log of the save shows no context headers\n✔ the screen still saves — saved and reloaded/);
			assert.match(text, /Created for the test: a test invoice \(INV-77\)/);
			assert.match(text, /Ticket: commented, moved back to In Progress, video attached/);
			assert.match(text, /Evidence: task-qa-video-1\.webm/);
		});

		it("is short for a skipped ticket, keeps long evidence in bounds and leaves anything that is not a result to the default", () => {
			assert.equal(describeQaResult({ verdict: "skipped", ticket: "X-1", jira: { skippedReason: "not a key this agent handles" }, notes: "not a key this agent handles" }), "X-1: SKIPPED\n\nFindings: not a key this agent handles\n\nTicket: nothing was written (not a key this agent handles)");
			const long = describeQaResult({ verdict: "verified", ticket: "A-1", acceptanceChecks: [{ criterion: "c".repeat(900), passed: true, evidence: "e".repeat(2000) }], notes: "n".repeat(5000) })!;
			assert.ok(long.length < 2600, String(long.length));
			assert.equal(describeQaResult(undefined), undefined);
			assert.equal(describeQaResult({ status: "done" }), undefined);
			assert.equal(qaChat({} as NodeJS.ProcessEnv).describeResult, describeQaResult);
		});
	});
});

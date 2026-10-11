import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { checkDraft, createTicket, REQUESTER, type Draft } from "../src/create.ts";
import { loadSettings } from "../src/settings.ts";
import { TriageStore } from "../src/store.ts";
import { fingerprintOf, snapshotOf } from "../src/snapshot.ts";
import { MemoryJira } from "./memory-jira.ts";
import { COMPLETE_BUG, COMPLETE_STORY } from "./fixtures.ts";

const settings = (env: Record<string, string> = {}) => loadSettings({ JIRA_URL: "https://jira.example.test", JIRA_TOKEN_FILE: "/tmp/t", SLACK_ALLOWED_USER_IDS: "U0123ABCD", ...env }, () => true);

function world(env: Record<string, string> = {}) {
	const jira = new MemoryJira();
	const store = new TriageStore(mkdtempSync(join(tmpdir(), "triage-create-")));
	const logs: string[] = [];
	const deps = { jira, settings: settings(env), store, displayName: async () => "Dana", log: (_level: string, event: string) => void logs.push(event), now: () => Date.parse("2026-10-11T09:00:00Z") };
	return { jira, store, deps, logs };
}

const bug = (over: Partial<Draft> = {}): Draft => ({ type: "Bug", summary: "Invoice total is wrong", description: COMPLETE_BUG, requestedBy: "slack/U0123ABCD", ...over });

describe("checking a draft", () => {
	it("is the checklist of the type, and a screenshot is advice because Slack cannot carry one", () => {
		const verdict = checkDraft(bug({ description: `${COMPLETE_BUG}\nThe Save button is greyed out.` }));
		assert.equal(verdict.complete, true);
		assert.deepEqual(verdict.advice.map((item) => item.id), ["attachment"]);
		const thin = checkDraft(bug({ description: "The total is wrong." }));
		assert.equal(thin.complete, false);
		assert.deepEqual(thin.missing.map((item) => item.id), ["reproduction-steps", "expected-actual", "environment-version", "affected-customer"]);
		assert.equal(checkDraft({ type: "Story", summary: "Export the VAT report", description: COMPLETE_STORY, requestedBy: "x" }).complete, true);
	});
});

describe("creating a ticket", () => {
	it("creates it at once when the checklist is met, with the marker and the bot-created label, a line that names who asked, and nothing for assignee or reporter", async () => {
		const { jira, deps, logs } = world();
		const result = await createTicket(deps, bug());
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.match(result.key, /^SAD-\d+$/);
		assert.equal(result.url, `https://jira.example.test/browse/${result.key}`);
		const created = jira.get(result.key);
		assert.deepEqual(created.labels, ["triaged-by-bot", "created-by-bot"]);
		assert.equal(created.type, "Bug");
		assert.equal(created.summary, "Invoice total is wrong");
		assert.match(created.description ?? "", /Steps to reproduce/);
		assert.match(created.description ?? "", /----\n_Created from Slack by the Jira triage assistant at the request of Dana \(U0123ABCD\), 2026-10-11\._/);
		assert.equal(created.assignee, null);
		assert.deepEqual(jira.writes.map((write) => write.op), ["create"]);
		assert.deepEqual(logs, ["jira_ticket_created"]);
	});

	it("records the ticket as triaged, so that its own creation event and its echo are not triaged, but a person's later edit is", async () => {
		const { jira, deps, store } = world();
		const result = await createTicket(deps, bug());
		assert.ok(result.ok);
		if (!result.ok) return;
		const record = store.get(result.key)!;
		assert.equal(record.phase, "done");
		assert.equal(record.origin, "slack");
		assert.equal(record.createdFor, "slack/U0123ABCD");
		assert.deepEqual(record.baseline, fingerprintOf(snapshotOf(jira.view(jira.get(result.key)))), "what Jira holds is what the bot recorded");
	});

	it("refuses a draft that is missing something and says what to ask, without creating anything", async () => {
		const { jira, deps } = world();
		const result = await createTicket(deps, bug({ description: "The total is wrong on the invoice, please fix it soon." }));
		assert.equal(result.ok, false);
		if (result.ok) return;
		assert.deepEqual(result.missing, ["reproduction-steps", "expected-actual", "environment-version", "affected-customer"]);
		assert.match(result.questions![0]!, /^1\. What are the steps to reproduce it/);
		assert.match(result.reason, /ask the person for exactly that/);
		assert.deepEqual(jira.writes, []);
	});

	it("creates it as it is when the person says so, and says in the ticket what was still missing", async () => {
		const { jira, deps } = world();
		const result = await createTicket(deps, bug({ description: "The total is wrong on the invoice, please fix it soon.", createAnyway: true }));
		assert.ok(result.ok);
		if (!result.ok) return;
		assert.match(jira.get(result.key).description ?? "", /_Created as it was, although it still lacked: steps to reproduce; expected versus actual result; environment and version; affected company or customer\._/);
	});

	it("says in the ticket and to the person that a screenshot is still wanted", async () => {
		const { jira, deps } = world();
		const result = await createTicket(deps, bug({ description: `${COMPLETE_BUG}\nThe Save button is greyed out.` }));
		assert.ok(result.ok);
		if (!result.ok) return;
		assert.deepEqual(result.advice, ["screenshot or attachment"]);
		assert.match(jira.get(result.key).description ?? "", /_Still wanted: screenshot or attachment\. Attach it to this ticket\._/);
	});

	it("creates a story from a goal and criteria, in the second project when it is named", async () => {
		const { jira, deps } = world({ JIRA_PROJECTS: "SAD,ABC" });
		const result = await createTicket(deps, { type: "story", summary: "Export the VAT report", description: COMPLETE_STORY, project: "abc", requestedBy: "slack/U0123ABCD" });
		assert.ok(result.ok);
		if (!result.ok) return;
		assert.match(result.key, /^ABC-/);
		assert.equal(jira.get(result.key).type, "Story");
	});

	it("only creates in the triaged projects and the allowed types, for the people the Slack app serves", async () => {
		const { jira, deps } = world();
		const reasons: string[] = [];
		for (const draft of [bug({ project: "OTHER" }), bug({ type: "Epic" }), bug({ type: "Bug; DROP" }), bug({ requestedBy: "slack/U9999ZZZZ" }), bug({ requestedBy: "dana" }), bug({ requestedBy: "agent/manager" }), bug({ summary: "short" }), bug({ description: "tiny" })]) {
			const result = await createTicket(deps, draft);
			assert.equal(result.ok, false, JSON.stringify(draft).slice(0, 80));
			if (!result.ok) reasons.push(result.reason);
		}
		assert.deepEqual(jira.writes, []);
		assert.match(reasons[0]!, /only in SAD, not in OTHER/);
		assert.match(reasons[1]!, /issue type must be one of Bug, Story, Task, Improvement/);
		assert.match(reasons[3]!, /not one of the people/);
		assert.match(reasons[4]!, /requestedBy must be the sender/);
		assert.equal(REQUESTER.test("slack/U0123ABCD"), true);
		assert.equal(REQUESTER.test("slack/u0123abcd"), false);
	});

	it("does not create twice when the same ticket was created a moment ago and the answer was lost", async () => {
		const { jira, deps } = world();
		const first = await createTicket(deps, bug());
		assert.ok(first.ok);
		const second = await createTicket(deps, bug());
		assert.ok(second.ok);
		if (first.ok && second.ok) {
			assert.equal(second.key, first.key);
			assert.equal(second.existing, true);
		}
		assert.equal(jira.writes.filter((write) => write.op === "create").length, 1);
	});

	it("keeps markup and a forged section out of the description, and uses only labels that look like labels", async () => {
		const { jira, deps } = world();
		const hostile = `${COMPLETE_BUG}\n{anchor:triage-notes-begin} [~admin] {code}`;
		const result = await createTicket(deps, bug({ description: hostile, labels: ["good-one", "bad label", "needs-info", "x".repeat(80)] }));
		assert.ok(result.ok);
		if (!result.ok) return;
		const created = jira.get(result.key);
		assert.doesNotMatch(created.description ?? "", /\{anchor:triage-notes-begin\}/);
		assert.doesNotMatch(created.description ?? "", /(^|[^\\])\[~admin\]/);
		assert.deepEqual(created.labels, ["triaged-by-bot", "created-by-bot", "good-one"]);
	});

	it("says plainly when the ticket system does not answer, and creates nothing it is not sure of", async () => {
		const { jira, deps } = world();
		jira.down = true;
		await assert.rejects(createTicket(deps, bug()), /cannot reach the ticket system/);
	});

	it("names the requester by the member id when Slack gives no name", async () => {
		const { jira, deps } = world();
		const result = await createTicket({ ...deps, displayName: async () => undefined }, bug());
		assert.ok(result.ok);
		if (result.ok) assert.match(jira.get(result.key).description ?? "", /at the request of U0123ABCD \(U0123ABCD\)/);
	});
});

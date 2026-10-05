import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { isDoneStatus, JiraClient, JiraError, previousAssignee } from "../src/jira.ts";
import { FakeJira, PAT, testIssue } from "./fake-jira.ts";
import { makeTls, type TestTls } from "./tls.ts";

let tls: TestTls;
let jira: FakeJira;
before(async () => {
	tls = makeTls(mkdtempSync(join(tmpdir(), "qa-tls-")));
	jira = await FakeJira.start(tls);
});
after(() => jira.close());

const client = (over: Partial<ConstructorParameters<typeof JiraClient>[0]> = {}) => new JiraClient({ baseUrl: jira.url, token: PAT, pfx: tls.clientPfx, passphrase: tls.clientPassphrase, ca: tls.ca, timeoutMs: 5000, ...over });

describe("the ticket system client over mutual TLS", () => {
	it("works with the client certificate and the bearer token", async () => {
		const c = client();
		assert.equal((await c.myself()).name, "qa-bot");
		const issue = await c.getIssue("QA-1", "changelog");
		assert.equal(issue.key, "QA-1");
		assert.equal(issue.fields.status?.name, "Test");
		assert.equal(issue.changelog?.histories?.length, 1);
		c.close();
	});

	it("is refused by the server without a client certificate", async () => {
		const c = client({ pfx: undefined, passphrase: undefined });
		await assert.rejects(() => c.myself(), (error) => error instanceof JiraError && error.status === 0 && /cannot reach the ticket system/.test(error.message));
		c.close();
	});

	it("is refused with a certificate from a CA the server does not trust", async () => {
		const c = client({ pfx: tls.strangerPfx });
		await assert.rejects(() => c.myself(), JiraError);
		c.close();
	});

	it("does not trust a server whose certificate it cannot verify", async () => {
		const c = client({ ca: undefined });
		await assert.rejects(() => c.myself(), (error) => error instanceof JiraError && /cannot reach/.test(error.message));
		c.close();
	});

	it("reports an API error with its status and never leaks the token", async () => {
		const c = client({ token: "wrong-token-value-0000000000" });
		await assert.rejects(
			() => c.myself(),
			(error) => error instanceof JiraError && error.status === 401 && !error.message.includes("wrong-token-value") && /bad token/.test(error.message),
		);
		await assert.rejects(() => client().getIssue("NOPE-9"), (error) => error instanceof JiraError && error.status === 404);
		c.close();
	});

	it("writes: comment, labels, transition, assignment and an attachment", async () => {
		const c = client();
		jira.issues.set("QA-2", testIssue("QA-2"));
		assert.equal((await c.addComment("QA-2", "verified")).id, "100");
		await c.addLabel("QA-2", "AgentTested");
		await c.addLabel("QA-2", "AgentTested");
		assert.deepEqual(jira.issues.get("QA-2")!.labels, ["Frontend", "AgentTested"], "adding twice keeps one, and the existing label stays");
		await c.removeLabel("QA-2", "AgentTested");
		assert.deepEqual(jira.issues.get("QA-2")!.labels, ["Frontend"]);
		const transitions = await c.transitions("QA-2");
		assert.deepEqual(transitions.map((t) => t.to.name), ["In Progress", "Done"]);
		await c.transition("QA-2", "11");
		assert.equal(jira.issues.get("QA-2")!.status.name, "In Progress");
		await c.assign("QA-2", "dana");
		assert.equal(jira.issues.get("QA-2")!.assignee?.name, "dana");
		await c.assign("QA-2", "JIRAUSER123");
		const sent = jira.requests.filter((r) => r.path.endsWith("/assignee")).map((r) => JSON.parse(r.body!));
		assert.deepEqual(sent, [{ name: "dana" }, { key: "JIRAUSER123" }], "a user key is sent as a key, a user name as a name");
		await c.attach("QA-2", "video 1.webm", Buffer.from("webm-bytes"), "video/webm");
		assert.match(jira.issues.get("QA-2")!.attachments[0]!.filename, /^video_1\.webm$/);
		const upload = jira.requests.filter((r) => r.path.endsWith("/attachments"));
		assert.equal(upload.length, 1);
		c.close();
	});
});

describe("done statuses and the previous assignee", () => {
	it("recognises a done status by category and by name, never In Progress or Test", () => {
		assert.equal(isDoneStatus({ name: "Anything", statusCategory: { key: "done" } }), true);
		for (const name of ["Done", "closed", "Resolved", " Complete ", "Released", "Won't Do", "Cancelled"]) assert.equal(isDoneStatus({ name, statusCategory: { key: "indeterminate" } }), true, name);
		for (const name of ["In Progress", "Test", "Ready for test", "Doing"]) assert.equal(isDoneStatus({ name, statusCategory: { key: "indeterminate" } }), false, name);
		assert.equal(isDoneStatus(undefined), false);
	});

	it("takes the most recent assignee from before the ticket became unassigned", () => {
		const histories = [
			{ created: "2026-09-01T10:00:00.000+0200", items: [{ field: "assignee", from: "old", fromString: "Old Owner", to: "mid", toString: "Mid" }] },
			{ created: "2026-10-02T10:00:00.000+0200", items: [{ field: "assignee", from: "mid", fromString: "Mid Owner", to: null, toString: null }, { field: "status", fromString: "Doing", toString: "Test" }] },
			{ created: "2026-09-15T10:00:00.000+0200", items: [{ field: "assignee", from: null, fromString: null, to: "old", toString: "Old Owner" }] },
		];
		assert.deepEqual(previousAssignee(histories), { name: "mid", displayName: "Mid Owner" });
		assert.equal(previousAssignee([]), undefined);
		assert.equal(previousAssignee([{ created: "x", items: [{ field: "assignee", from: null, to: "a" }] }]), undefined, "never assigned before");
	});
});

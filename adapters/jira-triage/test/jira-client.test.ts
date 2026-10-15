import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { isUnreachable, JiraClient, JiraError, WRITABLE_FIELD_KEYS } from "../src/jira/client.ts";
import { FakeJira, PAT } from "./fake-jira.ts";
import { dana, issueOf } from "./memory-jira.ts";
import { makeTls, type TestTls } from "./tls.ts";

let tls: TestTls;
let jira: FakeJira;
before(async () => {
	tls = makeTls(mkdtempSync(join(tmpdir(), "triage-tls-")));
	jira = await FakeJira.start(tls, [issueOf("SAD-1", { labels: ["keep"], environment: "Test", attachments: [{ id: "5", filename: "s.png", mimeType: "image/png" }] })]);
});
after(() => jira.close());

const client = (over: Partial<ConstructorParameters<typeof JiraClient>[0]> = {}) => new JiraClient({ baseUrl: jira.url, token: PAT, pfx: tls.clientPfx, passphrase: tls.clientPassphrase, ca: tls.ca, retryPauseMs: 5, readTimeoutMs: 400, ...over });
const writesBefore = () => jira.requests.length;

describe("the ticket system client", () => {
	it("authenticates with the client certificate and the token, and reads who it is", async () => {
		const c = client();
		assert.equal((await c.myself()).name, "triage-bot");
		c.close();
	});

	it("is refused by a host that does not know its certificate, and by a wrong token", async () => {
		const stranger = client({ pfx: tls.strangerPfx });
		await assert.rejects(stranger.myself(), (error: Error) => error instanceof JiraError && isUnreachable(error));
		stranger.close();
		const wrong = client({ token: "not-the-token-0123456789" });
		await assert.rejects(wrong.getIssue("SAD-1"), (error: Error) => error instanceof JiraError && (error as JiraError).status === 401 && !error.message.includes("not-the-token"));
		wrong.close();
	});

	it("reads a ticket with the fields a triage needs", async () => {
		const c = client();
		const issue = await c.getIssue("SAD-1");
		assert.equal(issue.key, "SAD-1");
		assert.equal(issue.fields.issuetype?.name, "Bug");
		assert.equal(issue.fields.reporter?.emailAddress, dana.emailAddress);
		assert.deepEqual(issue.fields.labels, ["keep"]);
		assert.equal(issue.fields.environment, "Test");
		assert.equal(issue.fields.attachment?.[0]?.filename, "s.png");
		const request = jira.requests.at(-1)!;
		assert.match(request.path, /fields=.*reporter/);
		c.close();
	});

	it("lists the components of a project, with their descriptions, and skips what has no name", async () => {
		jira.memory.projectComponentList = [{ name: "Försäljning - Kundfakturor", description: " Customer invoices " }, { name: "Infrastruktur" }];
		const c = client();
		assert.deepEqual(await c.projectComponents("SAD"), [{ name: "Försäljning - Kundfakturor", description: "Customer invoices" }, { name: "Infrastruktur" }]);
		assert.equal(jira.requests.at(-1)!.path, "/rest/api/2/project/SAD/components");
		c.close();
	});

	it("says 404 for a ticket that is not there", async () => {
		const c = client();
		await assert.rejects(c.getIssue("SAD-404"), (error: Error) => (error as JiraError).status === 404);
		c.close();
	});

	it("searches, finds users with their address, and reads comments", async () => {
		const c = client();
		const found = await c.search('project in (SAD) AND text ~ "total" ORDER BY created DESC', 5);
		assert.equal(found.issues[0]?.key, "SAD-1");
		assert.equal((await c.user("dana"))?.emailAddress, "dana@example.test");
		assert.equal(await c.user("nobody"), undefined);
		assert.deepEqual(await c.comments("SAD-1"), []);
		c.close();
	});

	it("adds a comment once, and never repeats a write that was lost after it was sent", async () => {
		const c = client();
		const before = writesBefore();
		const made = await c.addComment("SAD-1", "Hello");
		assert.ok(made.id);
		assert.equal(jira.requests.slice(before).filter((request) => request.method === "POST").length, 1);
		jira.fail = 1;
		await assert.rejects(c.addComment("SAD-1", "Again"), (error: Error) => (error as JiraError).status === 503);
		assert.equal(jira.requests.filter((request) => request.method === "POST" && request.path.endsWith("/comment")).length, 2, "a comment is sent once per call: no silent second try");
		c.close();
	});

	it("tries a read again when the system fails or does not answer, and says it is unreachable when it never does", async () => {
		const c = client();
		jira.fail = 2;
		assert.equal((await c.getIssue("SAD-1")).key, "SAD-1");
		jira.hang = 1;
		assert.equal((await c.getIssue("SAD-1")).key, "SAD-1");
		jira.fail = 9;
		await assert.rejects(c.getIssue("SAD-1"), (error: Error) => isUnreachable(error));
		jira.fail = 0;
		c.close();
	});

	it("writes text fields with one PUT, and labels one operation at a time", async () => {
		const c = client();
		await c.updateFields("SAD-1", { description: "New", environment: "Prod" });
		assert.deepEqual(JSON.parse(jira.requests.at(-1)!.body!), { fields: { description: "New", environment: "Prod" } });
		await c.updateLabels("SAD-1", { add: ["triaged-by-bot"], remove: ["keep"] });
		assert.deepEqual(JSON.parse(jira.requests.at(-1)!.body!), { update: { labels: [{ add: "triaged-by-bot" }, { remove: "keep" }] } });
		assert.deepEqual(jira.memory.get("SAD-1").labels, ["triaged-by-bot"]);
		const n = writesBefore();
		await c.updateLabels("SAD-1", {});
		await c.updateFields("SAD-1", {});
		assert.equal(writesBefore(), n, "nothing to say, nothing sent");
		c.close();
	});

	it("has no way to reach the assignee, the status or the reporter, and refuses a payload that tries", async () => {
		const c = client();
		for (const name of ["assign", "transition", "transitions", "setReporter", "setStatus", "updateIssue"]) assert.equal((c as unknown as Record<string, unknown>)[name], undefined, name);
		const before = writesBefore();
		for (const field of ["assignee", "reporter", "status", "resolution", "summary", "issuetype", "labels"]) {
			await assert.rejects(c.updateFields("SAD-1", { [field]: "x" } as never), (error: Error) => error instanceof JiraError && /is not one this role writes/.test(error.message), field);
		}
		assert.equal(writesBefore(), before, "nothing reached the host");
		assert.deepEqual([...WRITABLE_FIELD_KEYS], ["description", "environment", "priority", "components", "labels"]);
		c.close();
	});

	it("creates a ticket with the fields given and returns its key", async () => {
		const c = client();
		const created = await c.createIssue({ project: "SAD", type: "Bug", summary: "Total is wrong", description: "Text", environment: "Prod", labels: ["triaged-by-bot", "created-by-bot"], components: ["web"] });
		assert.match(created.key, /^SAD-\d+$/);
		const body = JSON.parse(jira.requests.at(-1)!.body!);
		assert.deepEqual(body.fields.project, { key: "SAD" });
		assert.deepEqual(body.fields.issuetype, { name: "Bug" });
		assert.deepEqual(body.fields.labels, ["triaged-by-bot", "created-by-bot"]);
		assert.deepEqual(body.fields.components, [{ name: "web" }]);
		assert.equal(body.fields.assignee, undefined);
		assert.equal(body.fields.reporter, undefined);
		assert.ok(jira.memory.get(created.key));
		c.close();
	});

	it("builds the address a person opens", () => {
		const c = client();
		assert.equal(c.browseUrl("SAD-1"), `${jira.url}/browse/SAD-1`);
		c.close();
	});
});

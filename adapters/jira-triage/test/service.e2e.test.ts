import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { sleep } from "@somework/sdk";
import { freePort, startDomain } from "../../../sdk/typescript/test/harness.ts";
import { isBotComment } from "../src/wiki.ts";
import { FakeJira, PAT } from "./fake-jira.ts";
import { dana, issueOf } from "./memory-jira.ts";
import { makeTls } from "./tls.ts";

const here = new URL(".", import.meta.url).pathname;
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const logs = new Map<ChildProcess, string>();
const run = (script: string, env: Record<string, string>): ChildProcess => {
	const child = spawn("node", [script], { env: { PATH: process.env.PATH!, HOME: process.env.HOME!, ...env }, stdio: ["ignore", "ignore", "pipe"] });
	logs.set(child, "");
	child.stderr!.on("data", (d) => logs.set(child, logs.get(child)! + d));
	return child;
};

async function until<T>(what: string, read: () => Promise<T | undefined | false>, ms = 30_000): Promise<T> {
	const deadline = Date.now() + ms;
	for (;;) {
		const value = await read().catch(() => undefined);
		if (value) return value;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}\n${[...logs.values()].join("\n").slice(-3500)}`);
		await sleep(150);
	}
}

/** The real role as a service process, over a real domain, a real sandbox daemon and a ticket system that speaks mutual TLS. Slack is off here, so a reporter is asked in a Jira comment. */
async function boot(options: { plan?: string[]; issues?: ReturnType<typeof issueOf>[]; env?: Record<string, string> } = {}) {
	const domain = await startDomain({ cardFile: join(here, "../card.json"), publish: "jira.*" });
	cleanups.push(() => domain.close());
	const dir = mkdtempSync(join(tmpdir(), "jira-triage-e2e-"));
	const workspaces = join(dir, "workspaces");
	mkdirSync(workspaces);
	const state = join(dir, "state");
	mkdirSync(state);
	const tls = makeTls(join(dir, "tls"));
	const jira = await FakeJira.start(tls, options.issues ?? [issueOf("SAD-1", { summary: "Invoice total", description: "The total is wrong. Customer Acme AB." })]);
	cleanups.push(() => jira.close());
	jira.memory.clock = () => new Date().toISOString();
	const file = (name: string, content: string | Buffer) => {
		const path = join(dir, name);
		writeFileSync(path, content, { mode: 0o600 });
		return path;
	};
	const tokenFile = file("sandbox-token", "s".repeat(48));
	const sandboxPort = await freePort();
	const sandbox = run(join(here, "../../../packages/agent-kit/src/sandbox/main.ts"), { SANDBOX_TOKEN_FILE: tokenFile, SANDBOX_ROOT: workspaces, SANDBOX_PORT: String(sandboxPort), SANDBOX_HOST: "127.0.0.1" });
	cleanups.push(() => void sandbox.kill("SIGKILL"));
	await until("the sandbox", async () => (await fetch(`http://127.0.0.1:${sandboxPort}/healthz`)).ok);
	const healthPort = await freePort();
	const service = run(join(here, "../src/main.ts"), {
		SOMEWORK_URL: domain.url,
		SOMEWORK_KEY_FILE: join(domain.dir, "worker.key.json"),
		PI_STATE_DIR: state,
		PI_PROVIDER: "faux",
		PI_FAUX_PLAN: JSON.stringify(options.plan ?? ["final:ok"]),
		SANDBOX_URL: `http://127.0.0.1:${sandboxPort}`,
		SANDBOX_TOKEN_FILE: tokenFile,
		SANDBOX_WORKSPACES: workspaces,
		HEALTH_PORT: String(healthPort),
		PI_CONCURRENCY: "2",
		SOMEWORK_LEASE_SECONDS: "5",
		EVENTS_HANDLER_TIMEOUT_SECONDS: "10",
		EVENTS_NOTIFY_TO: "agent/ts-author",
		JIRA_URL: jira.url,
		JIRA_TOKEN_FILE: file("jira-token", PAT),
		JIRA_PFX_FILE: file("jira.pfx", tls.clientPfx),
		JIRA_PFX_PASSWORD_FILE: file("jira-pfx-password", tls.clientPassphrase),
		JIRA_CA_FILE: file("jira-ca.pem", tls.ca),
		TRIAGE_ENRICH: "0",
		SLACK_ALLOWED_USER_IDS: "U0123ABCD",
		...options.env,
	});
	cleanups.push(() => void service.kill("SIGKILL"));
	const status = async () => (await (await fetch(`http://127.0.0.1:${healthPort}/status`)).json()) as any;
	await until("the service to be ready", async () => (await (await fetch(`http://127.0.0.1:${healthPort}/ready`)).json() as any).ready);
	await until("the handler to be seeded", async () => (await status()).handlers?.some((handler: any) => handler.name === "jira" && handler.enabled));
	await sleep(600); // the first look at the event feed fast-forwards past anything that already exists
	await domain.worker().post("/v1/subscriptions", { kind: "topic", selector: "jira.*", wakeOnMatch: true });
	const publish = (topic: string, key: string, data: Record<string, unknown>) => domain.author.post("/v1/events/publish", { topic, key, source: "jira", data });
	const inbox = async (): Promise<string[]> => (((await domain.author.get("/v1/inbox?limit=100")) as any).messages ?? []).map((entry: any) => String(entry?.content?.data ?? entry?.message?.content?.data ?? ""));
	return { domain, jira, status, publish, inbox, healthPort, state };
}

const created = (key = "SAD-1") => ({ issue: { key, summary: "Invoice total", url: `https://jira.example.test/browse/${key}`, type: "Bug", project: "SAD" }, actor: "dana" });

describe("the Jira triage agent end to end (real service process, real domain, real sandbox, mutual TLS to the ticket system)", () => {
	it("takes a new ticket from an event to a question for the reporter, and the reporter's comment to the end of the triage", async () => {
		const world = await boot();
		await world.publish("jira.issue.created", "jira:1:created", created());
		const ask = await until("the question to the reporter in Jira", async () => {
			const issue = world.jira.memory.get("SAD-1");
			return issue.comments.length > 0 && issue.labels.includes("needs-info") ? issue : undefined;
		});
		assert.ok(isBotComment(ask.comments[0]!.body));
		assert.match(ask.comments[0]!.body, /Hi \[~dana\],[\s\S]*1\. What are the steps to reproduce it[\s\S]*2\. What did you expect to happen[\s\S]*3\. Which environment and version/);
		assert.deepEqual(ask.labels, ["triaged-by-bot", "needs-info"]);
		assert.equal(ask.assignee, null);
		const notice = await until("the job's notice to the owner", async () => (await world.inbox()).find((text) => text.includes("SAD-1: asked reporter")));
		assert.match(notice, /asked Dana Dev on a Jira comment about reproduction-steps, expected-actual, environment-version/);

		const reply = world.jira.memory.say("SAD-1", dana, "1. open the invoice\n2. add two rows and save\nIt should show 250 but shows 200.\nVersion 2025.11 in production");
		await world.publish("jira.comment.created", `jira:1:comment:${reply.id}`, { ...created(), comment: { id: reply.id, author: "dana", body: "1. open the invoice" } });
		const done = await until("the triage to end", async () => {
			const issue = world.jira.memory.get("SAD-1");
			return !issue.labels.includes("needs-info") && issue.comments.length >= 3 ? issue : undefined;
		});
		assert.deepEqual(done.labels, ["triaged-by-bot"]);
		assert.equal(done.environment, "Version 2025.11 in production");
		assert.match(done.description ?? "", /Answer from the reporter \(Jira\)/);
		assert.match(done.comments.at(-1)!.body, /Thank you, that is what the team needs/);
		assert.equal(done.assignee, null);
		assert.equal(done.status, "Open");
		assert.ok(world.jira.memory.writes.every((write) => ["labels", "fields", "comment"].includes(write.op)));
	});

	it("asks the developer agent for a read-only look first, over the domain's messages, folds its answer into the ticket, then asks the reporter for what is still missing", async () => {
		const world = await boot({ env: { TRIAGE_ENRICH: "1", TRIAGE_DEVELOPER_AGENT: "agent/ts-author", TRIAGE_TICK_SECONDS: "1", TRIAGE_DEVELOPER_POLL_SECONDS: "1" } });
		await world.publish("jira.issue.created", "jira:7:created", created());
		const request = await until("the request to the developer agent", async () => {
			const messages = (((await world.domain.author.get("/v1/inbox?limit=100")) as any).messages ?? []) as any[];
			return messages.find((entry) => String(entry?.content?.data ?? "").startsWith("Read-only investigation request"));
		});
		assert.match(request.content.data, /Do not start any job/);
		assert.match(request.content.data, /Customer Acme AB/);
		assert.equal(request.labels.jiraTriage, "SAD-1");
		assert.equal(world.jira.memory.get("SAD-1").comments.length, 0, "nobody is asked while the developer looks");
		await world.domain.author.post("/v1/messages", {
			recipients: [{ kind: "agent", id: "agent/ts-worker" }],
			conversationId: request.conversationId,
			replyTo: request.messageId,
			causationId: request.messageId,
			content: { mediaType: "text/plain", data: "It is computed in the posting module.\nFINDING reproduction-steps: Open the invoice, add two rows and save it." },
			triggerMode: "directed",
		});
		const asked = await until("the reporter to be asked", async () => {
			const issue = world.jira.memory.get("SAD-1");
			return issue.comments.length === 1 && issue.labels.includes("needs-info") ? issue : undefined;
		});
		assert.match(asked.description ?? "", /Findings of the developer agent \(read-only investigation\)\*[\s\S]*posting module/);
		assert.doesNotMatch(asked.comments[0]!.body, /steps to reproduce/, "the developer closed the steps: the reporter is not asked for them");
		assert.match(asked.comments[0]!.body, /1\. What did you expect to happen[\s\S]*2\. Which environment and version/);
	});

	it("does not triage a ticket twice for the same event, a ticket of another project, or a ticket that already carries the marker", async () => {
		const world = await boot({ issues: [issueOf("SAD-1", { summary: "Invoice total", description: "The total is wrong. Customer Acme AB." }), issueOf("SAD-2", { labels: ["triaged-by-bot"] }), issueOf("OTHER-3")] });
		await world.publish("jira.issue.created", "jira:2:created", created("SAD-2"));
		await world.publish("jira.issue.created", "jira:3:created", { ...created("OTHER-3"), issue: { ...created("OTHER-3").issue, project: "OTHER" } });
		await world.publish("jira.issue.created", "jira:1:created", created("SAD-1"));
		await world.publish("jira.issue.created", "jira:1:created", created("SAD-1"));
		await until("the first ticket to be asked about", async () => world.jira.memory.get("SAD-1").comments.length > 0);
		await sleep(1500);
		assert.equal(world.jira.memory.get("SAD-1").comments.length, 1, "asked once");
		assert.deepEqual(world.jira.memory.get("SAD-2").labels, ["triaged-by-bot"]);
		assert.equal(world.jira.memory.get("SAD-2").comments.length, 0);
		assert.equal(world.jira.memory.get("OTHER-3").comments.length, 0);
	});

	it("carries on after the ticket system was down: the event is not lost, and the ticket is taken up again when Jira is back", async () => {
		const world = await boot({ env: { TRIAGE_RETRY_MINUTES: "0.03", TRIAGE_TICK_SECONDS: "1" } });
		world.jira.fail = 10_000;
		await world.publish("jira.issue.created", "jira:5:created", created());
		const outcome = await until("the job to report the outage", async () => (await world.inbox()).find((text) => /SAD-1: retry/.test(text)), 60_000);
		assert.match(outcome, /the ticket system did not answer/);
		assert.equal(world.jira.memory.get("SAD-1").comments.length, 0);
		const { readFileSync } = await import("node:fs");
		const record = JSON.parse(readFileSync(join(world.state, "jira-triage", "tickets.json"), "utf8"))[0];
		assert.equal(record.id, "SAD-1");
		assert.equal(record.phase, "queued");
		assert.ok(record.attempts >= 1);
		world.jira.fail = 0;
		const asked = await until("the retry to ask the reporter", async () => {
			const issue = world.jira.memory.get("SAD-1");
			return issue.comments.length === 1 && issue.labels.includes("needs-info") ? issue : undefined;
		}, 60_000);
		assert.ok(isBotComment(asked.comments[0]!.body));
	});

	it("helps create a ticket in a conversation: searches, checks the draft, and creates it at once with the labels and the requester named", async () => {
		const draft = { type: "Bug", summary: "Invoice total is wrong", description: "Steps to reproduce:\n1. Open the invoice for customer Acme AB\n2. Add two rows and save\nExpected 250 but got 200.\nVersion 2025.11 in production.", requestedBy: "slack/U0123ABCD" };
		const world = await boot({
			plan: [`call:ticket_search:${JSON.stringify({ query: "invoice total" })}`, `call:ticket_check:${JSON.stringify(draft)}`, `call:ticket_create:${JSON.stringify(draft)}`, "final:Created the ticket."],
		});
		await world.domain.author.post("/v1/messages", { recipients: [{ kind: "agent", id: "agent/ts-worker" }], content: { mediaType: "text/plain", data: "please make a ticket: the invoice total is wrong" }, triggerMode: "directed" });
		const made = await until("the ticket to be created", async () => [...world.jira.memory.issues.values()].find((issue) => issue.labels.includes("created-by-bot")));
		assert.deepEqual(made.labels, ["triaged-by-bot", "created-by-bot"]);
		assert.equal(made.summary, "Invoice total is wrong");
		assert.match(made.description ?? "", /at the request of U0123ABCD \(U0123ABCD\)/);
		await until("the answer", async () => (await world.inbox()).find((text) => text.includes("Created the ticket.")));
		assert.ok(world.jira.requests.some((request) => request.path.includes("/rest/api/2/search") && decodeURIComponent(request.path).includes('text ~ "invoice total"')));
		assert.deepEqual(world.jira.memory.writes.filter((write) => write.op !== "create"), []);
		await sleep(1000);
		await world.domain.author.post("/v1/events/publish", { topic: "jira.issue.created", key: "jira:9:created", source: "jira", data: created(made.key) });
		await sleep(1500);
		assert.equal(world.jira.memory.get(made.key).comments.length, 0, "the creation event of a ticket the bot made is not triaged");
	});
});

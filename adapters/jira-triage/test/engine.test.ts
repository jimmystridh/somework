import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { JiraError } from "../src/jira/client.ts";
import { isBotComment, NOTES_BEGIN, readNotes } from "../src/wiki.ts";
import { BOT, dana, issueOf } from "./memory-jira.ts";
import { COMPLETE_TEXT, HOUR, MINUTE, rig, thinBug } from "./rig.ts";

const MARKER = "triaged-by-bot";

/** What a bot that has no business with assignees, statuses and reporters leaves alone, whatever else it does. */
function assertUntouched(world: ReturnType<typeof rig>, key = "SAD-1"): void {
	const ticket = world.ticket(key);
	assert.equal(ticket.assignee, null, "assignee");
	assert.equal(ticket.status, "Open", "status");
	assert.equal(ticket.reporter?.name, "dana", "reporter");
	assert.ok(world.jira.writes.every((write) => ["labels", "fields", "comment"].includes(write.op)), JSON.stringify(world.ops()));
}

describe("a ticket that is complete", () => {
	it("gets the marker label and nothing else: no comment, no question, nobody asked", async () => {
		const world = rig({ issues: [issueOf("SAD-1", { summary: "Invoice total", description: COMPLETE_TEXT })] });
		const outcome = await world.engine.handle("SAD-1", { kind: "created", eventKey: "jira:1:created" });
		assert.equal(outcome.status, "complete");
		assert.deepEqual(world.ticket().labels, [MARKER]);
		assert.deepEqual(world.ops(), ["labels"]);
		assert.equal(world.slack!.posted.length, 0);
		assert.equal(world.developer!.asked.length, 0);
		assert.equal(world.ticket().comments.length, 0);
		assert.equal(world.record().phase, "done");
		assert.ok(world.record().baseline);
		assert.equal(world.record().nextAttemptAt, undefined);
		assertUntouched(world);
	});

	it("records the label change with its value before and after, so it can be reverted by hand", async () => {
		const world = rig({ issues: [issueOf("SAD-1", { summary: "Invoice total", description: COMPLETE_TEXT, labels: ["keep"] })] });
		await world.engine.handle("SAD-1", { kind: "created" });
		const [planned, applied] = world.journal.all();
		assert.equal(planned!.state, "planned");
		assert.deepEqual([planned!.field, planned!.before, planned!.after], ["labels", ["keep"], ["keep", MARKER]]);
		assert.equal(applied!.state, "applied");
	});
});

describe("a ticket the bot has no business with", () => {
	it("is left alone when it already carries the marker label", async () => {
		const world = rig({ issues: [issueOf("SAD-1", { labels: [MARKER], description: "bare" })] });
		const outcome = await world.engine.handle("SAD-1", { kind: "created" });
		assert.equal(outcome.status, "ignored");
		assert.match(outcome.summary, /already carries triaged-by-bot/);
		assert.deepEqual(world.jira.writes, []);
		assert.equal(world.slack!.posted.length, 0);
		assert.equal(world.record().phase, "done");
	});

	it("is not even read when it belongs to another project", async () => {
		const world = rig();
		world.jira.down = true;
		const outcome = await world.engine.handle("OTHER-5", { kind: "created" });
		assert.equal(outcome.status, "ignored");
		assert.match(outcome.summary, /OTHER is not one of the projects/);
		assert.equal(world.store.get("OTHER-5"), undefined);
	});

	it("is ignored when the key is not a key", async () => {
		const world = rig();
		assert.equal((await world.engine.handle("not a key", { kind: "created" })).status, "ignored");
		assert.equal((await world.engine.handle("SAD-1; drop", { kind: "created" })).status, "ignored");
	});

	it("is ignored when it does not exist or the token may not read it", async () => {
		const world = rig({ issues: [] });
		const outcome = await world.engine.handle("SAD-99", { kind: "created" });
		assert.equal(outcome.status, "ignored");
		assert.match(outcome.summary, /does not exist/);
		assert.equal(world.record("SAD-99").phase, "done");
	});

	it("is ignored the second time its creation arrives", async () => {
		const world = rig({ issues: [thinBug()], developer: false });
		await world.engine.handle("SAD-1", { kind: "created" });
		const again = await world.engine.handle("SAD-1", { kind: "created" });
		assert.equal(again.status, "ignored");
		assert.equal(world.slack!.posted.length, 1, "nobody is asked twice");
	});

	it("is handled once when two deliveries of its creation arrive together", async () => {
		const world = rig({ issues: [thinBug()], developer: false });
		const [first, second] = await Promise.all([world.engine.handle("SAD-1", { kind: "created" }), world.engine.handle("SAD-1", { kind: "created" })]);
		assert.deepEqual([first.status, second.status].sort(), ["asked_reporter", "ignored"]);
		assert.equal(world.slack!.posted.length, 1);
	});

	it("is not triaged a second time for an event key it has seen", async () => {
		const world = rig({ issues: [issueOf("SAD-1", { summary: "Invoice total", description: COMPLETE_TEXT })] });
		await world.engine.handle("SAD-1", { kind: "created" });
		assert.equal((await world.engine.handle("SAD-1", { kind: "updated", changed: ["description"], eventKey: "jira:1:change:5" })).status, "ignored");
		const repeated = await world.engine.handle("SAD-1", { kind: "updated", changed: ["description"], eventKey: "jira:1:change:5" });
		assert.match(repeated.summary, /already handled/);
	});
});

describe("a ticket whose technical context is missing", () => {
	it("goes to the developer agent first, with a read-only request, and nobody is asked and nothing is written yet", async () => {
		const world = rig({ issues: [thinBug()] });
		const outcome = await world.engine.handle("SAD-1", { kind: "created" });
		assert.equal(outcome.status, "asked_developer");
		assert.deepEqual(outcome.missing, ["reproduction-steps", "expected-actual", "environment-version"]);
		assert.equal(world.developer!.asked.length, 1);
		const request = world.developer!.asked[0]!;
		assert.equal(request.ticket, "SAD-1");
		assert.match(request.text, /Read-only investigation request/);
		assert.match(request.text, /Do not start any job/);
		assert.match(request.text, /<<<TICKET-[0-9a-f]{16}[\s\S]*The total is wrong\. Customer Acme AB\./);
		assert.equal(world.slack!.posted.length, 0);
		assert.deepEqual(world.jira.writes, []);
		assert.equal(world.record().phase, "awaiting_developer");
	});

	it("waits for the answer, and folds it into the ticket's own marked section, then asks the reporter for what is still missing", async () => {
		const world = rig({ issues: [thinBug()] });
		await world.engine.handle("SAD-1", { kind: "created" });
		world.advance(20_000);
		assert.equal((await world.engine.tick())[0]?.status, "waiting");
		assert.deepEqual(world.jira.writes, []);
		world.developer!.reply = "The total is computed in the posting module.\nFINDING reproduction-steps: Open the invoice, add two rows and save it.\nFINDING environment-version: Version 2025.11 has it.";
		world.advance(20_000);
		const [outcome] = await world.engine.tick();
		assert.equal(outcome!.status, "asked_reporter");
		assert.equal(outcome!.via, "slack");
		assert.deepEqual(outcome!.missing, ["expected-actual", "environment-version"], "the steps were closed by the developer, the reporter's own environment was not");
		const description = world.ticket().description!;
		assert.ok(description.startsWith("The total is wrong. Customer Acme AB.\n\n"), "the reporter's text is untouched");
		assert.ok(description.includes(NOTES_BEGIN));
		assert.match(readNotes(description) ?? "", /Findings of the developer agent \(read-only investigation\)\* \(2026-10-11 09:00 UTC\)\nThe total is computed in the posting module\./);
		assert.doesNotMatch(readNotes(description) ?? "", /FINDING/, "the machine-readable lines are not kept in the notes");
		assert.equal(world.record().developer?.status, "answered");
		assert.deepEqual(world.record().developer?.findings, { "reproduction-steps": "Open the invoice, add two rows and save it." });
		assert.equal(world.ticket().environment, null, "the developer's finding is not the reporter's environment");
		assert.deepEqual(world.ticket().labels, [MARKER, "needs-info"]);
		assertUntouched(world);
	});

	it("goes on without the developer when no answer comes in time, and asks the reporter for everything", async () => {
		const world = rig({ issues: [thinBug()] });
		await world.engine.handle("SAD-1", { kind: "created" });
		world.advance(11 * MINUTE);
		const [outcome] = await world.engine.tick();
		assert.equal(outcome!.status, "asked_reporter");
		assert.deepEqual(outcome!.missing, ["reproduction-steps", "expected-actual", "environment-version"]);
		assert.equal(world.record().developer?.status, "timed_out");
		assert.equal(world.ticket().description, "The total is wrong. Customer Acme AB.", "no note for a silence");
	});

	it("keeps waiting when the developer's answer cannot be read, and does not give up before the timeout", async () => {
		const world = rig({ issues: [thinBug()] });
		await world.engine.handle("SAD-1", { kind: "created" });
		world.developer!.answerError = new Error("domain unreachable");
		world.advance(30_000);
		assert.equal((await world.engine.tick())[0]?.status, "waiting");
		assert.ok(world.logs.some((log) => log.event === "jira_triage_developer_unreadable"));
	});

	it("goes straight to the reporter when the developer cannot be asked", async () => {
		const world = rig({ issues: [thinBug()] });
		world.developer!.askError = new Error("no such agent");
		const outcome = await world.engine.handle("SAD-1", { kind: "created" });
		assert.equal(outcome.status, "asked_reporter");
		assert.equal(world.record().developer?.status, "unavailable");
		assert.ok(world.logs.some((log) => log.event === "jira_triage_developer_unavailable"));
	});

	it("does not bother the developer when enrichment is off, or there is no developer, or only the reporter can help", async () => {
		const off = rig({ issues: [thinBug()], settings: { enrichment: false } });
		assert.equal((await off.engine.handle("SAD-1", { kind: "created" })).status, "asked_reporter");
		assert.equal(off.developer!.asked.length, 0);
		const none = rig({ issues: [thinBug()], developer: false });
		assert.equal((await none.engine.handle("SAD-1", { kind: "created" })).status, "asked_reporter");
		const story = rig({ issues: [issueOf("SAD-1", { type: "Story", description: "We should have an export." })] });
		assert.equal((await story.engine.handle("SAD-1", { kind: "created" })).status, "asked_reporter");
		assert.equal(story.developer!.asked.length, 0, "a goal and acceptance criteria are not technical");
	});

	it("is not sent to the developer a second time, even after the reporter has been asked", async () => {
		const world = rig({ issues: [thinBug()], settings: { maxRounds: 3 } });
		await world.engine.handle("SAD-1", { kind: "created" });
		world.advance(11 * MINUTE);
		await world.engine.tick();
		world.slack!.answer("D0123ABCD", "U0123ABCD", "Not sure.");
		world.advance(5 * MINUTE);
		await world.engine.tick();
		assert.equal(world.developer!.asked.length, 1);
	});
});

describe("asking the reporter", () => {
	const ask = async (options: Parameters<typeof rig>[0] = {}) => {
		const world = rig({ issues: [thinBug()], developer: false, ...options });
		const outcome = await world.engine.handle("SAD-1", { kind: "created" });
		return { world, outcome };
	};

	it("is a Slack direct message to the person found by the e-mail address Jira holds, with numbered questions", async () => {
		const { world, outcome } = await ask();
		assert.equal(outcome.status, "asked_reporter");
		assert.equal(outcome.via, "slack");
		assert.equal(world.slack!.opened, 1);
		const post = world.slack!.posted[0]!;
		assert.equal(post.channel, "D0123ABCD");
		assert.match(post.text, /^Hi Dana Dev,/);
		assert.match(post.text, /SAD-1: Invoice total\nhttps:\/\/jira\.example\.test\/browse\/SAD-1/);
		assert.match(post.text, /1\. What are the steps to reproduce it/);
		assert.match(post.text, /2\. What did you expect to happen/);
		assert.match(post.text, /3\. Which environment and version/);
		assert.equal(world.ticket().comments.length, 0, "nothing in Jira but the labels");
		assert.deepEqual(world.ticket().labels, [MARKER, "needs-info"]);
		assert.deepEqual(world.record().reporter, { name: "dana", displayName: "Dana Dev", slackUserId: "U0123ABCD", slackChannel: "D0123ABCD" });
		assert.equal(world.record().phase, "awaiting_reporter");
		assertUntouched(world);
	});

	it("reads the address with the user API when the ticket does not carry it (the hub strips it from events, Jira may hide it)", async () => {
		const { world, outcome } = await ask({ issues: [thinBug("SAD-1", { reporter: { name: "dana", displayName: "Dana Dev", active: true } })] });
		assert.equal(outcome.via, "slack");
		assert.equal(world.slack!.posted.length, 1);
	});

	it("falls back to a Jira comment that mentions the reporter when Slack does not know the person", async () => {
		const world = rig({ issues: [thinBug()], developer: false });
		world.slack!.members.clear();
		const outcome = await world.engine.handle("SAD-1", { kind: "created" });
		assert.equal(outcome.via, "jira");
		assert.equal(world.slack!.posted.length, 0);
		const [comment] = world.ticket().comments;
		assert.ok(isBotComment(comment!.body));
		assert.match(comment!.body, /Hi \[~dana\],/);
		assert.match(comment!.body, /1\. What are the steps to reproduce it/);
		assert.deepEqual(world.record().botComments, [comment!.id]);
		assert.equal(world.record().asked?.via, "jira");
	});

	it("falls back to a Jira comment when the Slack call fails, whatever the reason (a missing scope, a closed DM)", async () => {
		for (const failure of ["lookup", "post"] as const) {
			const world = rig({ issues: [thinBug()], developer: false });
			if (failure === "lookup") world.slack!.lookupError = new Error("Slack API error missing_scope");
			else world.slack!.postError = new Error("Slack API error cannot_dm_bot");
			const outcome = await world.engine.handle("SAD-1", { kind: "created" });
			assert.equal(outcome.via, "jira", failure);
			assert.equal(world.ticket().comments.length, 1, failure);
			assert.deepEqual(world.ticket().labels, [MARKER, "needs-info"], failure);
		}
	});

	it("asks in a Jira comment when the agent has no Slack at all", async () => {
		const world = rig({ issues: [thinBug()], developer: false, slack: false });
		assert.equal((await world.engine.handle("SAD-1", { kind: "created" })).via, "jira");
	});

	it("cannot ask a reporter who is gone or unknown: it says what is missing in a plain comment and ends the triage", async () => {
		for (const reporter of [null, { ...dana, active: false }]) {
			const world = rig({ issues: [thinBug("SAD-1", { reporter })], developer: false });
			const outcome = await world.engine.handle("SAD-1", { kind: "created" });
			assert.equal(outcome.status, "unreachable");
			assert.match(world.ticket().comments[0]!.body, /could not be asked directly[\s\S]*steps to reproduce/);
			assert.deepEqual(world.ticket().labels, [MARKER]);
			assert.equal(world.record().phase, "done");
			assert.equal(world.slack!.posted.length, 0);
		}
	});

	it("asks in Swedish when the deployment says so", async () => {
		const { world } = await ask({ settings: { language: "sv" } });
		assert.match(world.slack!.posted[0]!.text, /^Hej Dana Dev,/);
		assert.match(world.slack!.posted[0]!.text, /Hur återskapar man det/);
	});

	it("keeps a needs-info label a person set, and takes away only the one it added", async () => {
		const world = rig({ issues: [thinBug("SAD-1", { labels: ["needs-info"] })], developer: false });
		await world.engine.handle("SAD-1", { kind: "created" });
		assert.deepEqual(world.record().addedLabels, [MARKER]);
		world.slack!.answer("D0123ABCD", "U0123ABCD", "1. open the invoice\n2. save it\nIt should show 250 but shows 200.\nVersion 2025.11");
		world.advance(5 * MINUTE);
		await world.engine.tick();
		assert.deepEqual(world.ticket().labels, ["needs-info", MARKER], "the person's label is theirs");
	});
});

describe("the reporter answers", () => {
	const asked = async (options: Parameters<typeof rig>[0] = {}) => {
		const world = rig({ issues: [thinBug()], developer: false, ...options });
		await world.engine.handle("SAD-1", { kind: "created" });
		return world;
	};
	const FULL = "1. open the invoice\n2. add two rows and save\nIt should show 250 but shows 200.\nVersion 2025.11 in production";

	it("on Slack: the answer goes into the ticket's notes, an empty environment field is filled from it, the ticket is complete and the questions are closed", async () => {
		const world = await asked();
		world.slack!.answer("D0123ABCD", "U0123ABCD", FULL);
		world.advance(5 * MINUTE);
		const [outcome] = await world.engine.tick();
		assert.equal(outcome!.status, "complete");
		assert.match(readNotes(world.ticket().description!) ?? "", /Answer from the reporter \(Slack\)\*[\s\S]*It should show 250 but shows 200/);
		assert.equal(world.ticket().environment, "Version 2025.11 in production");
		assert.deepEqual(world.ticket().labels, [MARKER], "needs-info is gone");
		assert.match(world.slack!.posted.at(-1)!.text, /Thank you, that is what the team needs/);
		const closing = world.ticket().comments.at(-1)!;
		assert.ok(isBotComment(closing.body));
		assert.match(closing.body, /^\{anchor:tb-sad-1-end-1\}\n\[~dana\]\nThank you/);
		assert.equal(world.record().phase, "done");
		assert.equal(world.record().replies.length, 1);
		assert.deepEqual(world.journal.forTicket("SAD-1").filter((record) => record.field === "environment").map((record) => [record.before, record.after, record.state]), [["", "Version 2025.11 in production", "applied"]]);
		assertUntouched(world);
	});

	it("keeps markup out of the environment field it fills, and does not take its own escaping for a person's edit", async () => {
		const world = await asked();
		world.slack!.answer("D0123ABCD", "U0123ABCD", "1. open the invoice\n2. save it\nIt should show 250 but shows 200.\nVersion 2025.11 {code}[~admin]");
		world.advance(5 * MINUTE);
		await world.engine.tick();
		assert.equal(world.ticket().environment, "Version 2025.11 \\{code\\}\\[~admin\\]");
		assert.equal((await world.engine.handle("SAD-1", { kind: "updated", changed: ["environment"] })).status, "ignored");
	});

	it("takes the same answer once, however often the queue looks", async () => {
		const world = await asked();
		world.slack!.answer("D0123ABCD", "U0123ABCD", "Not sure, will check.");
		world.advance(5 * MINUTE);
		await world.engine.tick();
		world.advance(5 * MINUTE);
		await world.engine.tick();
		assert.equal(world.record().replies.length, 1);
	});

	it("asks again for what is still missing, and ends with a summary after the last round", async () => {
		const world = await asked();
		world.slack!.answer("D0123ABCD", "U0123ABCD", "1. open the invoice\n2. save it");
		world.advance(5 * MINUTE);
		const [second] = await world.engine.tick();
		assert.equal(second!.status, "asked_reporter");
		assert.deepEqual(second!.missing, ["expected-actual", "environment-version"]);
		assert.equal(world.record().rounds, 2);
		assert.equal(world.slack!.posted.length, 2);
		assert.match(world.slack!.posted[1]!.text, /1\. What did you expect to happen/);
		world.slack!.answer("D0123ABCD", "U0123ABCD", "I do not know.");
		world.advance(5 * MINUTE);
		const [last] = await world.engine.tick();
		assert.equal(last!.status, "incomplete");
		assert.match(world.ticket().comments.at(-1)!.body, /Some points are still open[\s\S]*expected versus actual result[\s\S]*environment and version/);
		assert.match(world.slack!.posted.at(-1)!.text, /Some points are still open/);
		assert.equal(world.record().phase, "done");
		assert.deepEqual(world.ticket().labels, [MARKER]);
	});

	it("in Jira: a comment of the reporter's counts, one of somebody else's or of the bot's does not", async () => {
		const world = await asked({ slack: false });
		const question = world.ticket().comments[0]!;
		assert.ok(isBotComment(question.body));
		const bystander = world.jira.say("SAD-1", { name: "erik", displayName: "Erik" }, FULL);
		assert.equal((await world.engine.handle("SAD-1", { kind: "comment", commentId: bystander.id, author: "erik", excerpt: FULL })).status, "ignored");
		assert.equal((await world.engine.handle("SAD-1", { kind: "comment", commentId: question.id, author: "dana", excerpt: question.body })).status, "ignored");
		assert.equal((await world.engine.handle("SAD-1", { kind: "comment", commentId: question.id, author: "dana", excerpt: "no anchor shown" })).status, "ignored", "known by its id");
		assert.equal(world.record().phase, "awaiting_reporter");
		const reply = world.jira.say("SAD-1", dana, FULL);
		const outcome = await world.engine.handle("SAD-1", { kind: "comment", commentId: reply.id, author: "dana", excerpt: FULL });
		assert.equal(outcome.status, "complete");
		assert.match(readNotes(world.ticket().description!) ?? "", /Answer from the reporter \(Jira\)/);
	});

	it("in Jira: found by the queue too, without the event", async () => {
		const world = await asked({ slack: false });
		world.jira.say("SAD-1", dana, FULL);
		world.advance(5 * MINUTE);
		assert.equal((await world.engine.tick())[0]?.status, "complete");
	});

	it("a comment on a ticket nobody was asked about is ignored", async () => {
		const world = rig({ issues: [issueOf("SAD-1", { summary: "Invoice total", description: COMPLETE_TEXT })] });
		await world.engine.handle("SAD-1", { kind: "created" });
		assert.equal((await world.engine.handle("SAD-1", { kind: "comment", commentId: "5", author: "dana" })).status, "ignored");
		assert.equal((await world.engine.handle("SAD-77", { kind: "comment", commentId: "5", author: "dana" })).status, "ignored");
	});

	it("never counts an answer that came from somebody else in the direct message", async () => {
		const world = await asked();
		world.slack!.answer("D0123ABCD", "U9999ZZZZ", FULL);
		world.advance(5 * MINUTE);
		assert.equal((await world.engine.tick())[0]?.status, "waiting");
	});

	it("is waited for until the deadline, then the triage ends with a comment and the label, and nothing nags again", async () => {
		const world = await asked();
		world.advance(6 * MINUTE);
		assert.equal((await world.engine.tick())[0]?.status, "waiting");
		world.advance(48 * HOUR);
		const [outcome] = await world.engine.tick();
		assert.equal(outcome!.status, "no_answer");
		assert.match(world.ticket().comments.at(-1)!.body, /No answer came in[\s\S]*steps to reproduce/);
		assert.deepEqual(world.ticket().labels, [MARKER]);
		assert.equal(world.record().phase, "done");
		world.advance(HOUR);
		assert.deepEqual(await world.engine.tick(), [], "finished: nothing more is due");
	});

	it("keeps waiting when Slack cannot be read for a moment", async () => {
		const world = await asked();
		world.slack!.repliesError = new Error("Slack API error ratelimited");
		world.advance(5 * MINUTE);
		assert.equal((await world.engine.tick())[0]?.status, "waiting");
		assert.ok(world.logs.some((log) => log.event === "jira_triage_slack_unreadable"));
	});
});

describe("when the ticket system is down or flaky", () => {
	it("does not lose the event: the ticket is kept, tried again with a growing pause, and done when Jira is back", async () => {
		const world = rig({ issues: [thinBug()], developer: false });
		world.jira.down = true;
		const first = await world.engine.handle("SAD-1", { kind: "created" });
		assert.equal(first.status, "retry");
		assert.match(first.summary, /did not answer[\s\S]*trying again in 2 minutes/);
		assert.equal(world.record().phase, "queued");
		assert.equal(world.record().attempts, 1);
		assert.equal(world.record().nextAttemptAt, world.now() + 2 * MINUTE);
		assert.deepEqual(await world.engine.tick(), [], "not yet");
		world.advance(2 * MINUTE);
		assert.equal((await world.engine.tick())[0]?.status, "retry");
		assert.equal(world.record().nextAttemptAt, world.now() + 5 * MINUTE, "longer the second time");
		world.jira.down = false;
		world.advance(5 * MINUTE);
		const [done] = await world.engine.tick();
		assert.equal(done!.status, "asked_reporter");
		assert.equal(world.record().attempts, 0);
		assert.equal(world.slack!.posted.length, 1);
	});

	it("keeps the last pause of the schedule when it runs out, and gives up after the allowed passes, telling the owner", async () => {
		const world = rig({ issues: [thinBug()], settings: { maxAttempts: 5, retrySchedule: [MINUTE, 3 * MINUTE] } });
		world.jira.down = true;
		await world.engine.handle("SAD-1", { kind: "created" });
		const pauses: number[] = [world.record().nextAttemptAt! - world.now()];
		for (let pass = 0; pass < 3; pass++) {
			world.advance(world.record().nextAttemptAt! - world.now());
			await world.engine.tick();
			pauses.push(world.record().nextAttemptAt! - world.now());
		}
		assert.deepEqual(pauses, [MINUTE, 3 * MINUTE, 3 * MINUTE, 3 * MINUTE]);
		world.advance(3 * MINUTE);
		const [outcome] = await world.engine.tick();
		assert.equal(outcome!.status, "gave_up");
		assert.equal(world.record().phase, "gave_up");
		assert.equal(world.record().nextAttemptAt, undefined);
		assert.equal(world.notices.length, 1);
		assert.match(world.notices[0]!, /gave up on SAD-1 after 5 failed passes/);
		world.advance(HOUR);
		assert.deepEqual(await world.engine.tick(), []);
	});

	it("can be asked to try a given-up ticket again", async () => {
		const world = rig({ issues: [thinBug()], developer: false, settings: { maxAttempts: 1 } });
		world.jira.down = true;
		assert.equal((await world.engine.handle("SAD-1", { kind: "created" })).status, "gave_up");
		world.jira.down = false;
		assert.equal((await world.engine.handle("SAD-1", { kind: "manual", force: true })).status, "asked_reporter");
	});

	it("survives an answer of 503 on a read, and an answer that never comes", async () => {
		const world = rig({ issues: [thinBug()], developer: false });
		world.jira.failNext = 1;
		assert.equal((await world.engine.handle("SAD-1", { kind: "created" })).status, "retry");
		world.advance(2 * MINUTE);
		assert.equal((await world.engine.tick())[0]?.status, "asked_reporter");
	});

	it("never asks twice when a write fails after the question was sent: the write is made again, the question is not", async () => {
		const world = rig({ issues: [thinBug()], developer: false });
		world.jira.failWrite = "labels";
		const first = await world.engine.handle("SAD-1", { kind: "created" });
		assert.equal(first.status, "retry");
		assert.equal(world.slack!.posted.length, 1, "the question went out");
		assert.deepEqual(world.ticket().labels, []);
		assert.equal(world.record().phase, "awaiting_reporter");
		assert.deepEqual(world.record().pending?.labels?.add, [MARKER, "needs-info"]);
		world.advance(2 * MINUTE);
		const [outcome] = await world.engine.tick();
		assert.equal(outcome!.status, "waiting");
		assert.deepEqual(world.ticket().labels, [MARKER, "needs-info"]);
		assert.equal(world.slack!.posted.length, 1);
		assert.equal(world.record().pending, undefined);
		assert.deepEqual(world.journal.forTicket("SAD-1").map((record) => record.state), ["failed", "applied"]);
	});

	it("writes a comment once even when the first try was lost after it was sent", async () => {
		const world = rig({ issues: [thinBug()], developer: false, slack: false });
		world.jira.loseCommentAnswer = true;
		assert.equal((await world.engine.handle("SAD-1", { kind: "created" })).status, "retry");
		assert.equal(world.ticket().comments.length, 1, "the comment was made although the answer was lost");
		world.advance(2 * MINUTE);
		assert.equal((await world.engine.tick())[0]?.status, "waiting");
		assert.equal(world.ticket().comments.length, 1, "found by its token, not written again");
		assert.equal(world.record().botComments.length, 1);
	});

	it("also remembers a failed write of notes and tries them again", async () => {
		const world = rig({ issues: [thinBug()] });
		await world.engine.handle("SAD-1", { kind: "created" });
		world.developer!.reply = "It is in the posting module.";
		world.jira.failWrite = "fields";
		world.advance(20_000);
		assert.equal((await world.engine.tick())[0]?.status, "retry");
		assert.equal(world.ticket().description, "The total is wrong. Customer Acme AB.");
		world.advance(2 * MINUTE);
		assert.equal((await world.engine.tick())[0]?.status, "asked_reporter");
		assert.match(readNotes(world.ticket().description!) ?? "", /posting module/);
		assert.equal((world.ticket().description!.match(/posting module/g) ?? []).length, 1);
	});

	it("does not lose an answer when the write of its notes fails: the next pass judges the ticket with it, it does not go back to waiting", async () => {
		const world = rig({ issues: [thinBug()], developer: false });
		await world.engine.handle("SAD-1", { kind: "created" });
		world.slack!.answer("D0123ABCD", "U0123ABCD", "1. open the invoice\n2. save it\nIt should show 250 but shows 200.\nVersion 2025.11");
		world.jira.failWrite = "fields";
		world.advance(5 * MINUTE);
		assert.equal((await world.engine.tick())[0]?.status, "retry");
		assert.equal(world.record().replies.length, 1);
		world.advance(2 * MINUTE);
		assert.equal((await world.engine.tick())[0]?.status, "complete");
		assert.equal(world.record().phase, "done");
		assert.deepEqual(world.ticket().labels, [MARKER]);
		assert.match(readNotes(world.ticket().description!) ?? "", /Answer from the reporter \(Slack\)/);
	});

	it("keeps a Jira failure while looking for the reporter's address a failed pass: the question still goes to Slack when Jira is back", async () => {
		const world = rig({ issues: [thinBug("SAD-1", { reporter: { name: "dana", displayName: "Dana Dev", active: true } })], developer: false });
		world.jira.beforeCall = (method) => {
			if (method === "user" && world.record().attempts === 0) throw new JiraError(503, "GET user answered 503");
		};
		const first = await world.engine.handle("SAD-1", { kind: "created" });
		assert.equal(first.status, "retry");
		assert.equal(world.slack!.posted.length, 0);
		assert.deepEqual(world.ticket().comments, [], "no comment in Jira as a second choice");
		world.advance(2 * MINUTE);
		const [second] = await world.engine.tick();
		assert.equal(second!.via, "slack");
		assert.equal(world.ticket().comments.length, 0);
	});

	it("revives tickets that were in the middle of a pass when the agent stopped", () => {
		const world = rig({ issues: [thinBug()] });
		world.store.put({ id: "SAD-1", phase: "queued", origin: "event", createdAt: 1, updatedAt: 1, attempts: 0, rounds: 0, replies: [], botComments: [], addedLabels: [] }, 1);
		assert.equal(world.build().recover(), 1);
		assert.equal(world.record().nextAttemptAt, world.now());
	});
});

describe("a ticket a person edits after the triage", () => {
	const triaged = async (options: Parameters<typeof rig>[0] = {}) => {
		const world = rig({ issues: [issueOf("SAD-1", { summary: "Invoice total", description: COMPLETE_TEXT })], developer: false, ...options });
		await world.engine.handle("SAD-1", { kind: "created" });
		return world;
	};

	it("is not judged again for the bot's own writes: its label, its section of the description, its comments", async () => {
		const world = await triaged({ issues: [thinBug()] });
		world.slack!.answer("D0123ABCD", "U0123ABCD", "1. open it\n2. save it\nIt should show 250 but shows 200.\nVersion 2025.11");
		world.advance(5 * MINUTE);
		await world.engine.tick();
		assert.equal(world.record().phase, "done");
		const writes = world.jira.writes.length;
		assert.equal((await world.engine.handle("SAD-1", { kind: "updated", changed: ["description", "labels", "environment"], eventKey: "e1" })).status, "ignored");
		assert.equal(world.jira.writes.length, writes);
		assert.equal(world.slack!.posted.length, 2, "asked once, and thanked");
	});

	it("is not lost when the ticket system is down at the moment the edit is reported: it is looked at again later", async () => {
		const world = await triaged();
		world.ticket().description = "The total is wrong again. Customer Acme.";
		world.jira.down = true;
		assert.equal((await world.engine.handle("SAD-1", { kind: "updated", changed: ["description"] })).status, "retry");
		assert.equal(world.record().recheck, true);
		world.jira.down = false;
		world.advance(2 * MINUTE);
		assert.equal((await world.engine.tick())[0]?.status, "asked_reporter");
		assert.equal(world.record().recheck, undefined);
	});

	it("is ignored when only labels or the like changed, without even reading the ticket", async () => {
		const world = await triaged();
		world.jira.down = true;
		assert.equal((await world.engine.handle("SAD-1", { kind: "updated", changed: ["labels"] })).status, "ignored");
		assert.equal((await world.engine.handle("SAD-1", { kind: "updated", changed: ["labels", "comment", "Fix Version"] })).status, "ignored");
	});

	it("is ignored when it was never triaged by this agent, whatever changed", async () => {
		const world = rig();
		world.jira.down = true;
		assert.equal((await world.engine.handle("SAD-1", { kind: "updated", changed: ["description"] })).status, "ignored");
	});

	it("is judged again when a person changed a field the checklist reads, even though it carries the marker and even though the bot's token made the edit", async () => {
		const world = await triaged();
		assert.equal(world.record().phase, "done");
		world.ticket().description = "The total is wrong again. Customer Acme.";
		const outcome = await world.engine.handle("SAD-1", { kind: "updated", changed: ["description"], eventKey: "e2" });
		assert.equal(outcome.status, "asked_reporter");
		assert.deepEqual(world.ticket().labels, [MARKER, "needs-info"]);
		assert.equal(world.record().rounds, 1);
		assert.ok(world.record().retriage);
	});

	it("ends complete, with no question, when the person's edit completed the ticket", async () => {
		const world = await triaged({ issues: [thinBug()] });
		assert.equal(world.record().phase, "awaiting_reporter");
		world.ticket().description = COMPLETE_TEXT;
		const outcome = await world.engine.handle("SAD-1", { kind: "updated", changed: ["description"] });
		assert.equal(outcome.status, "complete");
		assert.deepEqual(world.ticket().labels, [MARKER]);
		assert.equal(world.slack!.posted.length, 2, "the question, and the thanks");
	});

	it("waits for the developer agent before it looks at an edit made while that agent is working", async () => {
		const world = rig({ issues: [thinBug()] });
		await world.engine.handle("SAD-1", { kind: "created" });
		world.ticket().description = "The total is wrong. Customer Acme AB. More words.";
		assert.equal((await world.engine.handle("SAD-1", { kind: "updated", changed: ["description"] })).status, "waiting");
		assert.equal(world.record().phase, "awaiting_developer");
	});

	it("is left alone when a person asks for it by hand and it was triaged, unless they say force", async () => {
		const world = await triaged();
		assert.equal((await world.engine.handle("SAD-1", { kind: "manual" })).status, "ignored");
		assert.equal((await world.engine.handle("SAD-1", { kind: "manual", force: true })).status, "complete");
		assert.equal(world.record().origin, "manual");
	});

	it("can be triaged by hand although it was never seen, but a ticket that carries the marker only with force", async () => {
		const world = rig({ issues: [thinBug("SAD-1", { labels: [MARKER] }), thinBug("SAD-2")], developer: false });
		assert.equal((await world.engine.handle("SAD-2", { kind: "manual" })).status, "asked_reporter");
		assert.equal((await world.engine.handle("SAD-1", { kind: "manual", force: true })).status, "asked_reporter");
	});
});

describe("a dry run", () => {
	it("judges and records, and writes nothing, asks nobody and messages nobody", async () => {
		const world = rig({ issues: [thinBug()], settings: { dryRun: true } });
		const outcome = await world.engine.handle("SAD-1", { kind: "created" });
		assert.equal(outcome.status, "dry_run");
		assert.match(outcome.summary, /dry run: missing reproduction-steps, expected-actual, environment-version; nobody was asked and nothing was written/);
		assert.deepEqual(world.jira.writes, []);
		assert.equal(world.slack!.posted.length, 0);
		assert.equal(world.developer!.asked.length, 0);
		assert.equal(world.record().phase, "done");
		const complete = rig({ issues: [issueOf("SAD-1", { summary: "Invoice total", description: COMPLETE_TEXT })], settings: { dryRun: true } });
		assert.match((await complete.engine.handle("SAD-1", { kind: "created" })).summary, /the ticket is complete, nothing was written/);
	});
});

describe("what the agent may say about itself", () => {
	it("counts its queue and lists the recent triages, and says when it is a dry run", async () => {
		const world = rig({ issues: [thinBug(), issueOf("SAD-2", { summary: "Invoice total", description: COMPLETE_TEXT })], developer: false });
		await world.engine.handle("SAD-1", { kind: "created" });
		await world.engine.handle("SAD-2", { kind: "created" });
		const facts = world.engine.facts();
		assert.match(facts, /0 waiting for a pass, 0 waiting for the developer agent, 1 waiting for a reporter; 1 finished, 0 given up/);
		assert.match(facts, /Projects: SAD\. Marker label: triaged-by-bot\./);
		assert.match(facts, /- SAD-2: complete: it has what the checklist asks for/);
		assert.match(facts, /Changes recorded for revert by hand: 2/);
		assert.doesNotMatch(facts, /DRY RUN/);
		assert.match(rig({ settings: { dryRun: true } }).engine.facts(), /DRY RUN/);
	});
});

describe("what a bot that acts in somebody's name must never do", () => {
	it("leaves the assignee, the status and the reporter alone in every flow, and writes only labels, text fields and comments", async () => {
		const world = rig({ issues: [thinBug("SAD-1", { assignee: { name: "erik" }, status: "In Progress" })] });
		await world.engine.handle("SAD-1", { kind: "created" });
		world.developer!.reply = "Notes.\nFINDING reproduction-steps: Open the invoice and save it twice.";
		world.advance(20_000);
		await world.engine.tick();
		world.slack!.answer("D0123ABCD", "U0123ABCD", "It should show 250 but shows 200. Version 2025.11");
		world.advance(5 * MINUTE);
		await world.engine.tick();
		assert.equal(world.record().phase, "done");
		assert.equal(world.ticket().assignee?.name, "erik");
		assert.equal(world.ticket().status, "In Progress");
		assert.equal(world.ticket().reporter?.name, "dana");
		assert.ok(world.jira.writes.every((write) => ["labels", "fields", "comment"].includes(write.op)));
		assert.deepEqual(world.journal.all().filter((record) => !["description", "labels", "environment"].includes(record.field)), []);
	});
});

describe("jira errors that are not an outage", () => {
	it("are retried, not hidden, and the ticket says what went wrong", async () => {
		const world = rig({ issues: [thinBug()], developer: false });
		world.jira.beforeCall = (method) => {
			if (method === "getIssue") throw new JiraError(403, "GET issue answered 403: no permission");
		};
		const outcome = await world.engine.handle("SAD-1", { kind: "created" });
		assert.equal(outcome.status, "retry");
		assert.match(outcome.summary, /a step failed/);
		assert.match(world.record().lastError ?? "", /403/);
	});

	it("keeps the bot's own comment out of the answers even when the reporter is the owner of the token", async () => {
		const world = rig({ issues: [thinBug("SAD-1", { reporter: { ...BOT, emailAddress: "bot@example.test" } })], developer: false, slack: false });
		await world.engine.handle("SAD-1", { kind: "created" });
		world.advance(5 * MINUTE);
		assert.equal((await world.engine.tick())[0]?.status, "waiting", "its own question is not an answer");
	});
});

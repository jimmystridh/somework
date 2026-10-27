import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { HandlerStore, handlersDir, silent } from "@somework/agent-kit";
import card from "../card.json" with { type: "json" };
import { qaChat } from "../src/chat.ts";
import { qaProfile } from "../src/profile.ts";
import { HANDLER, loadQaEventSettings, renderHandler, seedHandler, TOPICS } from "../src/seed.ts";

const T0 = "2026-10-06T09:00:00.000Z";
const TRANSITIONED = JSON.parse(readFileSync(new URL("../../../rules/samples/jira.issue.transitioned.json", import.meta.url), "utf8"));

/** The shipped handler, rendered with the settings and run the way the sandbox runs it: one directory, state in a file next to it. */
async function agent(env: Record<string, string> = {}) {
	const settings = loadQaEventSettings(env);
	const root = mkdtempSync(join(tmpdir(), "qa-handler-"));
	mkdirSync(join(root, ".somework-events"));
	const file = join(root, ".somework-events", `h-${Math.random().toString(36).slice(2)}.mjs`);
	writeFileSync(file, renderHandler(settings));
	const module = await import(pathToFileURL(file).href);
	let n = 0;
	const decide = (data: Record<string, unknown> | null = {}, options: { key?: string; now?: string } = {}) =>
		module.default({ event: { id: `evt_${++n}`, seq: n, topic: "jira.issue.transitioned", source: "jira", key: options.key ?? `${TRANSITIONED.key}:${n}`, data: data === null ? null : { ...TRANSITIONED.data, ...data }, classification: "internal", verified: true, depth: 0, untrusted: true }, agent: {}, now: options.now ?? T0 }, {});
	return { decide, settings };
}

describe("the shipped ticket handler", () => {
	it("turns a ticket moving into Test into one qa.verify job for this agent, with the old reaction's input", async () => {
		const { decide, settings } = await agent();
		const decision = await decide();
		assert.equal(decision.action, "submit");
		assert.deepEqual(decision.task.capability, { id: "qa.verify", version: "1" });
		assert.deepEqual(decision.task.input, { ticket: "PROJ-123", app: "local", repository: { url: "https://github.com/example-org/example-repo.git", ref: "refs/heads/feature/PROJ-123-rounding" } });
		assert.deepEqual(decision.task.budget, { maxTokens: 4_000_000, maxMinutes: 180 });
		assert.deepEqual(decision.task.budget, settings.budget);
		assert.doesNotMatch(JSON.stringify(decision.task), /Rounding differs|j\.doe/, "no summary or actor name is copied");
	});

	it("serves a capability the card declares and the profile offers", () => {
		assert.ok(card.capabilities.some((capability) => capability.id === "qa.verify" && capability.version === "1"));
		assert.ok(qaProfile().capabilities.some((capability) => capability.id === "qa.verify" && capability.version === "1"));
	});

	it("starts its jobs on the application stack, so that several tickets wait for each other in the service", () => {
		assert.deepEqual(qaChat().jobResources!("qa.verify", { ticket: "PROJ-123" }), ["app-stack"]);
	});

	it("ignores a move into any other status, and a move into the status the deployment calls Test", async () => {
		const other = await (await agent()).decide({ to: "Done" });
		assert.equal(other.action, "drop");
		assert.match(other.reason, /did not move into Test/);
		assert.equal((await (await agent({ JIRA_TEST_STATUS: "Ready for QA" })).decide()).action, "drop");
		assert.equal((await (await agent({ JIRA_TEST_STATUS: "Ready for QA" })).decide({ to: "Ready for QA" })).action, "submit");
	});

	it("hands an event without a ticket this agent handles to a person instead of guessing", async () => {
		const { decide } = await agent();
		for (const issue of [undefined, {}, { key: "" }, { key: "proj-1" }, { key: "PROJ-1 and more" }, { key: 7 }]) {
			const decision = await decide({ issue });
			assert.equal(decision.action, "deliver", JSON.stringify(issue));
			assert.match(decision.reason, /no ticket key this agent handles/);
		}
		assert.equal((await decide(null)).action, "drop", "no target status at all is not a move into Test");
		const strict = await agent({ QA_TICKET_PATTERN: "^QA-[0-9]+$" });
		assert.equal((await strict.decide()).action, "deliver");
		assert.equal((await strict.decide({ issue: { key: "QA-5" } })).action, "submit");
	});

	it("falls back to the configured repository when the event names none, and to HEAD when its ref is unusable", async () => {
		const { decide } = await agent({ CHAT_REPOSITORY_URL: "https://github.com/acme/app.git", QA_EVENT_APP: "shop" });
		const bare = await decide({ repository: undefined });
		assert.deepEqual(bare.task.input.repository, { url: "https://github.com/acme/app.git", ref: "HEAD" });
		assert.equal(bare.task.input.app, "shop");
		assert.equal((await decide({ repository: { cloneUrl: "https://github.com/a/b.git", ref: "../../etc" } })).task.input.repository.ref, "HEAD");
		const none = await (await agent()).decide({ repository: undefined });
		assert.equal(none.action, "deliver");
		assert.match(none.reason, /no https clone address/);
		assert.equal((await (await agent()).decide({ repository: { cloneUrl: "ssh://git@host/r.git" } })).action, "deliver");
	});

	it("handles a delivery once and stops at the daily cap, which is a note for a person", async () => {
		const { decide } = await agent({ QA_EVENT_CAP_PER_DAY: "2" });
		assert.equal((await decide({}, { key: "jira:1" })).action, "submit");
		const again = await decide({}, { key: "jira:1" });
		assert.equal(again.action, "drop");
		assert.match(again.reason, /already handled/);
		assert.equal((await decide({}, { key: "jira:2" })).action, "submit");
		const third = await decide({}, { key: "jira:3" });
		assert.equal(third.action, "deliver");
		assert.match(third.reason, /daily cap of 2/);
		assert.equal((await decide({}, { key: "jira:3" })).action, "deliver", "a refused event is not remembered as handled");
		assert.equal((await decide({}, { key: "jira:3", now: "2026-10-07T09:00:00.000Z" })).action, "submit");
	});
});

describe("the shipped ticket handler and the labels", () => {
	/** The same handler fed a label change: the hub carries the label lists before and after a change. */
	async function labelled(env: Record<string, string> = {}) {
		const settings = loadQaEventSettings(env);
		const root = mkdtempSync(join(tmpdir(), "qa-handler-labels-"));
		mkdirSync(join(root, ".somework-events"));
		const file = join(root, ".somework-events", `h-${Math.random().toString(36).slice(2)}.mjs`);
		writeFileSync(file, renderHandler(settings));
		const module = await import(pathToFileURL(file).href);
		let n = 0;
		return (labels: { from: string; to: string } | undefined, options: { key?: string } = {}) =>
			module.default({ event: { id: `evt_${++n}`, seq: n, topic: "jira.issue.updated", source: "jira", key: options.key ?? `jira:1:change:${n}`, data: { issue: TRANSITIONED.data.issue, changed: ["labels"], actor: "j.doe", repository: TRANSITIONED.data.repository, ...(labels ? { labels } : {}) }, classification: "internal", verified: true, depth: 0, untrusted: true }, agent: {}, now: T0 }, {});
	}

	it("starts a verification when the request label is added, with the same job as a move into Test", async () => {
		const decide = await labelled();
		const decision = await decide({ from: "vat", to: "vat qa-verify" });
		assert.equal(decision.action, "submit");
		assert.deepEqual(decision.task.capability, { id: "qa.verify", version: "1" });
		assert.equal(decision.task.input.ticket, "PROJ-123");
		assert.match(decision.reason, /qa-verify was added/);
	});

	it("takes the label in any case, and ignores a label that was already there, one that was taken away and every other change", async () => {
		const decide = await labelled();
		assert.equal((await decide({ from: "", to: "QA-Verify" })).action, "submit");
		assert.equal((await decide({ from: "qa-verify vat", to: "qa-verify vat extra" })).action, "drop", "it was there before");
		assert.equal((await decide({ from: "qa-verify vat", to: "vat" })).action, "drop", "the agent's own clean-up, or a person taking it away");
		assert.equal((await decide({ from: "a", to: "a b" })).action, "drop");
		assert.equal((await decide(undefined)).action, "drop", "an update that is not a label change");
	});

	it("does not start one for a ticket that now carries the skip label, and follows the names the deployment chose", async () => {
		const decide = await labelled();
		const skipped = await decide({ from: "no-qa", to: "no-qa qa-verify" });
		assert.equal(skipped.action, "drop");
		assert.match(skipped.reason, /carries no-qa/);
		const renamed = await labelled({ JIRA_QA_REQUEST_LABEL: "please-test", JIRA_QA_SKIP_LABEL: "manual-only" });
		assert.equal((await renamed({ from: "", to: "please-test" })).action, "submit");
		assert.equal((await renamed({ from: "", to: "qa-verify" })).action, "drop");
		assert.equal((await renamed({ from: "manual-only", to: "manual-only please-test" })).action, "drop");
	});

	it("handles a delivery once, and still starts a verification for a move into Test", async () => {
		const decide = await labelled();
		assert.equal((await decide({ from: "", to: "qa-verify" }, { key: "jira:9" })).action, "submit");
		assert.equal((await decide({ from: "", to: "qa-verify" }, { key: "jira:9" })).action, "drop");
		assert.equal((await (await agent()).decide()).action, "submit");
	});
});

describe("seeding the handler", () => {
	const dir = () => mkdtempSync(join(tmpdir(), "qa-seed-"));

	it("installs the rendered handler on the first start for the Jira topic, and leaves the live copy alone afterwards", () => {
		const stateDir = dir();
		assert.deepEqual(seedHandler({ stateDir, settings: loadQaEventSettings({ QA_EVENT_CAP_PER_DAY: "7", JIRA_TEST_STATUS: "In Test" }), log: silent }), { seeded: true, version: 1 });
		const store = new HandlerStore(handlersDir(stateDir));
		assert.match(store.current(HANDLER)!.source, /"submitCapPerDay": 7/);
		assert.match(store.current(HANDLER)!.source, /"testStatus": "In Test"/);
		assert.deepEqual(store.current(HANDLER)!.topics, TOPICS);
		assert.deepEqual(TOPICS, ["jira.issue.transitioned", "jira.issue.updated"]);
		assert.match(store.current(HANDLER)!.source, /"requestLabel": "qa-verify"/);
		assert.match(store.current(HANDLER)!.source, /"skipLabel": "no-qa"/);
		assert.deepEqual(seedHandler({ stateDir, settings: loadQaEventSettings({ QA_EVENT_CAP_PER_DAY: "9" }), log: silent }), { seeded: false, version: 1 });
		assert.match(store.current(HANDLER)!.source, /"submitCapPerDay": 7/);
	});

	it("writes a new version when asked to reseed, keeping the earlier one", () => {
		const stateDir = dir();
		seedHandler({ stateDir, settings: loadQaEventSettings({}), log: silent });
		assert.deepEqual(seedHandler({ stateDir, settings: loadQaEventSettings({ QA_EVENT_CAP_PER_DAY: "9" }), log: silent, reseed: true }), { seeded: true, version: 2 });
		assert.match(new HandlerStore(handlersDir(stateDir)).current(HANDLER)!.source, /"submitCapPerDay": 9/);
	});

	it("refuses a template without the placeholder and a setting that is not a whole number", () => {
		assert.throws(() => renderHandler(loadQaEventSettings({}), "export default () => 1"), /no __CONFIG__ placeholder/);
		assert.throws(() => loadQaEventSettings({ QA_EVENT_CAP_PER_DAY: "0" }), /QA_EVENT_CAP_PER_DAY must be a positive whole number/);
	});

	it("has events on in the profile, with a budget cap that covers a verification", () => {
		assert.equal(qaProfile().events?.enabled, true);
		assert.deepEqual(qaProfile().events?.submitBudgetCap, { maxTokens: 4_000_000, maxMinutes: 180 });
	});
});

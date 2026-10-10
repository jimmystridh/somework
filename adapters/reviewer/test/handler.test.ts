import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { HandlerStore, handlersDir, silent } from "@somework/agent-kit";
import card from "../card.json" with { type: "json" };
import { profile } from "../src/profile.ts";
import { HANDLER, loadReviewEventSettings, renderHandler, seedHandler, TOPICS } from "../src/seed.ts";

const T0 = "2026-10-06T09:00:00.000Z";
const sample = (name: string) => JSON.parse(readFileSync(new URL(`../../../rules/samples/${name}.json`, import.meta.url), "utf8"));
const OPENED = sample("github.pull_request.opened");
const READY = sample("github.pull_request.ready_for_review");

/** The shipped handler, rendered with the settings and run the way the sandbox runs it: one directory, state in a file next to it. */
async function agent(env: Record<string, string> = {}) {
	const settings = loadReviewEventSettings(env);
	const root = mkdtempSync(join(tmpdir(), "review-handler-"));
	mkdirSync(join(root, ".somework-events"));
	const file = join(root, ".somework-events", `h-${Math.random().toString(36).slice(2)}.mjs`);
	writeFileSync(file, renderHandler(settings));
	const module = await import(pathToFileURL(file).href);
	let n = 0;
	const decide = (sampleEvent: { topic: string; key: string; data: unknown }, data: Record<string, unknown> = {}, now = T0) =>
		module.default({ event: { id: `evt_${++n}`, seq: n, topic: sampleEvent.topic, source: "github", key: sampleEvent.key, data: sampleEvent.data === null ? null : { ...(sampleEvent.data as object), ...data }, classification: "internal", verified: true, depth: 0, untrusted: true }, agent: {}, now }, {});
	return { decide, settings };
}

describe("the shipped pull request handler", () => {
	it("turns an opened pull request into one code.review job for this agent, carrying only the clone address, the number and the pull request ref", async () => {
		const { decide, settings } = await agent();
		const decision = await decide(OPENED);
		assert.equal(decision.action, "submit");
		assert.deepEqual(decision.task.capability, { id: "code.review", version: "3" });
		assert.deepEqual(decision.task.input, { repository: { url: "https://github.com/example-org/example-repo.git", ref: "refs/pull/42/head" }, pullRequest: 42 });
		assert.deepEqual(decision.task.budget, { maxTokens: 200_000, maxMinutes: 20 });
		assert.deepEqual(decision.task.budget, settings.budget);
		assert.doesNotMatch(JSON.stringify(decision.task), /Fix rounding|octocat|PROJ-123/, "no title, author or branch name is copied");
	});

	it("serves a capability the card declares, with an input its schema accepts", () => {
		assert.ok(card.capabilities.some((capability) => capability.id === "code.review" && capability.version === "3"));
		assert.ok(card.capabilities[0]!.inputSchema.required.includes("repository"));
		assert.ok(profile.capabilities.some((capability) => capability.id === "code.review" && capability.version === "3"));
	});

	it("reviews a draft only when it is marked ready, and a head commit once however many events announce it", async () => {
		const { decide } = await agent();
		const draft = await decide(OPENED, { draft: true });
		assert.equal(draft.action, "drop");
		assert.match(draft.reason, /draft/);
		assert.equal((await decide(READY)).action, "submit");
		const again = await decide(OPENED);
		assert.equal(again.action, "drop");
		assert.match(again.reason, /already reviewed/);
	});

	it("reviews a pull request again when it has a new head commit", async () => {
		const { decide } = await agent();
		assert.equal((await decide(OPENED)).action, "submit");
		assert.equal((await decide(READY, { headSha: "fedcba9876543210fedcba9876543210fedcba98" })).action, "submit");
	});

	it("hands an event without a usable pull request to a person instead of guessing", async () => {
		const { decide } = await agent();
		for (const data of [{ number: undefined }, { number: 0 }, { number: "42" }, { repository: {} }, { repository: { cloneUrl: "http://example.test/r.git" } }, { repository: { cloneUrl: "git@github.com:a/b.git" } }]) {
			const decision = await decide(OPENED, data);
			assert.equal(decision.action, "deliver", JSON.stringify(data));
			assert.match(decision.reason, /no usable pull request number/);
		}
		assert.equal((await decide({ ...OPENED, data: null })).action, "drop", "no draft flag at all is not a ready pull request");
	});

	it("reviews only the listed repositories when it is told to", async () => {
		const { decide } = await agent({ REVIEW_REPOSITORIES: "Example-Org/Example-Repo, other/thing" });
		assert.equal((await decide(OPENED)).action, "submit");
		const other = await decide(READY, { repository: { fullName: "someone/else", cloneUrl: "https://github.com/someone/else.git" } });
		assert.equal(other.action, "drop");
		assert.match(other.reason, /someone\/else is not on the list/);
	});

	it("stops starting reviews at the daily cap and tells a person", async () => {
		const { decide } = await agent({ REVIEW_CAP_PER_DAY: "2" });
		assert.equal((await decide(OPENED, { number: 1 })).action, "submit");
		assert.equal((await decide(OPENED, { number: 2 })).action, "submit");
		const third = await decide(OPENED, { number: 3 });
		assert.equal(third.action, "deliver");
		assert.match(third.reason, /daily cap of 2/);
		assert.equal((await decide(OPENED, { number: 3 }, "2026-10-07T09:00:00.000Z")).action, "submit", "the next day starts afresh");
	});
});

describe("seeding the handler", () => {
	const dir = () => mkdtempSync(join(tmpdir(), "review-seed-"));

	it("installs the rendered handler on the first start for the pull request topics, and leaves the live copy alone afterwards", () => {
		const stateDir = dir();
		assert.deepEqual(seedHandler({ stateDir, settings: loadReviewEventSettings({ REVIEW_CAP_PER_DAY: "7" }), log: silent }), { seeded: true, version: 1 });
		const store = new HandlerStore(handlersDir(stateDir));
		assert.match(store.current(HANDLER)!.source, /"submitCapPerDay": 7/);
		assert.deepEqual(store.current(HANDLER)!.topics, TOPICS);
		assert.deepEqual(seedHandler({ stateDir, settings: loadReviewEventSettings({ REVIEW_CAP_PER_DAY: "9" }), log: silent }), { seeded: false, version: 1 });
		assert.match(store.current(HANDLER)!.source, /"submitCapPerDay": 7/);
	});

	it("writes a new version when asked to reseed, keeping the earlier one", () => {
		const stateDir = dir();
		seedHandler({ stateDir, settings: loadReviewEventSettings({}), log: silent });
		assert.deepEqual(seedHandler({ stateDir, settings: loadReviewEventSettings({ REVIEW_CAP_PER_DAY: "9" }), log: silent, reseed: true }), { seeded: true, version: 2 });
		assert.match(new HandlerStore(handlersDir(stateDir)).current(HANDLER)!.source, /"submitCapPerDay": 9/);
	});

	it("refuses a template without the placeholder and a setting that is not a whole number", () => {
		assert.throws(() => renderHandler(loadReviewEventSettings({}), "export default () => 1"), /no __CONFIG__ placeholder/);
		assert.throws(() => loadReviewEventSettings({ REVIEW_CAP_PER_DAY: "many" }), /REVIEW_CAP_PER_DAY must be a positive whole number/);
	});

	it("has events on in the profile, with a budget cap that covers a review", () => {
		assert.equal(profile.events?.enabled, true);
		assert.deepEqual(profile.events?.submitBudgetCap, { maxTokens: 200_000, maxMinutes: 20 });
	});
});

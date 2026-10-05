import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { comparable, hasChanges, plan, toMarkdown } from "../src/plan.ts";
import { asLive, declared, parse } from "./fake.ts";
import { view } from "./helpers.ts";

const rules = parse({ ...declared("a"), ...declared("b") });
const summary = (changes: ReturnType<typeof plan>) => changes.changes.map((change) => `${change.action} ${change.name}`);

describe("plan", () => {
	it("creates what is missing, leaves what matches and deletes what no file declares", () => {
		const live = [...asLive([rules[0]!]), view("old", { owner: "automation/old", selector: "x.y.z", wake: true })];
		const result = plan(rules, live);
		assert.deepEqual(summary(result), ["unchanged a", "create b", "delete old"]);
		assert.equal(result.counts.create, 1);
		assert.equal(hasChanges(result), true);
		assert.equal(hasChanges(plan(rules, asLive(rules))), false);
	});

	it("does not delete when pruning is off", () => {
		assert.deepEqual(summary(plan([], [view("old", { owner: "agent/x", selector: "x.y.z", wake: true })], { prune: false })), []);
	});

	it("compares after filling the domain's defaults, so a live rule with defaults is unchanged", () => {
		const live = asLive(rules).map((rule) => ({ ...rule, description: rule.description, reaction: { ...rule.reaction!, maxDepth: 3, maxFiringsPerHour: 30, capability: { ...rule.reaction!.capability, version: String(rule.reaction!.capability.version) } } }));
		assert.equal(hasChanges(plan(rules, live)), false);
		assert.deepEqual(comparable(rules[0]!.rule), comparable({ ...rules[0]!.rule, reaction: { ...rules[0]!.rule.reaction!, maxDepth: 3, maxFiringsPerHour: 30 } }));
	});

	it("ignores fields the domain adds and key order inside the input", () => {
		const live = asLive(rules).map((rule) => ({ ...rule, createdAt: "x", counters: { ...rule.counters, fired: 9 }, reaction: { ...rule.reaction!, requireApproval: "auto", input: Object.fromEntries(Object.entries(rule.reaction!.input).reverse()) } }));
		assert.equal(hasChanges(plan(rules, live as never)), false);
	});

	it("replaces a changed rule and says which fields differ", () => {
		const changed = parse(declared("a", (yaml) => yaml.replace("selector: github.pull_request.opened", "selector: github.pull_request.reopened").replace("  budget:\n    maxTokens: 200000", "  budget:\n    maxTokens: 100000")));
		const result = plan(changed, asLive(parse(declared("a"))));
		assert.deepEqual(summary(result), ["replace a"]);
		assert.ok(result.changes[0]!.differences.includes('selector: "github.pull_request.opened" → "github.pull_request.reopened"'));
		assert.ok(result.changes[0]!.differences.some((line) => line.startsWith("reaction.budget.maxTokens")));
	});

	it("keeps the domain's pause state when the file says nothing about status", () => {
		const paused = asLive(rules, { status: "paused" });
		assert.equal(hasChanges(plan(rules, paused)), false);
		const changed = parse(declared("a", (yaml) => yaml.replace("wake: false", "wake: true")));
		const replace = plan(changed, asLive(parse(declared("a")), { status: "paused" })).changes[0]!;
		assert.equal(replace.action, "replace");
		assert.equal(replace.body!.status, "paused");
	});

	it("enforces an explicit status: resumes a paused rule, pauses an active one, creates paused", () => {
		const active = parse(declared("a", (yaml) => `${yaml}status: active\n`));
		assert.deepEqual(summary(plan(active, asLive(active, { status: "paused" }))), ["resume a"]);
		const paused = parse(declared("a", (yaml) => `${yaml}status: paused\n`));
		assert.deepEqual(summary(plan(paused, asLive(paused, { status: "active" }))), ["pause a"]);
		const created = plan(paused, []).changes[0]!;
		assert.equal(created.action, "create");
		assert.equal(created.body!.status, "paused");
		assert.equal(plan(rules, []).changes[0]!.body!.status, "active");
	});

	it("renders a markdown comment with a marker, a table and the differences", () => {
		const changed = parse(declared("a", (yaml) => yaml.replace("wake: false", "wake: true")));
		const markdown = toMarkdown(plan(changed, [...asLive(parse(declared("a"))), view("old", { owner: "agent/x", selector: "x.y.z", wake: true })]));
		assert.ok(markdown.startsWith("<!-- somework-rules-plan -->"));
		assert.match(markdown, /\| ✏️ \| `a` \| replace \|/);
		assert.match(markdown, /\| 🗑️ \| `old` \| delete \(active, fired 0 times\) \|/);
		assert.match(markdown, /wake: false → true/);
		assert.match(markdown, /1 rule\(s\) exist in the domain but no file declares them/);
		assert.match(toMarkdown(plan(rules, asLive(rules))), /No changes: the 2 declared rule\(s\) match the domain\./);
		assert.match(toMarkdown(plan(rules, []), { dryRun: true }), /Dry run: nothing was changed/);
	});
});

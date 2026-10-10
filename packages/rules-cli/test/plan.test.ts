import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { comparable, hasChanges, plan, toMarkdown } from "../src/plan.ts";
import { asLive, declared, parse } from "./fake.ts";
import { view } from "./helpers.ts";

const rules = parse({ ...declared("a"), ...declared("b") });
const summary = (changes: ReturnType<typeof plan>) => changes.changes.map((change) => `${change.action} ${change.name}`);

describe("plan", () => {
	it("creates what is missing, leaves what matches and deletes what no file declares", () => {
		const live = [...asLive([rules[0]!]), view("old", { owner: "agent/old", selector: "x.y.z", wake: true })];
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
		const bare = parse({ "a.yaml": "name: a\nowner: agent/x\nselector: x.y.z\nwake: true\n" });
		const live = asLive(bare).map((rule) => ({ ...rule, description: "", where: [] }));
		assert.equal(hasChanges(plan(bare, live)), false);
		assert.deepEqual(comparable(bare[0]!.rule), { description: "", owner: "agent/x", selector: "x.y.z", where: [], wake: true });
	});

	it("ignores fields the domain adds", () => {
		const live = asLive(rules).map((rule) => ({ ...rule, createdAt: "x", updatedAt: "y", lastFiredAt: "z", counters: { fired: 9 } }));
		assert.equal(hasChanges(plan(rules, live as never)), false);
	});

	it("replaces a changed rule and says which fields differ", () => {
		const changed = parse(declared("a", (yaml) => yaml.replace("selector: github.pull_request.opened", "selector: github.pull_request.reopened").replace("equals: false", "equals: true")));
		const result = plan(changed, asLive(parse(declared("a"))));
		assert.deepEqual(summary(result), ["replace a"]);
		assert.ok(result.changes[0]!.differences.includes('selector: "github.pull_request.opened" → "github.pull_request.reopened"'));
		assert.ok(result.changes[0]!.differences.includes("where.0.equals: false → true") || result.changes[0]!.differences.some((line) => line.startsWith("where")));
	});

	it("keeps the domain's pause state when the file says nothing about status", () => {
		const paused = asLive(rules, { status: "paused" });
		assert.equal(hasChanges(plan(rules, paused)), false);
		const changed = parse(declared("a", (yaml) => yaml.replace("description: Wake the reviewer for every opened pull request.", "description: Reviewer wake")));
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
		const changed = parse(declared("a", (yaml) => yaml.replace("description: Wake the reviewer for every opened pull request.", "description: Reviewer wake")));
		const markdown = toMarkdown(plan(changed, [...asLive(parse(declared("a"))), view("old", { owner: "agent/x", selector: "x.y.z", wake: true })]));
		assert.ok(markdown.startsWith("<!-- somework-rules-plan -->"));
		assert.match(markdown, /\| ✏️ \| `a` \| replace \|/);
		assert.match(markdown, /\| 🗑️ \| `old` \| delete \(active\) \|/);
		assert.match(markdown, /description: "Wake the reviewer for every opened pull request\." → "Reviewer wake"/);
		assert.match(markdown, /1 rule\(s\) exist in the domain but no file declares them/);
		assert.match(toMarkdown(plan(rules, asLive(rules))), /No changes: the 2 declared rule\(s\) match the domain\./);
		assert.match(toMarkdown(plan(rules, []), { dryRun: true }), /Dry run: nothing was changed/);
	});
});

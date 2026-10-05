import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { renderTemplate, type Json } from "@somework/sdk";
import { checkAgainstCards, globMatch, loadCards, loadSamples } from "../src/cards.ts";
import { validateAll } from "../src/cli.ts";
import { checkDuplicates, checkRule, loadRules } from "../src/rules.ts";
import { realRules, repoRoot, REVIEW_YAML, rulesDir } from "./helpers.ts";

const messages = (dir: string, extra: { cards?: string[] } = {}) => validateAll(dir, extra.cards ?? [], undefined, false).findings.filter((finding) => finding.level === "error").map((finding) => `${finding.file}: ${finding.message}`);
const withLine = (yaml: string, from: string, to: string) => {
	assert.ok(yaml.includes(from), from);
	return yaml.replace(from, to);
};

describe("loading", () => {
	it("accepts a valid rule and reads the typed fields", () => {
		const { rules, findings } = loadRules(rulesDir({ "pr-review.yaml": REVIEW_YAML }));
		assert.deepEqual(findings, []);
		assert.equal(rules[0]!.rule.where![0]!.equals, false);
		assert.equal(rules[0]!.rule.reaction!.capability.version, 3);
		assert.equal((rules[0]!.rule.reaction!.input as any).pullRequest, "${/data/number}");
	});

	it("reports YAML syntax errors, schema violations and unknown keys with the file name", () => {
		const errors = messages(rulesDir({ "broken.yaml": "name: [unclosed\n", "extra.yaml": withLine(REVIEW_YAML, "name: pr-review", "name: extra\nsurprise: 1"), "empty.yaml": "name: empty\n" }));
		assert.ok(errors.some((line) => line.startsWith("broken.yaml: YAML:")), errors.join("\n"));
		assert.ok(errors.includes("extra.yaml: schema: /surprise is not allowed"));
		assert.ok(errors.includes("empty.yaml: schema: /owner is required"));
		assert.ok(errors.includes("empty.yaml: schema: /wake is required"));
	});

	it("treats yes, no and on as strings (YAML 1.2), so a rule cannot turn a flag on by accident", () => {
		const errors = messages(rulesDir({ "pr-review.yaml": withLine(REVIEW_YAML, "wake: false", "wake: no") }));
		assert.ok(errors.includes("pr-review.yaml: schema: /wake must be boolean, got string"));
	});

	it("refuses duplicate keys and aliases", () => {
		assert.ok(messages(rulesDir({ "pr-review.yaml": `${REVIEW_YAML}wake: true\n` })).some((line) => line.includes("YAML:")));
		assert.ok(messages(rulesDir({ "pr-review.yaml": `${REVIEW_YAML}x: &a 1\ny: *a\n` })).some((line) => line.includes("YAML:") || line.includes("schema:")));
	});

	it("requires the name to equal the file name and to be unique", () => {
		const errors = messages(rulesDir({ "other.yaml": REVIEW_YAML, "dup.yml": withLine(REVIEW_YAML, "name: pr-review", "name: dup") }));
		assert.ok(errors.includes('other.yaml: name "pr-review" must equal the file name "other"'));
		assert.equal(errors.filter((line) => line.includes("also declared")).length, 0);
		const twice = messages(rulesDir({ "pr-review.yaml": REVIEW_YAML, "pr-review.yml": REVIEW_YAML }));
		assert.ok(twice.some((line) => line.includes('rule "pr-review" is also declared in pr-review.yaml')), twice.join("\n"));
	});
});

describe("conventions", () => {
	const check = (change: (yaml: string) => string) => messages(rulesDir({ "pr-review.yaml": change(REVIEW_YAML) }));

	it("a reaction needs an automation owner; an agent subscription needs wake and an agent owner", () => {
		assert.ok(check((y) => withLine(y, "owner: automation/pr-review", "owner: agent/manager")).some((line) => line.includes("must be owned by an automation principal")));
		const subscription = "name: sub\nowner: automation/x\nselector: grafana.alert.firing\nwake: true\n";
		assert.ok(messages(rulesDir({ "sub.yaml": subscription })).some((line) => line.includes("agent subscription")));
		const idle = "name: idle\nowner: agent/manager\nselector: grafana.alert.firing\nwake: false\n";
		assert.ok(messages(rulesDir({ "idle.yaml": idle })).some((line) => line.includes("reaction or wake: true") || line.includes("must set wake: true")));
		assert.deepEqual(messages(rulesDir({ "ok.yaml": "name: ok\nowner: agent/manager\nselector: grafana.alert.firing\nwake: true\n" })), []);
	});

	it("rejects selectors that are not topic globs", () => {
		for (const selector of ["*", "github", "GitHub.pull_request.opened", "github.**", "github..opened", "github.pull request"]) {
			assert.ok(check((y) => withLine(y, "selector: github.pull_request.opened", `selector: ${JSON.stringify(selector)}`)).length > 0, selector);
		}
		assert.deepEqual(check((y) => withLine(y, "selector: github.pull_request.opened", "selector: github.pull_request.*")), []);
	});

	it("checks that every pointer starts at a field of the event payload", () => {
		assert.ok(check((y) => withLine(y, "path: /data/draft", "path: /payload/draft")).some((line) => line.includes('where path "/payload/draft"')));
		assert.ok(check((y) => withLine(y, "pullRequest: ${/data/number}", "pullRequest: ${/body/number}")).some((line) => line.includes('input reference "/body/number"')));
		assert.deepEqual(check((y) => withLine(y, "pullRequest: ${/data/number}", "pullRequest: ${/depth}")), []);
	});

	it("rejects malformed templates", () => {
		assert.ok(check((y) => withLine(y, "pullRequest: ${/data/number}", 'pullRequest: "${/data/number"')).some((line) => line.includes('unterminated "${"')));
		assert.ok(check((y) => withLine(y, "pullRequest: ${/data/number}", 'pullRequest: "${data/number}"')).some((line) => line.includes("JSON pointer must start")));
	});

	it("keeps budget, depth and rate within sane limits and the inner budget within the reaction budget", () => {
		assert.ok(check((y) => y.replace("  budget:\n    maxTokens: 200000", "  budget:\n    maxTokens: 9000000")).some((line) => line.includes("maxTokens") && line.includes("exceeds")));
		assert.ok(check((y) => `${y}  maxDepth: 6\n`).some((line) => line.includes("maxDepth exceeds 5")));
		assert.ok(check((y) => `${y}  maxFiringsPerHour: 500\n`).some((line) => line.includes("maxFiringsPerHour exceeds 120")));
		assert.ok(check((y) => y.replace(/(\n    budget:\n      maxTokens: )200000/, "$1300000")).some((line) => line.includes("input.budget.maxTokens exceeds reaction.budget.maxTokens")));
		assert.ok(check((y) => y.replace("  budget:\n    maxTokens: 200000\n    maxMinutes: 20\n", "")).some((line) => line.includes("/reaction/budget is required")));
	});

	it("warns about a wildcard reaction without where, about status: active and about duplicates", () => {
		const open = withLine(withLine(REVIEW_YAML, "selector: github.pull_request.opened", "selector: github.pull_request.*"), "where:\n  - path: /data/draft\n    equals: false\n", "");
		const { findings } = validateAll(rulesDir({ "pr-review.yaml": open, "copy.yaml": withLine(open, "name: pr-review", "name: copy") }), [], undefined, false);
		assert.ok(findings.some((finding) => finding.level === "warning" && finding.message.includes("fires for every matching event")));
		assert.ok(findings.some((finding) => finding.message.startsWith("same owner, selector and where as ")));
		const active = validateAll(rulesDir({ "pr-review.yaml": `${REVIEW_YAML}status: active\n` }), [], undefined, false).findings;
		assert.ok(active.some((finding) => finding.level === "warning" && finding.message.includes("resumes the rule at every apply")));
		assert.equal(validateAll(rulesDir({ "pr-review.yaml": `${REVIEW_YAML}status: active\n` }), [], undefined, true).ok, false);
	});

	it("checkRule and checkDuplicates work on parsed rules directly", () => {
		const { rules } = loadRules(rulesDir({ "pr-review.yaml": REVIEW_YAML }));
		assert.deepEqual(checkRule(rules[0]!), []);
		assert.deepEqual(checkDuplicates(rules), []);
	});
});

describe("the capability cards", () => {
	const cards = join(repoRoot, "adapters");
	const sampleFor = (topic: string, data: Json) => JSON.stringify({ topic, source: "github", key: "k", data, classification: "internal", verified: true, depth: 0, causedByTask: null, publishedBy: "producer/github" });

	it("every shipped rule renders an input that its capability's inputSchema accepts", () => {
		const { rules, findings } = loadRules(realRules);
		const capabilities = loadCards([cards]);
		const samples = loadSamples(join(realRules, "samples"));
		assert.deepEqual(findings, []);
		const reactions = rules.filter(({ rule }) => rule.reaction);
		assert.ok(reactions.length >= 3, "the shipped rules include reactions");
		assert.deepEqual(checkAgainstCards(rules, capabilities, samples).filter((finding) => finding.level !== "note"), []);

		for (const { rule } of reactions) {
			const card = capabilities.find((capability) => capability.id === rule.reaction!.capability.id && String(capability.version) === String(rule.reaction!.capability.version));
			assert.ok(card?.inputSchema, `${rule.name}: card with inputSchema`);
			const firing = samples.filter((sample) => globMatch(rule.selector, sample.payload.topic));
			assert.ok(firing.length > 0, `${rule.name}: a sample`);
			for (const sample of firing) assert.doesNotThrow(() => renderTemplate(rule.reaction!.input as Json, sample.payload as Json));
		}
	});

	it("validates the whole shipped rules directory, with cards and samples", () => {
		const result = validateAll(realRules, [cards], undefined, true);
		assert.deepEqual(result.findings.filter((finding) => finding.level !== "note"), []);
		assert.ok(result.ok);
		assert.equal(result.rules.length, readdirSync(realRules).filter((name) => name.endsWith(".yaml")).length);
	});

	it("fails when the rendered input breaks the capability's schema", () => {
		const dir = rulesDir({
			"pr-review.yaml": withLine(REVIEW_YAML, "    pullRequest: ${/data/number}\n", "    pullRequest: ${/data/headRef}\n"),
			"samples/github.pull_request.opened.json": readFileSync(join(realRules, "samples/github.pull_request.opened.json"), "utf8"),
		});
		const errors = messages(dir, { cards: [cards] });
		assert.ok(errors.some((line) => line.includes("rendered input /pullRequest must be integer, got string")), errors.join("\n"));
	});

	it("fails when the input leaves out a required field or adds one the card forbids", () => {
		const base = readFileSync(join(realRules, "samples/github.pull_request.opened.json"), "utf8");
		const missing = rulesDir({ "pr-review.yaml": withLine(REVIEW_YAML, "    pullRequest: ${/data/number}\n    budget:\n      maxTokens: 200000\n      maxMinutes: 20\n  budget", "    pullRequest: ${/data/number}\n  budget"), "samples/a.json": base });
		assert.ok(messages(missing, { cards: [cards] }).some((line) => line.includes("/budget is required")));
		const extra = rulesDir({ "pr-review.yaml": withLine(REVIEW_YAML, "    pullRequest: ${/data/number}\n", "    pullRequest: ${/data/number}\n    force: true\n"), "samples/a.json": base });
		assert.ok(messages(extra, { cards: [cards] }).some((line) => line.includes("/force is not allowed")));
	});

	it("fails when the sample lacks a field the template needs, when no sample exists and when the capability is unknown", () => {
		const noField = rulesDir({ "pr-review.yaml": REVIEW_YAML, "samples/a.json": sampleFor("github.pull_request.opened", { draft: false, number: 1 }) });
		assert.ok(messages(noField, { cards: [cards] }).some((line) => line.includes("nothing at /data/repository/cloneUrl")));
		const none = rulesDir({ "pr-review.yaml": REVIEW_YAML });
		assert.ok(messages(none, { cards: [cards] }).some((line) => line.includes("no sample event")));
		const unknown = rulesDir({ "pr-review.yaml": withLine(REVIEW_YAML, "version: 3", "version: 99"), "samples/a.json": sampleFor("github.pull_request.opened", {}) });
		assert.ok(messages(unknown, { cards: [cards] }).some((line) => line.includes("code.review v99 is on no card (versions on cards: 3)")));
	});

	it("matches selectors with the domain's glob semantics", () => {
		assert.equal(globMatch("github.pull_request.*", "github.pull_request.opened"), true);
		assert.equal(globMatch("github.*.opened", "github.pull_request.opened"), true);
		assert.equal(globMatch("github.pull_request.opened", "github.pull_request.opened.x"), false);
		assert.equal(globMatch("*.alert.*", "grafana.alert.firing"), true);
		assert.equal(globMatch("a*b*c", "axxbyyc"), true);
		assert.equal(globMatch("a*b*c", "axxbyy"), false);
	});
});

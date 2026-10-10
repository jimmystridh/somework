import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { validateAll } from "../src/cli.ts";
import { checkDuplicates, checkRule, loadRules } from "../src/rules.ts";
import { checkAgainstSamples, globMatch, loadSamples } from "../src/samples.ts";
import { realRules, REVIEW_YAML, rulesDir } from "./helpers.ts";

const messages = (dir: string) => validateAll(dir, false).findings.filter((finding) => finding.level === "error").map((finding) => `${finding.file}: ${finding.message}`);
const withLine = (yaml: string, from: string, to: string) => {
	assert.ok(yaml.includes(from), from);
	return yaml.replace(from, to);
};

describe("loading", () => {
	it("accepts a valid rule and reads the typed fields", () => {
		const { rules, findings } = loadRules(rulesDir({ "pr-review.yaml": REVIEW_YAML }));
		assert.deepEqual(findings, []);
		assert.equal(rules[0]!.rule.where![0]!.equals, false);
		assert.equal(rules[0]!.rule.owner, "agent/reviewer");
		assert.equal(rules[0]!.rule.wake, true);
	});

	it("reports YAML syntax errors, schema violations and unknown keys with the file name", () => {
		const errors = messages(rulesDir({ "broken.yaml": "name: [unclosed\n", "extra.yaml": withLine(REVIEW_YAML, "name: pr-review", "name: extra\nsurprise: 1"), "empty.yaml": "name: empty\n" }));
		assert.ok(errors.some((line) => line.startsWith("broken.yaml: YAML:")), errors.join("\n"));
		assert.ok(errors.includes("extra.yaml: schema: /surprise is not allowed"));
		assert.ok(errors.includes("empty.yaml: schema: /owner is required"));
		assert.ok(errors.includes("empty.yaml: schema: /wake is required"));
	});

	it("refuses a rule that still carries a reaction", () => {
		const errors = messages(rulesDir({ "pr-review.yaml": `${REVIEW_YAML}reaction:\n  capability:\n    id: code.review\n    version: 3\n` }));
		assert.ok(errors.includes("pr-review.yaml: schema: /reaction is not allowed"), errors.join("\n"));
	});

	it("treats yes, no and on as strings (YAML 1.2), so a rule cannot turn a flag on by accident", () => {
		const errors = messages(rulesDir({ "pr-review.yaml": withLine(REVIEW_YAML, "wake: true", "wake: yes") }));
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

	it("wakes an agent: wake must be true and an automation principal has no inbox to wake", () => {
		const idle = check((y) => withLine(y, "wake: true", "wake: false"));
		assert.ok(idle.some((line) => line.includes("wake")), idle.join("\n"));
		const automation = check((y) => withLine(y, "owner: agent/reviewer", "owner: automation/pr-review"));
		assert.ok(automation.some((line) => line.includes("automation principal, which has no inbox to wake")), automation.join("\n"));
		assert.deepEqual(messages(rulesDir({ "ok.yaml": "name: ok\nowner: agent/manager\nselector: grafana.alert.firing\nwake: true\n" })), []);
	});

	it("rejects selectors that are not topic globs", () => {
		for (const selector of ["*", "github", "GitHub.pull_request.opened", "github.**", "github..opened", "github.pull request"]) {
			assert.ok(check((y) => withLine(y, "selector: github.pull_request.opened", `selector: ${JSON.stringify(selector)}`)).length > 0, selector);
		}
		assert.deepEqual(check((y) => withLine(y, "selector: github.pull_request.opened", "selector: github.pull_request.*")), []);
	});

	it("checks that every where pointer starts at a field of the event payload", () => {
		assert.ok(check((y) => withLine(y, "path: /data/draft", "path: /payload/draft")).some((line) => line.includes('where path "/payload/draft"')));
		assert.deepEqual(check((y) => withLine(y, "path: /data/draft", "path: /depth")), []);
	});

	it("warns about status: active and about duplicates, and lets a subscription use a wildcard without where (the agent filters)", () => {
		const open = withLine(withLine(REVIEW_YAML, "selector: github.pull_request.opened", "selector: github.pull_request.*"), "where:\n  - path: /data/draft\n    equals: false\n", "");
		const { findings } = validateAll(rulesDir({ "pr-review.yaml": open, "copy.yaml": withLine(open, "name: pr-review", "name: copy") }), false);
		assert.ok(!findings.some((finding) => finding.message.includes("wildcard")));
		assert.equal(findings.filter((finding) => finding.level === "error").length, 0);
		assert.ok(findings.some((finding) => finding.message.startsWith("same owner, selector and where as ")));
		const active = validateAll(rulesDir({ "pr-review.yaml": `${REVIEW_YAML}status: active\n` }), false).findings;
		assert.ok(active.some((finding) => finding.level === "warning" && finding.message.includes("resumes the rule at every apply")));
		assert.equal(validateAll(rulesDir({ "pr-review.yaml": `${REVIEW_YAML}status: active\n` }), true).ok, false);
	});

	it("checkRule and checkDuplicates work on parsed rules directly", () => {
		const { rules } = loadRules(rulesDir({ "pr-review.yaml": REVIEW_YAML }));
		assert.deepEqual(checkRule(rules[0]!), []);
		assert.deepEqual(checkDuplicates(rules), []);
	});
});

describe("recorded sample events", () => {
	const sample = readFileSync(join(realRules, "samples/github.pull_request.opened.json"), "utf8");

	it("warns when a where path resolves in none of the samples of the topic", () => {
		const dir = rulesDir({ "pr-review.yaml": withLine(REVIEW_YAML, "path: /data/draft", "path: /data/isDraft"), "samples/github.pull_request.opened.json": sample });
		const findings = validateAll(dir, false).findings;
		assert.ok(findings.some((finding) => finding.level === "warning" && finding.message.includes("no recorded sample for github.pull_request.opened has every where path")), JSON.stringify(findings));
	});

	it("is quiet when the path resolves, when there is no sample and when the rule has no where", () => {
		assert.deepEqual(validateAll(rulesDir({ "pr-review.yaml": REVIEW_YAML, "samples/github.pull_request.opened.json": sample }), true).findings, []);
		assert.deepEqual(validateAll(rulesDir({ "pr-review.yaml": REVIEW_YAML }), true).findings, []);
		const { rules } = loadRules(rulesDir({ "a.yaml": "name: a\nowner: agent/x\nselector: github.pull_request.opened\nwake: true\n" }));
		assert.deepEqual(checkAgainstSamples(rules, loadSamples(join(realRules, "samples"))), []);
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

describe("the shipped rules directory", () => {
	it("validates, even in strict mode, with its recorded samples", () => {
		const result = validateAll(realRules, true);
		assert.deepEqual(result.findings.filter((finding) => finding.level !== "note"), []);
		assert.ok(result.ok);
		assert.equal(result.rules.length, readdirSync(realRules).filter((name) => name.endsWith(".yaml")).length);
	});

	it("declares subscriptions only: every rule wakes an agent", () => {
		const { rules } = loadRules(realRules);
		assert.ok(rules.length > 0);
		for (const { file, rule } of rules) {
			assert.equal(rule.wake, true, file);
			assert.ok(!rule.owner.startsWith("automation/"), `${file}: ${rule.owner}`);
		}
	});
});

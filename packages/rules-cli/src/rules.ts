import { readdirSync, readFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { parseDocument } from "yaml";
import { ContractError, DEFAULT_MAX_DEPTH, DEFAULT_MAX_FIRINGS_PER_HOUR, RULE_NAME_PATTERN, templatePointers, validateRuleSpec, type Json, type RuleSpec } from "@somework/sdk";
import { formatIssues, validateSchema, type Schema } from "./schema.ts";

export interface RuleFile extends RuleSpec {
	name: string;
}

export interface LoadedRule {
	file: string;
	rule: RuleFile;
}

export interface Finding {
	level: "error" | "warning" | "note";
	file: string;
	message: string;
}

export const LIMITS = { maxDepth: 5, maxFiringsPerHour: 120, maxTokens: 5_000_000, maxMinutes: 240 } as const;

/** The first token of every pointer a rule may read: the fields of the event payload as the domain stores them. */
export const EVENT_FIELDS = new Set(["data", "topic", "source", "key", "classification", "verified", "depth", "causedByTask", "publishedBy"]);

export const RULE_EXTENSIONS = new Set([".yaml", ".yml"]);

export function ruleFileNames(dir: string): string[] {
	return readdirSync(dir)
		.filter((name) => RULE_EXTENSIONS.has(extname(name)))
		.sort();
}

export function loadSchema(dir: string): Schema {
	return JSON.parse(readFileSync(join(dir, "schema.json"), "utf8")) as Schema;
}

/** Reads and checks every rule file in `dir`. Findings carry the file; the rules that parsed are returned even when others fail. */
export function loadRules(dir: string): { rules: LoadedRule[]; findings: Finding[] } {
	const findings: Finding[] = [];
	const rules: LoadedRule[] = [];
	const schema = loadSchema(dir);
	const seen = new Map<string, string>();

	for (const file of ruleFileNames(dir)) {
		const error = (message: string) => findings.push({ level: "error", file, message });
		const document = parseDocument(readFileSync(join(dir, file), "utf8"), { version: "1.2", strict: true, uniqueKeys: true, maxAliasCount: 0 });
		if (document.errors.length > 0) {
			for (const problem of document.errors) error(`YAML: ${problem.message.split("\n")[0]}`);
			continue;
		}
		for (const problem of document.warnings) findings.push({ level: "warning", file, message: `YAML: ${problem.message.split("\n")[0]}` });
		const value = document.toJS() as unknown;
		const issues = formatIssues(validateSchema(value, schema));
		if (issues.length > 0) {
			for (const issue of issues) error(`schema: ${issue}`);
			continue;
		}
		const rule = value as RuleFile;
		const stem = basename(file, extname(file));
		if (rule.name !== stem) error(`name ${JSON.stringify(rule.name)} must equal the file name ${JSON.stringify(stem)}`);
		if (seen.has(rule.name)) error(`rule ${JSON.stringify(rule.name)} is also declared in ${seen.get(rule.name)}`);
		else seen.set(rule.name, file);
		rules.push({ file, rule });
	}
	return { rules, findings };
}

function pointerProblems(label: string, pointers: string[]): string[] {
	return pointers
		.filter((pointer) => !EVENT_FIELDS.has(pointer.split("/")[1] ?? ""))
		.map((pointer) => `${label} ${JSON.stringify(pointer)} must start with one of /${[...EVENT_FIELDS].join(", /")}`);
}

/** The checks that need more than a schema: the contract of the domain, ownership conventions and sane limits. */
export function checkRule({ file, rule }: LoadedRule): Finding[] {
	const findings: Finding[] = [];
	const error = (message: string) => findings.push({ level: "error", file, message });
	const warn = (message: string) => findings.push({ level: "warning", file, message });
	const { name, ...spec } = rule;

	if (!RULE_NAME_PATTERN.test(name)) error(`name ${JSON.stringify(name)} has an invalid shape`);
	try {
		validateRuleSpec(spec);
	} catch (problem) {
		if (!(problem instanceof ContractError)) throw problem;
		error(problem.message);
		return findings;
	}

	const owner = spec.owner;
	if (spec.reaction && !owner.startsWith("automation/")) error(`a rule with a reaction must be owned by an automation principal (automation/<name>), not ${owner}`);
	if (!spec.reaction && owner.startsWith("automation/")) error(`a rule without a reaction is an agent subscription; ${owner} is an automation principal, which has no inbox to wake`);
	if (!spec.reaction && spec.wake !== true) error("a rule without a reaction must set wake: true");
	if (spec.reaction && spec.selector.endsWith("*") && !spec.where?.length) warn(`selector ${JSON.stringify(spec.selector)} ends in a wildcard and the rule has no where: the reaction fires for every matching event`);
	if (spec.status === "active") warn("status: active resumes the rule at every apply, undoing a pause made at runtime; leave status out unless that is the intent");

	for (const problem of pointerProblems("where path", (spec.where ?? []).map((entry) => entry.path))) error(problem);

	const reaction = spec.reaction;
	if (reaction) {
		try {
			for (const problem of pointerProblems("input reference", templatePointers(reaction.input as Json))) error(problem);
		} catch (problem) {
			error(`input: ${(problem as Error).message}`);
		}
		if (reaction.budget.maxTokens > LIMITS.maxTokens) error(`reaction.budget.maxTokens ${reaction.budget.maxTokens} exceeds ${LIMITS.maxTokens}`);
		if (reaction.budget.maxMinutes > LIMITS.maxMinutes) error(`reaction.budget.maxMinutes ${reaction.budget.maxMinutes} exceeds ${LIMITS.maxMinutes}`);
		if ((reaction.maxDepth ?? DEFAULT_MAX_DEPTH) > LIMITS.maxDepth) error(`reaction.maxDepth exceeds ${LIMITS.maxDepth}`);
		if ((reaction.maxFiringsPerHour ?? DEFAULT_MAX_FIRINGS_PER_HOUR) > LIMITS.maxFiringsPerHour) error(`reaction.maxFiringsPerHour exceeds ${LIMITS.maxFiringsPerHour}`);
		const inner = (reaction.input as { budget?: { maxTokens?: unknown; maxMinutes?: unknown } }).budget;
		if (inner && typeof inner.maxTokens === "number" && inner.maxTokens > reaction.budget.maxTokens) error("input.budget.maxTokens exceeds reaction.budget.maxTokens");
		if (inner && typeof inner.maxMinutes === "number" && inner.maxMinutes > reaction.budget.maxMinutes) error("input.budget.maxMinutes exceeds reaction.budget.maxMinutes");
	}
	return findings;
}

/** Two rules that select the same topics with the same filters under different names usually mean a copy that was never cleaned up. */
export function checkDuplicates(rules: LoadedRule[]): Finding[] {
	const bySignature = new Map<string, LoadedRule>();
	const findings: Finding[] = [];
	for (const loaded of rules) {
		const { owner, selector, where } = loaded.rule;
		const signature = JSON.stringify([owner, selector, where ?? []]);
		const earlier = bySignature.get(signature);
		if (earlier) findings.push({ level: "warning", file: loaded.file, message: `same owner, selector and where as ${earlier.file}` });
		else bySignature.set(signature, loaded);
	}
	return findings;
}

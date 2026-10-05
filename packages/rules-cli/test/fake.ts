import { SomeWorkError, type RuleSpec, type RuleView } from "@somework/sdk";
import type { RulesApi } from "../src/apply.ts";
import { loadRules, type LoadedRule } from "../src/rules.ts";
import { REVIEW_YAML, rulesDir, view } from "./helpers.ts";

/** An in-memory domain: remembers calls, can fail a named call and can ignore the status of a PUT. */
export class FakeDomain implements RulesApi {
	readonly rules = new Map<string, RuleView>();
	readonly calls: string[] = [];
	failOn = new Set<string>();
	ignoreStatusOnPut = false;

	constructor(initial: RuleView[] = []) {
		for (const rule of initial) this.rules.set(rule.name, rule);
	}

	async list() {
		this.calls.push("list");
		return [...this.rules.values()];
	}

	async put(name: string, spec: RuleSpec) {
		this.calls.push(`put ${name}`);
		if (this.failOn.has(`put ${name}`)) throw new SomeWorkError(500, "internal", "boom");
		const previous = this.rules.get(name);
		const next = { ...view(name, spec), status: this.ignoreStatusOnPut ? "active" : (spec.status ?? previous?.status ?? "active") } as RuleView;
		this.rules.set(name, next);
		return next;
	}

	async remove(name: string) {
		this.calls.push(`delete ${name}`);
		if (!this.rules.delete(name)) throw new SomeWorkError(404, "not_found", "no such rule");
	}

	async pause(name: string) {
		this.calls.push(`pause ${name}`);
		return this.setStatus(name, "paused");
	}

	async resume(name: string) {
		this.calls.push(`resume ${name}`);
		return this.setStatus(name, "active");
	}

	private setStatus(name: string, status: "active" | "paused") {
		const rule = this.rules.get(name);
		if (!rule) throw new SomeWorkError(404, "not_found", "no such rule");
		const next = { ...rule, status };
		this.rules.set(name, next);
		return next;
	}
}

export const parse = (files: Record<string, string>): LoadedRule[] => {
	const { rules, findings } = loadRules(rulesDir(files));
	if (findings.length > 0) throw new Error(JSON.stringify(findings));
	return rules;
};

export const declared = (name: string, edit: (yaml: string) => string = (yaml) => yaml) => ({ [`${name}.yaml`]: edit(REVIEW_YAML.replace("name: pr-review", `name: ${name}`)) });

/** What the domain would hold after applying `rules` (the same shape the real one returns). */
export const asLive = (rules: LoadedRule[], overrides: Partial<RuleView> = {}): RuleView[] => rules.map(({ rule }) => ({ ...view(rule.name, rule), ...overrides }));

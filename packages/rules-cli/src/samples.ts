import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { unresolvedPointers, type Json } from "@somework/sdk";
import type { Finding, LoadedRule } from "./rules.ts";

export interface Sample {
	file: string;
	payload: { topic: string; data: Json; [field: string]: Json };
}

/** Same matcher as the domain's topic subscriptions: `*` matches any run of characters, dots included. */
export function globMatch(pattern: string, value: string): boolean {
	const parts = pattern.split("*");
	if (parts.length === 1) return pattern === value;
	let rest = value;
	for (const [index, part] of parts.entries()) {
		if (index === 0) {
			if (!rest.startsWith(part)) return false;
			rest = rest.slice(part.length);
		} else if (index === parts.length - 1) {
			return rest.endsWith(part);
		} else {
			const at = rest.indexOf(part);
			if (at < 0) return false;
			rest = rest.slice(at + part.length);
		}
	}
	return true;
}

export function loadSamples(dir: string): Sample[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((name) => name.endsWith(".json"))
		.sort()
		.map((name) => {
			const payload = JSON.parse(readFileSync(join(dir, name), "utf8")) as Sample["payload"];
			if (typeof payload?.topic !== "string" || payload.data === null || typeof payload.data !== "object") throw new Error(`sample ${name} needs a topic and a data object`);
			return { file: name, payload };
		});
}

/** Warns when a `where` pointer resolves in none of the recorded sample events a rule would match: the filter probably never holds. */
export function checkAgainstSamples(rules: LoadedRule[], samples: Sample[]): Finding[] {
	const findings: Finding[] = [];
	for (const { file, rule } of rules) {
		if (!rule.where?.length) continue;
		const candidates = samples.filter((sample) => globMatch(rule.selector, sample.payload.topic));
		if (candidates.length === 0) continue;
		const resolves = candidates.some((sample) => unresolvedPointers(rule, sample.payload as Json).length === 0);
		if (!resolves) findings.push({ level: "warning", file, message: `no recorded sample for ${rule.selector} has every where path (${candidates.map((sample) => sample.file).join(", ")})` });
	}
	return findings;
}

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { renderTemplate, TemplateError, whereMatches, type Json } from "@somework/sdk";
import type { Finding, LoadedRule } from "./rules.ts";
import { formatIssues, validateSchema, type Schema } from "./schema.ts";

export interface CardCapability {
	id: string;
	version: number | string;
	sideEffects?: string;
	inputSchema?: Schema;
}

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

/** Card files given directly, or directories searched one level down for `card.json` (the layout of `adapters/`). */
export function loadCards(paths: string[]): CardCapability[] {
	const files = paths.flatMap((path) => {
		if (!existsSync(path)) throw new Error(`card path ${path} does not exist`);
		if (!statSync(path).isDirectory()) return [path];
		return readdirSync(path)
			.map((name) => join(path, name, "card.json"))
			.filter((file) => existsSync(file));
	});
	return files.flatMap((file) => ((JSON.parse(readFileSync(file, "utf8")) as { capabilities?: CardCapability[] }).capabilities ?? []));
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

/** Renders every reaction input against the recorded sample events it would fire on and validates the result against the capability's input schema. */
export function checkAgainstCards(rules: LoadedRule[], cards: CardCapability[], samples: Sample[]): Finding[] {
	const findings: Finding[] = [];
	for (const { file, rule } of rules) {
		const reaction = rule.reaction;
		if (!reaction) continue;
		const error = (message: string) => findings.push({ level: "error", file, message });
		const warn = (message: string) => findings.push({ level: "warning", file, message });
		const note = (message: string) => findings.push({ level: "note", file, message });

		const card = cards.find((candidate) => candidate.id === reaction.capability.id && String(candidate.version) === String(reaction.capability.version));
		if (!card) {
			const known = cards.filter((candidate) => candidate.id === reaction.capability.id).map((candidate) => candidate.version);
			error(`capability ${reaction.capability.id} v${reaction.capability.version} is on no card${known.length ? ` (versions on cards: ${known.join(", ")})` : ""}`);
			continue;
		}
		if (card.sideEffects && card.sideEffects !== "read" && card.sideEffects !== "none") note(`${card.id} has side effects (${card.sideEffects}): every firing waits for approval before the task runs`);

		const candidates = samples.filter((sample) => globMatch(rule.selector, sample.payload.topic));
		if (candidates.length === 0) {
			error(`no sample event in the samples directory matches selector ${JSON.stringify(rule.selector)}; record one so the input can be checked`);
			continue;
		}
		const firing = candidates.filter((sample) => whereMatches(rule.where, sample.payload as Json));
		if (firing.length === 0) warn("no sample event satisfies this rule's where; the input was not checked");
		for (const sample of firing) {
			let input: Json;
			try {
				input = renderTemplate(reaction.input as Json, sample.payload as Json);
			} catch (problem) {
				if (!(problem instanceof TemplateError)) throw problem;
				error(`sample ${sample.file}: ${problem.message}`);
				continue;
			}
			if (!card.inputSchema) {
				warn(`${card.id} v${card.version} has no inputSchema; the rendered input was not checked`);
				continue;
			}
			for (const issue of formatIssues(validateSchema(input, card.inputSchema))) error(`sample ${sample.file}: rendered input ${issue}`);
		}
	}
	return findings;
}

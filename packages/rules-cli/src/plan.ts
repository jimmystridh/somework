import { type Json, type RuleSpec, type RuleStatus, type RuleView } from "@somework/sdk";
import type { LoadedRule } from "./rules.ts";

export type Action = "create" | "replace" | "delete" | "pause" | "resume" | "unchanged";

export interface Change {
	action: Action;
	name: string;
	/** Human-readable field differences for a replace. */
	differences: string[];
	/** The body to PUT for create and replace, including the status to end up in. */
	body?: RuleSpec;
	note?: string;
}

export interface Plan {
	changes: Change[];
	counts: Record<Action, number>;
}

/** The part of a rule that the files control, with the domain's defaults filled in so a file and its live copy compare equal. */
export function comparable(spec: RuleSpec): Json {
	return {
		description: spec.description ?? "",
		owner: spec.owner,
		selector: spec.selector,
		where: (spec.where ?? []).map((entry) => ({ path: entry.path, equals: entry.equals })),
		wake: spec.wake,
	};
}

const canonical = (value: Json): string => JSON.stringify(value, (_key, nested) => (nested && typeof nested === "object" && !Array.isArray(nested) ? Object.fromEntries(Object.entries(nested).sort(([a], [b]) => a.localeCompare(b))) : nested));

function differences(before: Json, after: Json, path = ""): string[] {
	if (canonical(before) === canonical(after)) return [];
	const isObject = (value: Json): value is Record<string, Json> => value !== null && typeof value === "object" && !Array.isArray(value);
	if (isObject(before) && isObject(after)) {
		return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort().flatMap((key) => differences(before[key] ?? null, after[key] ?? null, path ? `${path}.${key}` : key));
	}
	const show = (value: Json) => (typeof value === "string" ? JSON.stringify(value) : canonical(value));
	return [`${path}: ${show(before)} → ${show(after)}`];
}

/**
 * Status: the files own the definition of a rule, the domain owns whether it is currently paused (a runtime control).
 * A file without `status` keeps whatever the domain has; `status: paused` and `status: active` are explicit and are enforced.
 */
export function plan(desired: LoadedRule[], live: RuleView[], options: { prune?: boolean } = {}): Plan {
	const liveByName = new Map(live.map((rule) => [rule.name, rule]));
	const changes: Change[] = [];

	for (const { rule } of desired) {
		const { name, ...spec } = rule;
		const existing = liveByName.get(name);
		if (!existing) {
			const status: RuleStatus = spec.status ?? "active";
			changes.push({ action: "create", name, differences: [], body: { ...spec, status }, ...(status === "paused" ? { note: "created paused" } : {}) });
			continue;
		}
		const wanted: RuleStatus = spec.status ?? existing.status;
		const drift = differences(comparable(existing), comparable(spec));
		if (drift.length > 0) {
			changes.push({ action: "replace", name, differences: drift, body: { ...spec, status: wanted }, ...(wanted !== existing.status ? { note: `status ${existing.status} → ${wanted}` } : {}) });
		} else if (wanted !== existing.status) {
			changes.push({ action: wanted === "paused" ? "pause" : "resume", name, differences: [], note: spec.status ? "the file sets status explicitly" : undefined });
		} else {
			changes.push({ action: "unchanged", name, differences: [] });
		}
	}

	if (options.prune !== false) {
		const declared = new Set(desired.map(({ rule }) => rule.name));
		for (const rule of live) if (!declared.has(rule.name)) changes.push({ action: "delete", name: rule.name, differences: [], note: rule.status });
	}

	const counts = { create: 0, replace: 0, delete: 0, pause: 0, resume: 0, unchanged: 0 } satisfies Record<Action, number>;
	for (const change of changes) counts[change.action]++;
	return { changes, counts };
}

export const hasChanges = (p: Plan): boolean => p.changes.some((change) => change.action !== "unchanged");

const ICON: Record<Action, string> = { create: "➕", replace: "✏️", delete: "🗑️", pause: "⏸️", resume: "▶️", unchanged: "✔️" };

export const PLAN_MARKER = "<!-- somework-rules-plan -->";

/** The pull request comment: what applying the rules directory would do to the domain. */
export function toMarkdown(p: Plan, options: { dryRun?: boolean } = {}): string {
	const changed = p.changes.filter((change) => change.action !== "unchanged");
	const lines = [PLAN_MARKER, "### Rules plan", ""];
	if (changed.length === 0) {
		lines.push(`No changes: the ${p.counts.unchanged} declared rule(s) match the domain.`);
		return lines.join("\n");
	}
	lines.push(
		Object.entries(p.counts)
			.filter(([, count]) => count > 0)
			.map(([action, count]) => `**${count}** ${action}`)
			.join(" · "),
		"",
	);
	lines.push("| | Rule | Change |", "|---|---|---|");
	for (const change of changed) lines.push(`| ${ICON[change.action]} | \`${change.name}\` | ${change.action}${change.note ? ` (${change.note})` : ""} |`);
	for (const change of changed.filter((entry) => entry.differences.length > 0)) {
		lines.push("", `<details><summary><code>${change.name}</code> differences</summary>`, "", "```", ...change.differences, "```", "", "</details>");
	}
	if (p.counts.delete > 0) lines.push("", `⚠️ ${p.counts.delete} rule(s) exist in the domain but no file declares them; applying deletes them.`);
	if (options.dryRun) lines.push("", "_Dry run: nothing was changed._");
	return lines.join("\n");
}

import { redactText } from "@somework/agent-kit";
import type { IssuedRefs } from "./datadog/tools.ts";

export const OUTCOMES = ["diagnosed", "inconclusive", "noise"] as const;
export const SEVERITIES = ["info", "low", "medium", "high", "critical"] as const;
export const CONFIDENCES = ["low", "medium", "high"] as const;
export const EVIDENCE_KINDS = ["monitor", "logs", "metrics", "events", "analysis"] as const;
export type Outcome = (typeof OUTCOMES)[number];
export type Severity = (typeof SEVERITIES)[number];
export type Confidence = (typeof CONFIDENCES)[number];

export interface Evidence {
	kind: (typeof EVIDENCE_KINDS)[number];
	query?: string;
	finding: string;
	refs: string[];
	inference?: boolean;
}

export interface Triage {
	outcome: Outcome;
	severity: Severity;
	summary: string;
	suspectedCause?: string;
	confidence: Confidence;
	timeline: { at: string; note: string }[];
	evidence: Evidence[];
	recommendedActions: string[];
	warnings?: string[];
}

export const LIMITS = { summary: 1200, cause: 800, timeline: 10, evidence: 12, actions: 6, note: 300, finding: 600, query: 600, action: 300, at: 40, refs: 5, ref: 80 } as const;

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** The structured result is the last fenced ```json block; without a fence, the outermost `{...}` of the text. Prose around it is ignored. */
export function extractJson(text: string): unknown | undefined {
	const fences = [...text.matchAll(/```(?:json|JSON)?[ \t]*\r?\n([\s\S]*?)```/g)].map((match) => match[1]!);
	for (const body of fences.reverse()) {
		const parsed = tryParse(body);
		if (parsed !== undefined) return parsed;
	}
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	return start >= 0 && end > start ? tryParse(text.slice(start, end + 1)) : undefined;
}

function tryParse(text: string): unknown | undefined {
	try {
		const value = JSON.parse(text.trim());
		return isObject(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const clean = (text: string): string => redactText(text.replace(CONTROL, " ")).trim();

export type Parsed = { ok: true; triage: Triage; truncated: boolean } | { ok: false; problems: string[] };

/** The shape of the model's answer: what is wrong with it (all of it, so one repair turn can fix everything), or the clean result. */
export function validateTriage(value: unknown): Parsed {
	if (!isObject(value)) return { ok: false, problems: ["the answer is not a json object"] };
	const problems: string[] = [];
	let truncated = false;
	const cut = (text: string, max: number): string => {
		if (text.length <= max) return text;
		truncated = true;
		return `${text.slice(0, max - 1)}…`;
	};
	const required = (field: unknown, name: string, max: number): string => {
		if (typeof field !== "string" || field.trim() === "") {
			problems.push(`${name} is required and must be a non-empty string`);
			return "";
		}
		return cut(clean(field), max);
	};
	const one = <T extends string>(field: unknown, name: string, allowed: readonly T[]): T => {
		if (!allowed.includes(field as T)) problems.push(`${name} must be one of ${allowed.join(", ")}`);
		return field as T;
	};

	const outcome = one(value.outcome, "outcome", OUTCOMES);
	const severity = one(value.severity, "severity", SEVERITIES);
	const confidence = one(value.confidence, "confidence", CONFIDENCES);
	const summary = required(value.summary, "summary", LIMITS.summary);
	let suspectedCause: string | undefined;
	if (value.suspectedCause !== undefined && value.suspectedCause !== null && value.suspectedCause !== "") suspectedCause = required(value.suspectedCause, "suspectedCause", LIMITS.cause);
	if (outcome === "diagnosed" && !suspectedCause) problems.push("suspectedCause is required when outcome is diagnosed (use inconclusive when there is no supported cause)");

	const list = (field: unknown, name: string): unknown[] => {
		if (!Array.isArray(field)) {
			problems.push(`${name} must be an array (empty when there is nothing)`);
			return [];
		}
		return field;
	};
	const timeline = list(value.timeline, "timeline").flatMap((entry, index) => {
		if (!isObject(entry) || typeof entry.at !== "string" || typeof entry.note !== "string" || entry.note.trim() === "") {
			problems.push(`timeline[${index}] must be {at, note}`);
			return [];
		}
		return [{ at: cut(clean(entry.at), LIMITS.at), note: cut(clean(entry.note), LIMITS.note) }];
	});
	const evidence = list(value.evidence, "evidence").flatMap((entry, index): Evidence[] => {
		if (!isObject(entry) || typeof entry.finding !== "string" || entry.finding.trim() === "") {
			problems.push(`evidence[${index}] must be {kind, query?, finding, refs, inference?}`);
			return [];
		}
		if (!EVIDENCE_KINDS.includes(entry.kind as never)) problems.push(`evidence[${index}].kind must be one of ${EVIDENCE_KINDS.join(", ")}`);
		const refs = Array.isArray(entry.refs) ? entry.refs.filter((ref): ref is string => typeof ref === "string" && ref.trim() !== "").map((ref) => ref.trim().slice(0, LIMITS.ref)).slice(0, LIMITS.refs) : [];
		return [
			{
				kind: entry.kind as Evidence["kind"],
				...(typeof entry.query === "string" && entry.query.trim() !== "" ? { query: cut(clean(entry.query), LIMITS.query) } : {}),
				finding: cut(clean(entry.finding), LIMITS.finding),
				refs,
				...(entry.inference === true ? { inference: true } : {}),
			},
		];
	});
	const recommendedActions = list(value.recommendedActions, "recommendedActions").flatMap((action, index) => {
		if (typeof action !== "string" || action.trim() === "") {
			problems.push(`recommendedActions[${index}] must be a non-empty string`);
			return [];
		}
		return [cut(clean(action), LIMITS.action)];
	});
	if (timeline.length > LIMITS.timeline || evidence.length > LIMITS.evidence || recommendedActions.length > LIMITS.actions) truncated = true;
	if (problems.length > 0) return { ok: false, problems: problems.slice(0, 12) };
	return {
		ok: true,
		truncated,
		triage: {
			outcome,
			severity,
			summary,
			...(suspectedCause ? { suspectedCause } : {}),
			confidence,
			timeline: timeline.slice(0, LIMITS.timeline),
			evidence: evidence.slice(0, LIMITS.evidence),
			recommendedActions: recommendedActions.slice(0, LIMITS.actions),
		},
	};
}

/** Findings that cite nothing real and are not marked as inference: one line each, for the repair turn. */
export function evidenceProblems(triage: Triage, issued: Pick<IssuedRefs, "has">): string[] {
	return triage.evidence.flatMap((item, index) => {
		if (item.inference) return [];
		if (item.refs.length === 0) return [`evidence[${index}] cites no tool call: add the "ref:" of the call it comes from, or set "inference": true`];
		const unknown = item.refs.find((ref) => !issued.has(ref));
		return unknown ? [`evidence[${index}] cites "${unknown.slice(0, 40)}", which no tool call of yours returned`] : [];
	});
}

/** What the service does with findings that still cite nothing real after the repair turn: they stay, labelled as inference, with a warning. */
export function markUnverified(triage: Triage, issued: Pick<IssuedRefs, "has">): Triage {
	let marked = 0;
	const evidence = triage.evidence.map((item) => {
		if (item.inference || (item.refs.length > 0 && item.refs.every((ref) => issued.has(ref)))) return item;
		marked += 1;
		return { ...item, refs: item.refs.filter((ref) => issued.has(ref)), inference: true };
	});
	if (marked === 0) return triage;
	return { ...triage, evidence, warnings: [...(triage.warnings ?? []), `${marked} evidence item(s) cited no tool call the service could verify and were marked as inference`] };
}

export type TriageOutcome = { ok: true; triage: Triage; truncated: boolean; repaired: boolean } | { ok: false; reason: string; raw: string };

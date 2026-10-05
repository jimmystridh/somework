export const VERDICTS = ["verified", "not_fixed", "blocked", "skipped"] as const;
export type Verdict = (typeof VERDICTS)[number];
/** What the model may report. `skipped` is the service's own decision (a ticket key the agent does not handle). */
export const MODEL_VERDICTS = ["verified", "not_fixed", "blocked"] as const;

export interface AcceptanceCheck {
	criterion: string;
	passed: boolean;
	evidence?: string;
}

export interface Fixture {
	description: string;
	keys?: string;
}

/** What the model reports at the end (the card's result without what the service adds: evidence artifacts, Jira flags, usage). */
export interface QaReport {
	verdict: Verdict;
	acceptanceChecks: AcceptanceCheck[];
	fixtures: Fixture[];
	notes: string;
	backendRevision?: string;
}

export const LIMITS = { checks: 40, fixtures: 40, criterion: 500, evidence: 1000, description: 500, keys: 500, notes: 6000, revision: 200 } as const;

export type Parsed = { ok: true; report: QaReport; truncated: boolean } | { ok: false; reason: string };

/** The structured report is the last fenced ```json block; without a fence, the outermost `{...}` of the text. */
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
		return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, max: number, flag: { cut: boolean }): string => {
	const string = typeof value === "string" ? value : "";
	if (string.length > max) flag.cut = true;
	return string.slice(0, max);
};

export function validateReport(value: unknown): Parsed {
	if (!isObject(value)) return { ok: false, reason: "the result is not a JSON object" };
	if (typeof value.verdict !== "string" || !(MODEL_VERDICTS as readonly string[]).includes(value.verdict)) return { ok: false, reason: `verdict must be one of ${MODEL_VERDICTS.join(", ")}` };
	const flag = { cut: false };
	const checksRaw = value.acceptanceChecks ?? [];
	if (!Array.isArray(checksRaw)) return { ok: false, reason: "acceptanceChecks must be a list" };
	const checks: AcceptanceCheck[] = [];
	for (const [index, check] of checksRaw.entries()) {
		if (!isObject(check) || typeof check.criterion !== "string" || check.criterion.trim() === "" || typeof check.passed !== "boolean") return { ok: false, reason: `acceptanceChecks[${index}] needs a criterion (text) and passed (true or false)` };
		checks.push({ criterion: text(check.criterion, LIMITS.criterion, flag), passed: check.passed, ...(typeof check.evidence === "string" && check.evidence ? { evidence: text(check.evidence, LIMITS.evidence, flag) } : {}) });
	}
	if (checks.length > LIMITS.checks) flag.cut = true;
	const fixturesRaw = value.fixtures ?? [];
	if (!Array.isArray(fixturesRaw)) return { ok: false, reason: "fixtures must be a list" };
	const fixtures: Fixture[] = [];
	for (const [index, fixture] of fixturesRaw.entries()) {
		if (!isObject(fixture) || typeof fixture.description !== "string" || fixture.description.trim() === "") return { ok: false, reason: `fixtures[${index}] needs a description (text)` };
		fixtures.push({ description: text(fixture.description, LIMITS.description, flag), ...(typeof fixture.keys === "string" && fixture.keys ? { keys: text(fixture.keys, LIMITS.keys, flag) } : {}) });
	}
	if (fixtures.length > LIMITS.fixtures) flag.cut = true;
	if (value.verdict === "verified" && (checks.length === 0 || checks.some((check) => !check.passed))) return { ok: false, reason: "a verified result needs at least one acceptance check and every check must have passed" };
	if (value.verdict === "not_fixed" && !checks.some((check) => !check.passed)) return { ok: false, reason: "a not_fixed result needs at least one failed acceptance check" };
	const notes = typeof value.notes === "string" ? value.notes : "";
	if (value.verdict !== "verified" && notes.trim() === "") return { ok: false, reason: "notes must explain a result that is not verified" };
	return {
		ok: true,
		truncated: flag.cut || notes.length > LIMITS.notes,
		report: {
			verdict: value.verdict as Verdict,
			acceptanceChecks: checks.slice(0, LIMITS.checks),
			fixtures: fixtures.slice(0, LIMITS.fixtures),
			notes: notes.slice(0, LIMITS.notes),
			...(typeof value.backendRevision === "string" && value.backendRevision ? { backendRevision: value.backendRevision.slice(0, LIMITS.revision) } : {}),
		},
	};
}

export const parseReport = (answer: string): Parsed => {
	const json = extractJson(answer);
	return json === undefined ? { ok: false, reason: "no JSON result block found (end the answer with a fenced json block)" } : validateReport(json);
};

export const SEVERITIES = ["P0", "P1", "P2", "P3"] as const;
export type Severity = (typeof SEVERITIES)[number];
export const VERDICTS = ["approve", "request_changes", "needs_clarification"] as const;
export type Verdict = (typeof VERDICTS)[number];

export interface Finding {
	severity: Severity;
	file?: string;
	line?: number;
	title: string;
	detail: string;
	suggestion?: string;
}

export interface DraftComment {
	file: string;
	line: number;
	body: string;
}

export interface Review {
	verdict: Verdict;
	summary: string;
	findings: Finding[];
	openQuestions: string[];
	checked: string[];
	residualRisk?: string;
	draftComments?: DraftComment[];
}

/** Limits that keep a task result small and a runaway answer harmless. Anything over them is cut, and `truncated` says so. */
export const LIMITS = { findings: 50, draftComments: 30, openQuestions: 20, checked: 30, summary: 4000, title: 200, detail: 4000, suggestion: 2000, question: 500, checkedItem: 300, residualRisk: 2000, commentBody: 4000, path: 500 } as const;

export type Parsed = { ok: true; review: Review; truncated: boolean } | { ok: false; reason: string };

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
		return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

export function validateReview(value: unknown): Parsed {
	if (!isObject(value)) return { ok: false, reason: "the result is not a JSON object" };
	let truncated = false;
	const cut = (text: string, max: number): string => {
		if (text.length <= max) return text;
		truncated = true;
		return `${text.slice(0, max - 1)}…`;
	};
	const text = (field: unknown, name: string, max: number, required = true): string | undefined | Error => {
		if (field === undefined || field === null) return required ? new Error(`${name} is required`) : undefined;
		if (typeof field !== "string") return new Error(`${name} must be a string`);
		if (required && field.trim() === "") return new Error(`${name} must not be empty`);
		return cut(field, max);
	};
	const fail = (error: Error): Parsed => ({ ok: false, reason: error.message });

	if (!VERDICTS.includes(value.verdict as Verdict)) return { ok: false, reason: `verdict must be one of ${VERDICTS.join(", ")}` };
	const summary = text(value.summary, "summary", LIMITS.summary);
	if (summary instanceof Error) return fail(summary);

	if (!Array.isArray(value.findings)) return { ok: false, reason: "findings must be an array (empty when there are none)" };
	const findings: Finding[] = [];
	for (const [index, raw] of value.findings.entries()) {
		const where = `findings[${index}]`;
		if (!isObject(raw)) return { ok: false, reason: `${where} must be an object` };
		if (!SEVERITIES.includes(raw.severity as Severity)) return { ok: false, reason: `${where}.severity must be one of ${SEVERITIES.join(", ")}` };
		const title = text(raw.title, `${where}.title`, LIMITS.title);
		if (title instanceof Error) return fail(title);
		const detail = text(raw.detail, `${where}.detail`, LIMITS.detail);
		if (detail instanceof Error) return fail(detail);
		const file = text(raw.file, `${where}.file`, LIMITS.path, false);
		if (file instanceof Error) return fail(file);
		const suggestion = text(raw.suggestion, `${where}.suggestion`, LIMITS.suggestion, false);
		if (suggestion instanceof Error) return fail(suggestion);
		if (raw.line !== undefined && raw.line !== null && !(Number.isInteger(raw.line) && (raw.line as number) >= 1)) return { ok: false, reason: `${where}.line must be a positive integer` };
		findings.push({ severity: raw.severity as Severity, title: title!, detail: detail!, ...(file ? { file } : {}), ...(typeof raw.line === "number" ? { line: raw.line } : {}), ...(suggestion ? { suggestion } : {}) });
	}
	// most severe first, stable inside a severity; then the size cap drops the least severe
	const ordered = findings.map((finding, index) => ({ finding, index })).sort((a, b) => SEVERITIES.indexOf(a.finding.severity) - SEVERITIES.indexOf(b.finding.severity) || a.index - b.index).map(({ finding }) => finding);
	if (ordered.length > LIMITS.findings) truncated = true;
	const kept = ordered.slice(0, LIMITS.findings);
	if (value.verdict === "approve" && kept.some((finding) => finding.severity === "P0" || finding.severity === "P1")) return { ok: false, reason: "verdict approve contradicts the P0/P1 findings: use request_changes, or lower the severity of a finding that is not blocking" };

	const list = (field: unknown, name: string, maxItems: number, maxText: number): string[] | Error => {
		if (field === undefined || field === null) return [];
		if (!Array.isArray(field) || field.some((item) => typeof item !== "string")) return new Error(`${name} must be an array of strings`);
		if (field.length > maxItems) truncated = true;
		return (field as string[]).slice(0, maxItems).map((item) => cut(item, maxText));
	};
	const openQuestions = list(value.openQuestions, "openQuestions", LIMITS.openQuestions, LIMITS.question);
	if (openQuestions instanceof Error) return fail(openQuestions);
	const checked = list(value.checked, "checked", LIMITS.checked, LIMITS.checkedItem);
	if (checked instanceof Error) return fail(checked);
	const residualRisk = text(value.residualRisk, "residualRisk", LIMITS.residualRisk, false);
	if (residualRisk instanceof Error) return fail(residualRisk);

	let draftComments: DraftComment[] | undefined;
	if (value.draftComments !== undefined && value.draftComments !== null) {
		if (!Array.isArray(value.draftComments)) return { ok: false, reason: "draftComments must be an array" };
		if (value.draftComments.length > LIMITS.draftComments) truncated = true;
		draftComments = [];
		for (const [index, raw] of value.draftComments.slice(0, LIMITS.draftComments).entries()) {
			const where = `draftComments[${index}]`;
			if (!isObject(raw) || typeof raw.file !== "string" || !Number.isInteger(raw.line) || (raw.line as number) < 1 || typeof raw.body !== "string" || raw.body.trim() === "") return { ok: false, reason: `${where} needs file (string), line (positive integer) and body (string)` };
			draftComments.push({ file: cut(raw.file, LIMITS.path), line: raw.line as number, body: cut(raw.body, LIMITS.commentBody) });
		}
	}

	return { ok: true, truncated, review: { verdict: value.verdict as Verdict, summary: summary!, findings: kept, openQuestions, checked, ...(residualRisk ? { residualRisk } : {}), ...(draftComments && draftComments.length > 0 ? { draftComments } : {}) } };
}

/** What the model's final answer is turned into, or why it could not be. */
export function parseReview(answer: string): Parsed {
	const value = extractJson(answer);
	if (value === undefined) return { ok: false, reason: "the answer has no JSON result: end it with one fenced ```json block" };
	return validateReview(value);
}

const HEADLINE: Record<Verdict, string> = { approve: "Approve", request_changes: "Request changes", needs_clarification: "Needs clarification" };

/** The report that is attached to the task: the same content as the result, written for a human. */
export function renderReport(review: Review, meta: { repository: string; ref: string; pullRequest?: number; ticket?: string; taskId: string; truncated?: boolean }): string {
	const lines: string[] = [`# Review: ${HEADLINE[review.verdict]}`, ""];
	lines.push(`- Repository: ${meta.repository} @ ${meta.ref}`);
	if (meta.pullRequest !== undefined) lines.push(`- Pull request: #${meta.pullRequest}`);
	if (meta.ticket) lines.push(`- Ticket: ${meta.ticket}`);
	lines.push(`- Task: ${meta.taskId}`, "", "## Summary", "", review.summary, "");
	lines.push("## Findings", "");
	if (review.findings.length === 0) lines.push("No findings.", "");
	for (const finding of review.findings) {
		const place = finding.file ? ` \`${finding.file}${finding.line ? `:${finding.line}` : ""}\`` : "";
		lines.push(`### [${finding.severity}] ${finding.title}${place}`, "", finding.detail, "");
		if (finding.suggestion) lines.push(`Suggested direction: ${finding.suggestion}`, "");
	}
	if (review.openQuestions.length > 0) lines.push("## Open questions", "", ...review.openQuestions.map((question) => `- ${question}`), "");
	if (review.checked.length > 0) lines.push("## What was checked", "", ...review.checked.map((item) => `- ${item}`), "");
	if (review.residualRisk) lines.push("## Residual risk", "", review.residualRisk, "");
	if (review.draftComments?.length) {
		lines.push("## Draft comments (not posted)", "");
		for (const comment of review.draftComments) lines.push(`**\`${comment.file}:${comment.line}\`**`, "", comment.body, "");
	}
	if (meta.truncated) lines.push("_Some findings or text were cut to the size limits._", "");
	return lines.join("\n");
}

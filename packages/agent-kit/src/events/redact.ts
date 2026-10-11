/** Token-like strings and secrets in text that is about to be logged or shown to the model. */
const PATTERNS: [RegExp, string][] = [
	[/\b(?:ghp|gho|ghs|ghu|github_pat|xox[abprs]|xapp|sk|AKIA)[-_A-Za-z0-9]{8,}/g, "[redacted]"],
	[/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, "[redacted]"],
	[/\b(authorization|bearer|token|secret|password|api[_-]?key)(["'\s:=]+)([^\s"',;]{8,})/gi, "$1$2[redacted]"],
];

export function redactText(text: string): string {
	return PATTERNS.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), text);
}

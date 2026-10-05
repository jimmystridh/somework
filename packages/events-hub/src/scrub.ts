import type { Json } from "./types.ts";

/** The same credential patterns the agents' build logs use. An event is read by agents and sent to a model, so anything that looks like a
 * credential is replaced before it is published, whatever the mapping let through. */
const PATTERNS: [RegExp, string][] = [
	[/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED private key]"],
	[/\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,})\b/g, "[REDACTED token]"],
	[/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED token]"],
	[/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED token]"],
	[/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, "[REDACTED token]"],
	[/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[REDACTED jwt]"],
	[/\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "[REDACTED authorization]"],
	[/https?:\/\/[^/@\s:]+:[^/@\s]+@/g, "https://[REDACTED]@"],
	[/((?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret|authorization)["']?\s*[:=]\s*["']?)[^\s"',;&]{4,}/gi, "$1[REDACTED]"],
];

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

export function scrubText(text: string): string {
	let out = text.replace(CONTROL, "");
	for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
	return out;
}

export function scrubValue(value: Json): Json {
	if (typeof value === "string") return scrubText(value);
	if (Array.isArray(value)) return value.map(scrubValue);
	if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubValue(v)]));
	return value;
}

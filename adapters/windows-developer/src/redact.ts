const MIN_SECRET_LENGTH = 8;

const PATTERNS: [RegExp, string][] = [
	[/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED private key]"],
	[/\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,})\b/g, "[REDACTED token]"],
	[/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED token]"],
	[/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED token]"],
	[/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[REDACTED jwt]"],
	[/\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "[REDACTED authorization]"],
	[/https?:\/\/[^/@\s:]+:[^/@\s]+@/g, "https://[REDACTED]@"],
	[/((?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret|authorization)["']?\s*[:=]\s*["']?)[^\s"',;&]{4,}/gi, "$1[REDACTED]"],
];

/**
 * Build and test output goes to an artifact other agents and people read. Anything that looks like a credential is replaced first,
 * and so is every literal secret the service itself holds (`secrets`), whatever it looks like.
 */
export function redactLog(text: string, secrets: readonly string[] = []): string {
	let out = text;
	for (const secret of secrets) if (secret.length >= MIN_SECRET_LENGTH) out = out.split(secret).join("[REDACTED]");
	for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
	return out;
}

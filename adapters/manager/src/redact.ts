const SECRET_VALUE = /(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|\d{8,12}:[A-Za-z0-9_-]{30,}|eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|AKIA[A-Z0-9]{16})/g;

export function scrub(text: string): string {
	return text.replace(SECRET_VALUE, "[redacted]");
}

/** Sizes only: what the gateway logs about a payload. */
export const sizeOf = (value: unknown): number => Buffer.byteLength(JSON.stringify(value ?? null));

export const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}...` : text);

/**
 * Text that came from outside (an alert title, a ticket summary, another agent's message) made safe to show the owner: secret-looking
 * values hidden, control characters and line breaks flattened, and every `/word` that Telegram would render as a tappable bot command
 * given a look-alike slash, so a crafted title cannot put `/approve <id>` one tap away.
 */
export function defang(text: string): string {
	return scrub(text)
		.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ")
		.replace(/(^|[\s([{"'])\/(?=[A-Za-z0-9_])/g, "$1\u2215")
		.trim();
}

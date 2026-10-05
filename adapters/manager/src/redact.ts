const SECRET_KEY = /(token|secret|password|passwd|authorization|api[_-]?key|credential|private[_-]?key)/i;
const SECRET_VALUE = /(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|\d{8,12}:[A-Za-z0-9_-]{30,}|eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|AKIA[A-Z0-9]{16})/g;

const cut = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}... [${text.length} chars]` : text);

export function scrub(text: string): string {
	return text.replace(SECRET_VALUE, "[redacted]");
}

/** A short, human-checkable rendering of a task input for the approval prompt: secrets hidden, long values cut. */
export function summarizeInput(input: unknown, maxTotal = 700, maxValue = 240): string {
	if (input === null || typeof input !== "object") return cut(scrub(String(input)), maxValue);
	const lines = Object.entries(input as Record<string, unknown>).map(([key, value]) => {
		if (SECRET_KEY.test(key)) return `${key}: [redacted]`;
		const rendered = typeof value === "string" ? value : JSON.stringify(value);
		return `${key}: ${cut(scrub(rendered ?? ""), maxValue)}`;
	});
	return cut(lines.join("\n"), maxTotal);
}

/** Sizes only: what the gateway logs about a payload. */
export const sizeOf = (value: unknown): number => Buffer.byteLength(JSON.stringify(value ?? null));

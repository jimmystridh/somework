/** Structured logs with identifiers and counts only. Coding-agent telemetry easily contains source code and secrets, so any field
 * that could carry content is redacted by name, and long strings are cut. */
const CONTENT_FIELDS = /^(prompt|instruction|content|text|output|stdout|stderr|answer|arguments|args|command|diff|patch|token|secret|password|authorization|apikey|key|env)$/i;
const MAX_STRING = 200;

export type LogFields = Record<string, unknown>;
export type Log = (level: "debug" | "info" | "warn" | "error", event: string, fields?: LogFields) => void;

export function redact(fields: LogFields = {}): LogFields {
	const out: LogFields = {};
	for (const [name, value] of Object.entries(fields)) {
		if (CONTENT_FIELDS.test(name)) out[name] = "[redacted]";
		else if (typeof value === "string") out[name] = value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}...[${value.length} chars]` : value;
		else if (value instanceof Error) out[name] = value.message.slice(0, MAX_STRING);
		else if (value !== null && typeof value === "object") out[name] = "[object]";
		else out[name] = value;
	}
	return out;
}

export function jsonLogger(write: (line: string) => void = (line) => process.stderr.write(`${line}\n`)): Log {
	return (level, event, fields) => write(JSON.stringify({ ts: new Date().toISOString(), level, event, ...redact(fields) }));
}

export const silent: Log = () => {};

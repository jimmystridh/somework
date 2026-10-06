/**
 * A strict, small LogQL reader. The model writes the query text; the service never forwards it: it is parsed into a tiny syntax tree of the
 * only things the observe tools allow (a stream selector of allowed labels, line filters, `| json`, simple label filters and, if the
 * profile allows, `count_over_time`/`rate` over one log stream) and the text sent to Loki is built again from that tree. Anything else is
 * refused with a reason the model can act on.
 */

export const ALLOWED_LABELS = ["cluster", "host", "vm_id", "os", "source", "service_name", "container", "role", "level", "event"] as const;

export type MatcherOp = "=" | "!=" | "=~" | "!~";
export interface Matcher {
	label: string;
	op: MatcherOp;
	value: string;
}

export type Stage =
	| { kind: "line"; op: "|=" | "!=" | "|~" | "!~"; value: string }
	| { kind: "json" }
	| { kind: "label"; name: string; op: "=" | "!=" | "=~" | "!~" | ">" | ">=" | "<" | "<="; value: string | number };

export interface LogQuery {
	matchers: Matcher[];
	stages: Stage[];
	/** Set for count_over_time / rate. */
	metric?: { fn: "count_over_time" | "rate"; windowMs: number };
}

export class QueryRefused extends Error {
	override readonly name = "QueryRefused";
}

const MAX_STRING = 300;
const MAX_STAGES = 8;
const MAX_MATCHERS = 8;
const DURATION = /^([0-9]{1,4})(s|m|h|d)$/;
const UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

export function parseDuration(text: string): number {
	const m = DURATION.exec(String(text).trim());
	if (!m) throw new QueryRefused(`'${String(text).slice(0, 20)}' is not a duration (use for example 15m, 2h, 1d)`);
	return Number(m[1]) * UNIT_MS[m[2] as keyof typeof UNIT_MS];
}

class Reader {
	pos = 0;
	readonly text: string;
	constructor(text: string) {
		this.text = text;
	}
	skip(): void {
		while (this.pos < this.text.length && /\s/.test(this.text[this.pos]!)) this.pos++;
	}
	peek(): string {
		this.skip();
		return this.text[this.pos] ?? "";
	}
	done(): boolean {
		this.skip();
		return this.pos >= this.text.length;
	}
	take(token: string): boolean {
		this.skip();
		if (this.text.startsWith(token, this.pos)) {
			this.pos += token.length;
			return true;
		}
		return false;
	}
	expect(token: string, what: string): void {
		if (!this.take(token)) throw new QueryRefused(`expected ${what} at position ${this.pos}`);
	}
	word(): string {
		this.skip();
		const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.text.slice(this.pos));
		if (!m) throw new QueryRefused(`expected a name at position ${this.pos}`);
		this.pos += m[0].length;
		return m[0];
	}
	string(): string {
		this.skip();
		const opening = this.text[this.pos];
		if (opening === "`") {
			const end = this.text.indexOf("`", this.pos + 1);
			if (end < 0) throw new QueryRefused("an unterminated ` string");
			const value = this.text.slice(this.pos + 1, end);
			this.pos = end + 1;
			return this.checked(value);
		}
		if (opening !== '"') throw new QueryRefused(`expected a quoted string at position ${this.pos}`);
		let out = "";
		for (let i = this.pos + 1; i < this.text.length; i++) {
			const ch = this.text[i]!;
			if (ch === '"') {
				this.pos = i + 1;
				return this.checked(out);
			}
			if (ch === "\\") {
				const next = this.text[++i];
				if (next === undefined) break;
				out += next === "n" ? "\n" : next === "t" ? "\t" : next;
			} else out += ch;
		}
		throw new QueryRefused("an unterminated string");
	}
	number(): number | undefined {
		this.skip();
		const m = /^-?[0-9]+(\.[0-9]+)?/.exec(this.text.slice(this.pos));
		if (!m) return undefined;
		this.pos += m[0].length;
		return Number(m[0]);
	}
	private checked(value: string): string {
		if (value.length > MAX_STRING) throw new QueryRefused(`a string is longer than ${MAX_STRING} characters`);
		return value;
	}
}

const EVERYTHING = /^\^?(\(\?s\))?(\.\*|\.\+|\(\.\*\)|\(\.\+\)|\.\*\.\*)\$?$/;
export const matchesEverything = (value: string): boolean => value === "" || EVERYTHING.test(value);

function readMatchers(r: Reader): Matcher[] {
	r.expect("{", "{ to start the stream selector");
	const matchers: Matcher[] = [];
	for (;;) {
		if (r.peek() === "}") break;
		const label = r.word();
		if (!(ALLOWED_LABELS as readonly string[]).includes(label)) throw new QueryRefused(`the label '${label}' is not available (allowed: ${ALLOWED_LABELS.join(", ")})`);
		const op = (["=~", "!~", "!=", "="] as const).find((candidate) => r.take(candidate));
		if (!op) throw new QueryRefused(`expected =, !=, =~ or !~ after ${label}`);
		matchers.push({ label, op, value: r.string() });
		if (matchers.length > MAX_MATCHERS) throw new QueryRefused(`more than ${MAX_MATCHERS} matchers in the selector`);
		if (!r.take(",")) break;
	}
	r.expect("}", "} to end the stream selector");
	if (matchers.length === 0) throw new QueryRefused("the stream selector is empty");
	return matchers;
}

function readStages(r: Reader): Stage[] {
	const stages: Stage[] = [];
	for (;;) {
		const start = r.pos;
		let stage: Stage | undefined;
		if (r.take("|=")) stage = { kind: "line", op: "|=", value: r.string() };
		else if (r.take("|~")) stage = { kind: "line", op: "|~", value: r.string() };
		else if (r.take("!~")) stage = { kind: "line", op: "!~", value: r.string() };
		else if (r.take("!=")) stage = { kind: "line", op: "!=", value: r.string() };
		else if (r.take("|")) {
			const name = r.word();
			if (name === "json") {
				const next = r.peek();
				if (next !== "|" && next !== "!" && next !== "" && next !== "[" && next !== ")") throw new QueryRefused("`| json` takes no arguments here");
				stage = { kind: "json" };
			} else {
				const op = ([">=", "<=", "=~", "!~", "!=", ">", "<", "="] as const).find((candidate) => r.take(candidate));
				if (!op) throw new QueryRefused(`after '| ${name}' expected a comparison (for example | status="done" or | totalTokens > 1000); other pipeline stages are not available`);
				if (r.peek() === '"' || r.peek() === "`") {
					if (op === ">" || op === ">=" || op === "<" || op === "<=") throw new QueryRefused("numeric comparisons need a number");
					stage = { kind: "label", name, op, value: r.string() };
				} else {
					const value = r.number();
					if (value === undefined) throw new QueryRefused(`expected a string or a number after ${name} ${op}`);
					if (op === "=~" || op === "!~") throw new QueryRefused("regular expressions need a quoted string");
					stage = { kind: "label", name, op, value };
				}
			}
		}
		if (!stage) {
			r.pos = start;
			return stages;
		}
		const pattern = stage.kind === "line" ? (stage.op === "|~" || stage.op === "!~" ? stage.value : "") : stage.kind === "label" && typeof stage.value === "string" && (stage.op === "=~" || stage.op === "!~") ? stage.value : "";
		if (pattern.length > 200) throw new QueryRefused("a regular expression is longer than 200 characters");
		stages.push(stage);
		if (stages.length > MAX_STAGES) throw new QueryRefused(`more than ${MAX_STAGES} filters`);
	}
}

export interface ParseOptions {
	/** `count_over_time` and `rate` over one log stream (the profile decides). */
	allowMetricFunctions: boolean;
	/** The longest window of a metric function. */
	maxWindowMs: number;
}

export function parseLogQuery(text: string, options: ParseOptions): LogQuery {
	const source = String(text ?? "").trim();
	if (source === "") throw new QueryRefused("the query is empty");
	if (source.length > 1500) throw new QueryRefused("the query is longer than 1500 characters");
	const r = new Reader(source);
	let metric: LogQuery["metric"];
	const fn = /^(count_over_time|rate)\s*\(/.exec(source);
	if (fn) {
		if (!options.allowMetricFunctions) throw new QueryRefused("count_over_time and rate are not enabled for this agent: ask for log lines instead");
		r.pos = fn[0].length;
	} else if (/^[A-Za-z_]/.test(source)) {
		throw new QueryRefused(`only a stream selector such as {container="x"} with optional filters is allowed${options.allowMetricFunctions ? ", or count_over_time/rate over one" : ""}`);
	}
	const matchers = readMatchers(r);
	const stages = readStages(r);
	if (fn) {
		r.expect("[", "[window] after the log filters");
		const window = /^[0-9]{1,4}[smhd]/.exec(r.text.slice(r.pos));
		if (!window) throw new QueryRefused("expected a window such as [5m]");
		r.pos += window[0].length;
		if (r.peek() === ":") throw new QueryRefused("sub-queries are not available");
		r.expect("]", "] after the window");
		r.expect(")", ") to close the function");
		const windowMs = parseDuration(window[0]);
		if (windowMs > options.maxWindowMs) throw new QueryRefused("the window is longer than this agent may look back");
		metric = { fn: fn[1] as "count_over_time" | "rate", windowMs };
	}
	if (!r.done()) throw new QueryRefused(`unexpected text at position ${r.pos}: ${r.text.slice(r.pos, r.pos + 20)} (offset, by, without, aggregations, binary operators and other stages are not available)`);
	checkSelector(matchers);
	return { matchers, stages, ...(metric ? { metric } : {}) };
}

/** A selector must be able to be narrow: some positive matcher that is not a match-everything pattern (`{level="error"}` is fine, `{host=~".+"}` is not). */
export function checkSelector(matchers: readonly Matcher[]): void {
	const useful = matchers.filter((m) => (m.op === "=" || m.op === "=~") && !matchesEverything(m.value));
	if (useful.length === 0) throw new QueryRefused("the selector would match every stream: name a service_name, container, host, role, source, event or level");
	for (const m of matchers) if ((m.op === "=~" || m.op === "!~") && m.value.length > 200) throw new QueryRefused("a regular expression is longer than 200 characters");
}

const quote = (value: string): string => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\t/g, "\\t")}"`;

export function renderSelector(matchers: readonly Matcher[]): string {
	return `{${matchers.map((m) => `${m.label}${m.op}${quote(m.value)}`).join(", ")}}`;
}

export function renderStage(stage: Stage): string {
	if (stage.kind === "json") return "| json";
	if (stage.kind === "line") return `${stage.op} ${quote(stage.value)}`;
	return `| ${stage.name} ${stage.op} ${typeof stage.value === "number" ? String(stage.value) : quote(stage.value)}`;
}

/** The text sent to Loki: rebuilt from the tree, with the role's own scope matchers added to the selector. */
export function renderQuery(query: LogQuery, scope: readonly Matcher[] = []): string {
	const body = `${renderSelector([...query.matchers, ...scope])}${query.stages.map((stage) => ` ${renderStage(stage)}`).join("")}`;
	return query.metric ? `${query.metric.fn}(${body} [${Math.max(1, Math.round(query.metric.windowMs / 1000))}s])` : body;
}

/** `container=~"a.*", host="x"` (the form used in configuration) to matchers. */
export function parseMatcherList(text: string): Matcher[] {
	const r = new Reader(`{${text}}`);
	const matchers = readMatchers(r);
	if (!r.done()) throw new QueryRefused("unexpected text after the matchers");
	return matchers;
}

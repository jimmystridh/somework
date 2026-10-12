/**
 * A reader for shell command lines, built for classification: it does not run anything and does not try to be a complete shell. It turns
 * a command line into the simple commands that would run (words with quotes removed, redirections, here-document text), looking inside
 * everything that executes: `$(...)`, backticks, `<(...)`, subshells, braces, `if`/`for`/`while`/`case` bodies, function bodies and
 * here-documents. A word whose value cannot be known (an unset variable, a command substitution that is not a plain `echo`) is marked
 * `dynamic`. Anything the reader cannot follow is reported as a `problem`, which the classifier treats as destructive.
 */
export interface Word {
	text: string;
	/** The value depends on something the reader cannot evaluate (a variable, a substitution that computes). */
	dynamic: boolean;
}

export interface Redirect {
	op: string;
	fd?: string;
	target: Word;
}

export interface Command {
	words: Word[];
	redirects: Redirect[];
	/** Text the command reads on standard input when it is written in the command line: a here-document or a here-string. */
	stdinText?: string;
	/** `NAME=value` words in front of the command, or the whole command when nothing follows them. */
	assignments?: Word[];
	/** Commands joined by `|` share a pipeline number. */
	pipeline: number;
	index: number;
}

export interface Script {
	commands: Command[];
	functions: ReadonlySet<string>;
	problem?: string;
}

const MAX_DEPTH = 8;
const MAX_BRACE_RESULTS = 100;
const OPEN = "";
const CLOSE = "";
const COMMA = "";
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;
const KEYWORDS = new Set(["if", "then", "else", "elif", "do", "while", "until", "!", "{", "}", "fi", "done", "esac", "coproc"]);
const DECLARERS = new Set(["export", "declare", "local", "readonly", "typeset"]);

interface Builder {
	words: Word[];
	redirects: Redirect[];
	stdinText?: string;
	assignments?: Word[];
	pipeline?: number;
	index?: number;
}

interface State {
	vars: Map<string, Word>;
	functions: Set<string>;
	commands: Command[];
	pipeline: number;
	problem?: string;
}

const newBuilder = (): Builder => ({ words: [], redirects: [] });

/** The commands a command line runs. */
export function parseScript(source: string): Script {
	const state: State = { vars: new Map(), functions: new Set(), commands: [], pipeline: 0 };
	parseInto(source, state, 0);
	return { commands: state.commands, functions: state.functions, ...(state.problem ? { problem: state.problem } : {}) };
}

function fail(state: State, problem: string): void {
	state.problem ??= problem;
}

/** The index of the character that closes the group opened just before `start`, skipping quotes and nested groups; -1 when it is missing. */
function findClosing(src: string, start: number, open: string, close: string): number {
	let depth = 1;
	for (let i = start; i < src.length; i++) {
		const c = src[i]!;
		if (c === "\\") i++;
		else if (c === "'") {
			const end = src.indexOf("'", i + 1);
			if (end < 0) return -1;
			i = end;
		} else if (c === '"') {
			for (i++; i < src.length && src[i] !== '"'; i++) if (src[i] === "\\") i++;
		} else if (c === open) depth++;
		else if (c === close && --depth === 0) return i;
	}
	return -1;
}

function findBacktick(src: string, start: number): number {
	for (let i = start; i < src.length; i++) {
		if (src[i] === "\\") i++;
		else if (src[i] === "`") return i;
	}
	return -1;
}

const ANSI_ESCAPES: Record<string, string> = { n: "\n", t: "\t", r: "\r", a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", v: "\v", "\\": "\\", "'": "'", '"': '"', "?": "?" };

/** The text of `$'...'` starting after the opening quote; returns the decoded text and the index of the closing quote. */
function readAnsiC(src: string, start: number): { text: string; end: number } | undefined {
	let out = "";
	for (let i = start; i < src.length; i++) {
		const c = src[i]!;
		if (c === "'") return { text: out, end: i };
		if (c !== "\\") {
			out += c;
			continue;
		}
		const next = src[++i];
		if (next === undefined) return undefined;
		if (next === "x") {
			const hex = /^[0-9a-fA-F]{1,2}/.exec(src.slice(i + 1, i + 3));
			if (hex) {
				out += String.fromCharCode(parseInt(hex[0], 16));
				i += hex[0].length;
			} else out += "\\x";
		} else if (next === "u" || next === "U") {
			const hex = /^[0-9a-fA-F]{1,8}/.exec(src.slice(i + 1, i + (next === "u" ? 5 : 9)));
			if (hex) {
				out += String.fromCodePoint(Math.min(parseInt(hex[0], 16), 0x10ffff));
				i += hex[0].length;
			} else out += `\\${next}`;
		} else if (/[0-7]/.test(next)) {
			const octal = /^[0-7]{1,3}/.exec(src.slice(i, i + 3))![0];
			out += String.fromCharCode(parseInt(octal, 8));
			i += octal.length - 1;
		} else out += ANSI_ESCAPES[next] ?? `\\${next}`;
	}
	return undefined;
}

/** Expands unquoted `{a,b}` and `{1..3}` in a word; quoted braces carry private markers and are left alone. */
function expandBraces(text: string): string[] | undefined {
	const results: string[] = [];
	const walk = (word: string): boolean => {
		const open = word.indexOf("{");
		if (open < 0) {
			results.push(word);
			return results.length <= MAX_BRACE_RESULTS;
		}
		let depth = 0;
		let close = -1;
		const commas: number[] = [];
		for (let i = open; i < word.length; i++) {
			const c = word[i];
			if (c === "{") depth++;
			else if (c === "}" && --depth === 0) {
				close = i;
				break;
			} else if (c === "," && depth === 1) commas.push(i);
		}
		if (close < 0) {
			results.push(word);
			return true;
		}
		const body = word.slice(open + 1, close);
		const range = /^(-?\d+)\.\.(-?\d+)$/.exec(body) ?? /^([a-zA-Z])\.\.([a-zA-Z])$/.exec(body);
		let alternatives: string[] | undefined;
		if (commas.length > 0) {
			alternatives = [];
			let from = open + 1;
			for (const comma of [...commas, close]) {
				alternatives.push(word.slice(from, comma));
				from = comma + 1;
			}
		} else if (range) {
			const numeric = /^-?\d/.test(range[1]!);
			const a = numeric ? Number(range[1]) : range[1]!.charCodeAt(0);
			const b = numeric ? Number(range[2]) : range[2]!.charCodeAt(0);
			if (Math.abs(b - a) > MAX_BRACE_RESULTS) return false;
			alternatives = [];
			for (let n = a; a <= b ? n <= b : n >= b; n += a <= b ? 1 : -1) alternatives.push(numeric ? String(n) : String.fromCharCode(n));
		}
		if (!alternatives) {
			const rest = expandBraces(word.slice(close + 1));
			if (!rest) return false;
			for (const tail of rest) results.push(`${word.slice(0, close + 1)}${tail}`);
			return results.length <= MAX_BRACE_RESULTS;
		}
		for (const alternative of alternatives) if (!walk(`${word.slice(0, open)}${alternative}${word.slice(close + 1)}`)) return false;
		return true;
	};
	return walk(text) ? results : undefined;
}

const restoreMarkers = (text: string): string => text.split(OPEN).join("{").split(CLOSE).join("}").split(COMMA).join(",");
const quotedChar = (c: string): string => (c === "{" ? OPEN : c === "}" ? CLOSE : c === "," ? COMMA : c);

/** The value of a command substitution when it is only `echo words` or `printf text` of known words. */
function plainValue(commands: Command[]): string | undefined {
	if (commands.length !== 1) return undefined;
	const [command] = commands;
	if (command!.redirects.length > 0 || command!.stdinText !== undefined || command!.words.some((word) => word.dynamic)) return undefined;
	const [head, ...args] = command!.words.map((word) => word.text);
	if (head === "echo") return args.filter((arg) => !/^-[neE]+$/.test(arg)).join(" ");
	if (head === "printf" && args.length === 1 && !args[0]!.includes("%")) return args[0];
	return undefined;
}

function scanSubstitutions(text: string, state: State, depth: number): void {
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (c === "\\") i++;
		else if (c === "$" && text[i + 1] === "(" && text[i + 2] !== "(") {
			const end = findClosing(text, i + 2, "(", ")");
			if (end < 0) return fail(state, "an unterminated $(");
			parseInto(text.slice(i + 2, end), state, depth + 1);
			i = end;
		} else if (c === "`") {
			const end = findBacktick(text, i + 1);
			if (end < 0) return fail(state, "an unterminated backtick");
			parseInto(text.slice(i + 1, end).replace(/\\`/g, "`"), state, depth + 1);
			i = end;
		}
	}
}

function parseInto(src: string, state: State, depth: number): void {
	if (depth > MAX_DEPTH) return fail(state, "commands nested too deeply to read");
	let builder = newBuilder();
	let text = "";
	let started = false;
	let dynamic = false;
	let quotedWord = false;
	let pending: { op: string; fd?: string } | undefined;
	let index = 0;
	let pipelineStart = state.commands.length;
	let inTest = false;
	const heredocs: { target: Builder; delimiter: string; strip: boolean; expand: boolean }[] = [];

	const pushWord = (): void => {
		if (!started) return;
		const expanded = expandBraces(text);
		for (const piece of expanded ?? [text]) {
			const word: Word = { text: restoreMarkers(piece), dynamic: dynamic || expanded === undefined };
			if (pending) {
				builder.redirects.push({ op: pending.op, ...(pending.fd ? { fd: pending.fd } : {}), target: word });
				if (pending.op === "<<<") builder.stdinText = word.text;
				pending = undefined;
			} else builder.words.push(word);
		}
		if (!pending && builder.words.length === 1 && text === "[[" ) inTest = true;
		else if (text === "]]") inTest = false;
		text = "";
		started = false;
		dynamic = false;
		quotedWord = false;
	};

	const flush = (pipe: boolean): void => {
		pushWord();
		if (pending) {
			fail(state, "a redirection has no target");
			pending = undefined;
		}
		let words = builder.words;
		const dropKeywords = (): void => {
			while (words.length > 0 && !words[0]!.dynamic && KEYWORDS.has(words[0]!.text)) words = words.slice(1);
		};
		dropKeywords();
		if (words.length > 0 && !words[0]!.dynamic && ["for", "select", "case"].includes(words[0]!.text)) words = [];
		if (words.length > 1 && words[0]!.text === "function") {
			state.functions.add(words[1]!.text.replace(/\(\)$/, ""));
			words = words.slice(2);
			dropKeywords();
		}
		const assignments: Word[] = [];
		while (words.length > 0 && ASSIGNMENT.test(words[0]!.text)) assignments.push(words.shift()!);
		const declaring = words.length > 0 && DECLARERS.has(words[0]!.text);
		if (words.length === 0 || declaring) {
			for (const word of [...assignments, ...(declaring ? words.slice(1).filter((candidate) => ASSIGNMENT.test(candidate.text)) : [])]) {
				const equals = word.text.indexOf("=");
				state.vars.set(word.text.slice(0, equals).replace(/\+$/, ""), { text: word.text.slice(equals + 1), dynamic: word.dynamic });
			}
		}
		if (words.length > 0 && words[0]!.text === "unset") for (const word of words.slice(1)) state.vars.delete(word.text);
		if (words.length > 0 || builder.redirects.length > 0 || assignments.length > 0) {
			builder.words = words;
			if (assignments.length > 0) builder.assignments = assignments;
			builder.pipeline = state.pipeline;
			builder.index = index++;
			state.commands.push(builder as Command);
		}
		builder = newBuilder();
		if (!pipe) {
			state.pipeline++;
			index = 0;
			pipelineStart = state.commands.length;
		}
	};

	const variable = (name: string, inQuotes = false): void => {
		const known = state.vars.get(name);
		if (name === "HOME") text += "~";
		else if (known) {
			text += known.text;
			dynamic ||= known.dynamic || (!inQuotes && /[\s*?[]/.test(known.text));
		} else {
			for (const ch of `\${${name}}`) text += quotedChar(ch);
			dynamic = true;
		}
		started = true;
	};

	const substitution = (inner: string): void => {
		const before = state.commands.length;
		parseInto(inner, state, depth + 1);
		const value = plainValue(state.commands.slice(before));
		if (value === undefined) {
			text += "$(...)";
			dynamic = true;
		} else text += value;
		started = true;
	};

	let i = 0;
	const readDouble = (): void => {
		started = true;
		for (i++; i < src.length && src[i] !== '"'; i++) {
			const d = src[i]!;
			if (d === "\\" && i + 1 < src.length) {
				const escaped = src[++i]!;
				if (escaped === "\n") continue;
				text += '$`"\\'.includes(escaped) ? quotedChar(escaped) : `\\${quotedChar(escaped)}`;
			} else if (d === "$" && src[i + 1] === "(" && src[i + 2] !== "(") {
				const end = findClosing(src, i + 2, "(", ")");
				if (end < 0) return fail(state, "an unterminated $(");
				substitution(src.slice(i + 2, end));
				i = end;
			} else if (d === "$" && src[i + 1] === "(") {
				const end = findClosing(src, i + 2, "(", ")");
				if (end < 0) return fail(state, "an unterminated $((");
				text += "$((...))";
				dynamic = true;
				i = end;
			} else if (d === "`") {
				const end = findBacktick(src, i + 1);
				if (end < 0) return fail(state, "an unterminated backtick");
				substitution(src.slice(i + 1, end).replace(/\\`/g, "`"));
				i = end;
			} else if (d === "$" && src[i + 1] === "{") {
				const end = findClosing(src, i + 2, "{", "}");
				if (end < 0) return fail(state, "an unterminated ${");
				const name = src.slice(i + 2, end);
				if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) variable(name, true);
				else {
					for (const ch of `\${${name}}`) text += quotedChar(ch);
					dynamic = true;
				}
				i = end;
			} else if (d === "$" && /[A-Za-z_]/.test(src[i + 1] ?? "")) {
				const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i + 1))![0];
				variable(name, true);
				i += name.length;
			} else if (d === "$" && /[0-9@*#?$!-]/.test(src[i + 1] ?? "")) {
				text += `$${src[i + 1]}`;
				dynamic = true;
				i++;
			} else text += quotedChar(d);
		}
		if (i >= src.length) fail(state, "an unterminated quote");
	};

	for (; i < src.length && !state.problem; i++) {
		const c = src[i]!;
		const next = src[i + 1];
		if (c === " " || c === "\t" || c === "\r") pushWord();
		else if (inTest && "&|()<>;".includes(c)) {
			text += c;
			started = true;
		} else if (c === "\n") {
			flush(false);
			for (const heredoc of heredocs.splice(0)) {
				const lines: string[] = [];
				let found = false;
				let cursor = i + 1;
				while (cursor <= src.length) {
					const eol = src.indexOf("\n", cursor);
					const line = src.slice(cursor, eol < 0 ? src.length : eol);
					cursor = eol < 0 ? src.length + 1 : eol + 1;
					if ((heredoc.strip ? line.replace(/^\t+/, "") : line) === heredoc.delimiter) {
						found = true;
						break;
					}
					lines.push(line);
				}
				const body = lines.join("\n");
				heredoc.target.stdinText = body;
				if (heredoc.expand) scanSubstitutions(body, state, depth);
				i = Math.min(cursor, src.length) - 1;
				void found;
			}
		} else if (c === "#" && !started) {
			while (i + 1 < src.length && src[i + 1] !== "\n") i++;
		} else if (c === "'") {
			const end = src.indexOf("'", i + 1);
			if (end < 0) return fail(state, "an unterminated quote");
			for (const ch of src.slice(i + 1, end)) text += quotedChar(ch);
			started = true;
			quotedWord = true;
			i = end;
		} else if (c === '"') {
			quotedWord = true;
			readDouble();
		} else if (c === "$" && next === "'") {
			const ansi = readAnsiC(src, i + 2);
			if (!ansi) return fail(state, "an unterminated quote");
			for (const ch of ansi.text) text += quotedChar(ch);
			started = true;
			quotedWord = true;
			i = ansi.end;
		} else if (c === "$" && next === '"') {
			i++;
			quotedWord = true;
			readDouble();
		} else if (c === "$" && next === "(" && src[i + 2] === "(") {
			const end = findClosing(src, i + 2, "(", ")");
			if (end < 0) return fail(state, "an unterminated $((");
			text += "$((...))";
			dynamic = true;
			started = true;
			i = end;
		} else if (c === "$" && next === "(") {
			const end = findClosing(src, i + 2, "(", ")");
			if (end < 0) return fail(state, "an unterminated $(");
			substitution(src.slice(i + 2, end));
			i = end;
		} else if (c === "`") {
			const end = findBacktick(src, i + 1);
			if (end < 0) return fail(state, "an unterminated backtick");
			substitution(src.slice(i + 1, end).replace(/\\`/g, "`"));
			i = end;
		} else if (c === "$" && next === "{") {
			const end = findClosing(src, i + 2, "{", "}");
			if (end < 0) return fail(state, "an unterminated ${");
			const name = src.slice(i + 2, end);
			if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) variable(name);
			else {
				for (const ch of `\${${name}}`) text += quotedChar(ch);
				dynamic = true;
				started = true;
			}
			i = end;
		} else if (c === "$" && /[A-Za-z_]/.test(next ?? "")) {
			const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i + 1))![0];
			variable(name);
			i += name.length;
		} else if (c === "$" && /[0-9@*#?$!-]/.test(next ?? "")) {
			text += `$${next}`;
			dynamic = true;
			started = true;
			i++;
		} else if (c === "\\") {
			if (next === undefined) return fail(state, "a backslash at the end");
			if (next !== "\n") {
				text += quotedChar(next);
				started = true;
				quotedWord = true;
			}
			i++;
		} else if ((c === "<" || c === ">") && next === "(") {
			const end = findClosing(src, i + 2, "(", ")");
			if (end < 0) return fail(state, "an unterminated process substitution");
			parseInto(src.slice(i + 2, end), state, depth + 1);
			text += "<(...)";
			dynamic = true;
			started = true;
			i = end;
		} else if (c === ";" || (c === "&" && next === "&") || (c === "|" && next === "|")) {
			flush(false);
			if (next === c || (c === ";" && (next === "&" || next === ";"))) i++;
		} else if (c === "&" && next === ">") {
			pushWord();
			const op = src[i + 2] === ">" ? "&>>" : "&>";
			pending = { op };
			i += op.length - 1;
		} else if (c === "&") flush(false);
		else if (c === "|") {
			flush(true);
			if (next === "&") i++;
		} else if (c === "<" || c === ">") {
			let fd: string | undefined;
			if (started && !quotedWord && /^[0-9]$/.test(text) && !dynamic) {
				fd = text;
				text = "";
				started = false;
			} else pushWord();
			if (pending) return fail(state, "two redirections in a row");
			const rest = src.slice(i);
			const operator = ["<<<", "<<-", "<<", "<>", "<&", ">&", ">>", ">|", "<", ">"].find((op) => rest.startsWith(op))!;
			i += operator.length - 1;
			if (operator === ">&" || operator === "<&") {
				const target = /^\s*([0-9]+|-)/.exec(src.slice(i + 1));
				if (target) {
					builder.redirects.push({ op: operator, ...(fd ? { fd } : {}), target: { text: target[1]!, dynamic: false } });
					i += target[0].length;
					continue;
				}
			}
			pending = { op: operator, ...(fd ? { fd } : {}) };
			if (operator === "<<" || operator === "<<-") {
				while (src[i + 1] === " " || src[i + 1] === "\t") i++;
				const read = /^(?:'([^']*)'|"([^"]*)"|\\?([^\s;&|<>()]+))/.exec(src.slice(i + 1));
				if (!read) return fail(state, "a here-document has no delimiter");
				const quoted = read[1] !== undefined || read[2] !== undefined || src[i + 1] === "\\";
				heredocs.push({ target: builder, delimiter: read[1] ?? read[2] ?? read[3]!, strip: operator === "<<-", expand: !quoted });
				builder.redirects.push({ op: operator, ...(fd ? { fd } : {}), target: { text: read[1] ?? read[2] ?? read[3]!, dynamic: false } });
				pending = undefined;
				i += read[0].length;
			}
		} else if (c === "(") {
			if (!started && builder.words.length === 0 && next === "(") {
				const end = findClosing(src, i + 2, "(", ")");
				if (end < 0 || src[end + 1] !== ")") return fail(state, "an unterminated ((");
				scanSubstitutions(src.slice(i + 2, end), state, depth);
				i = end + 1;
			} else if (!started && builder.words.length === 0) {
				const end = findClosing(src, i + 1, "(", ")");
				if (end < 0) return fail(state, "an unterminated (");
				parseInto(src.slice(i + 1, end), state, depth + 1);
				i = end;
				builder = newBuilder();
			} else if (started && text.endsWith("=")) {
				const end = findClosing(src, i + 1, "(", ")");
				if (end < 0) return fail(state, "an unterminated (");
				dynamic = true;
				i = end;
			} else if (/^\s*\)/.test(src.slice(i + 1))) {
				pushWord();
				const name = builder.words.at(-1)!.text;
				state.functions.add(name);
				builder = newBuilder();
				i += src.slice(i + 1).indexOf(")") + 1;
			} else return fail(state, "an unexpected (");
		} else if (c === ")") {
			// the end of a case pattern: what came before it is not a command
			pushWord();
			state.commands.length = pipelineStart;
			builder = newBuilder();
			pending = undefined;
			state.pipeline++;
			index = 0;
		} else {
			text += c;
			started = true;
		}
	}
	if (!state.problem) {
		if (heredocs.length > 0) for (const heredoc of heredocs) heredoc.target.stdinText ??= "";
		flush(false);
	}
}

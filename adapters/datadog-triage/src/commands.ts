/**
 * What the Datadog triage role may run in its sandbox, and where it may write there. The sandbox has no credentials and no network; this
 * policy is the second line: it keeps the model to analysis. The role's approvals are always refused, so "needs approval" and "refused" are
 * the same thing here and every verdict is allow or refuse with a reason the model can act on.
 *
 * A command is parsed the way a shell reads it (quotes, escapes, the operators `;` `&&` `||` `|` and newlines) and every part must be one
 * of the allowed commands with arguments that pass that command's own rules. Command substitution, variables outside quotes, subshells,
 * background jobs, here-documents and every redirection except `2>&1`, `> /dev/null` and `>`/`>>` into `data/` or `scratch/` are refused.
 * Paths are relative to the workspace and never leave it.
 */
export type Verdict = { allowed: true } | { allowed: false; reason: string };

export const REFUSED = "refused by the Datadog triage command policy";
export const WRITABLE_DIRS = ["data", "scratch"];

const refuse = (reason: string): Verdict => ({ allowed: false, reason: `${REFUSED}: ${reason}` });
const ALLOWED = { allowed: true } as const;

export const ALLOWED_COMMANDS = ["python3", "jq", "awk", "sed", "sort", "uniq", "head", "tail", "wc", "grep", "cut", "tr", "cat", "ls", "date", "bc", "echo", "printf", "pwd", "mkdir", "rm", "mv", "cp", "touch"];
const NETWORK = new Set(["curl", "wget", "ssh", "scp", "sftp", "rsync", "nc", "ncat", "telnet", "ftp", "git", "gh", "pip", "pip3", "npm", "npx", "yarn", "pnpm", "apt", "apt-get", "dpkg", "docker", "podman", "node", "bash", "sh", "zsh", "env", "xargs", "find", "perl", "ruby", "sudo", "su", "tee", "nohup", "timeout", "time", "eval", "exec", "source"]);

// ---- parsing ---------------------------------------------------------------------------------------------------------------------

interface Redirect {
	fd?: string;
	op: ">" | ">>" | "<" | ">&";
	target: string;
}
interface Segment {
	words: string[];
	redirects: Redirect[];
}

function parse(command: string): Segment[] | string {
	const segments: Segment[] = [];
	let current: Segment = { words: [], redirects: [] };
	let word = "";
	let inWord = false;
	let quoted = false;
	let pending: { fd?: string; op: Redirect["op"] } | undefined;

	const endWord = () => {
		if (!inWord) return;
		if (pending) current.redirects.push({ ...pending, target: word });
		else current.words.push(word);
		pending = undefined;
		word = "";
		inWord = false;
		quoted = false;
	};
	const endSegment = () => {
		endWord();
		if (pending) return "a redirection has no target";
		if (current.words.length > 0 || current.redirects.length > 0) segments.push(current);
		current = { words: [], redirects: [] };
		return undefined;
	};

	for (let i = 0; i < command.length; i++) {
		const c = command[i]!;
		const next = command[i + 1];
		if (c === " " || c === "\t") endWord();
		else if (c === "\r") return "carriage returns are not allowed";
		else if (c === "\n") {
			const problem = endSegment();
			if (problem) return problem;
		} else if (c === "'") {
			const end = command.indexOf("'", i + 1);
			if (end < 0) return "an unterminated quote";
			word += command.slice(i + 1, end);
			inWord = quoted = true;
			i = end;
		} else if (c === '"') {
			inWord = quoted = true;
			let j = i + 1;
			for (; j < command.length && command[j] !== '"'; j++) {
				const d = command[j]!;
				if (d === "\\" && j + 1 < command.length) {
					const escaped = command[++j]!;
					word += escaped === "\n" ? "" : '"\\$`'.includes(escaped) ? escaped : `\\${escaped}`;
				} else if (d === "`" || (d === "$" && (command[j + 1] === "(" || command[j + 1] === "{"))) return "command substitution is not allowed";
				else word += d;
			}
			if (j >= command.length) return "an unterminated quote";
			i = j;
		} else if (c === "\\") {
			if (next === undefined || next === "\n") return "a backslash at the end of a line is not allowed";
			word += next;
			inWord = true;
			i++;
		} else if (c === "`") return "command substitution is not allowed";
		else if (c === "$") return "variables and substitutions are not available outside quotes; write the text in quotes";
		else if (c === "(" || c === ")") return "subshells and grouping are not allowed";
		else if (c === ";") {
			const problem = endSegment();
			if (problem) return problem;
		} else if (c === "&") {
			if (next !== "&") return "background jobs and `&>` are not allowed";
			const problem = endSegment();
			if (problem) return problem;
			i++;
		} else if (c === "|") {
			if (next === "&") return "`|&` is not allowed";
			const problem = endSegment();
			if (problem) return problem;
			if (next === "|") i++;
		} else if (c === "<" || c === ">") {
			if (pending) return "two redirections in a row";
			let fd: string | undefined;
			if (inWord && !quoted && /^[0-9]$/.test(word)) {
				fd = word;
				word = "";
				inWord = false;
			} else endWord();
			if (c === "<") {
				if (next === "<" || next === "(" || next === "&") return "here-documents, here-strings and process substitution are not allowed; write a file with the write tool";
				pending = { ...(fd ? { fd } : {}), op: "<" };
			} else if (next === "&") {
				const match = /^[0-9-]/.exec(command.slice(i + 2));
				if (!match) return "a redirection to a file descriptor needs a number";
				current.redirects.push({ ...(fd ? { fd } : {}), op: ">&", target: match[0] });
				i += 2;
			} else if (next === "|") return "`>|` is not allowed";
			else if (next === ">") {
				pending = { ...(fd ? { fd } : {}), op: ">>" };
				i++;
			} else pending = { ...(fd ? { fd } : {}), op: ">" };
		} else if (c === "#" && !inWord) {
			while (i + 1 < command.length && command[i + 1] !== "\n") i++;
		} else {
			word += c;
			inWord = true;
		}
	}
	const problem = endSegment();
	if (problem) return problem;
	return segments.length === 0 ? "the command is empty" : segments;
}

// ---- paths -----------------------------------------------------------------------------------------------------------------------

const dotDot = (path: string): boolean => path.split("/").includes("..");
const bare = (path: string): string => path.replace(/^(\.\/)+/, "");

/** A path inside the workspace: relative, no `..`, no home directory. */
export const insideWorkspace = (path: string): boolean => path !== "" && !path.startsWith("/") && !path.startsWith("~") && !dotDot(path) && !path.includes("\0");
/** A path the model may change: a file or directory inside `data/` or `scratch/`. */
export const writable = (path: string): boolean => insideWorkspace(path) && WRITABLE_DIRS.some((dir) => bare(path).startsWith(`${dir}/`) && bare(path).length > dir.length + 1);
const readable = (path: string): boolean => path === "/dev/null" || insideWorkspace(path);
/** Arguments of a program run by a command (python3 script arguments): only an obvious way out of the workspace is refused. */
const looksOutside = (arg: string): boolean => (arg.startsWith("/") && arg !== "/dev/null") || arg.startsWith("~") || dotDot(arg);

// ---- arguments -------------------------------------------------------------------------------------------------------------------

interface Parsed {
	flags: string[];
	positional: string[];
	/** Values of flags that take one. */
	values: string[];
}

/** Splits arguments into flags and positional words; `valueFlags` take the next word (or `--flag=value`) as their value. */
function split(args: string[], valueFlags: string[] = [], pairFlags: string[] = []): Parsed {
	const out: Parsed = { flags: [], positional: [], values: [] };
	let flagsDone = false;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (flagsDone || arg === "-" || !arg.startsWith("-")) out.positional.push(arg);
		else if (arg === "--") flagsDone = true;
		else {
			out.flags.push(arg);
			if (pairFlags.includes(arg)) i += 2;
			else if (valueFlags.includes(arg) && i + 1 < args.length) out.values.push(args[++i]!);
		}
	}
	return out;
}

const hasFlag = (parsed: Parsed, ...names: string[]): boolean => parsed.flags.some((flag) => names.some((name) => flag === name || flag.startsWith(`${name}=`)));

const clusteredShort = (parsed: Parsed, letters: string): boolean => parsed.flags.some((flag) => /^-[A-Za-z]+\d*$/.test(flag) && [...flag.slice(1)].some((letter) => letters.includes(letter)));

function readPaths(paths: string[], what: string): Verdict {
	const bad = paths.find((path) => !readable(path));
	return bad === undefined ? ALLOWED : refuse(`${what} reads only paths inside the workspace (${bad.slice(0, 80)} is not)`);
}

// ---- python3, awk and sed programs ------------------------------------------------------------------------------------------------

const DENIED_MODULES = new Set(["socket", "urllib", "urllib3", "http", "ftplib", "smtplib", "poplib", "imaplib", "nntplib", "telnetlib", "xmlrpc", "ssl", "ctypes", "subprocess", "shutil", "multiprocessing", "pty", "importlib", "asyncio", "ensurepip", "pip", "venv", "requests", "httpx", "aiohttp", "webbrowser", "pexpect", "paramiko", "select", "selectors", "signal", "resource", "fcntl", "mmap", "pickle", "marshal", "code", "codeop", "runpy"]);
const DENIED_CALLS = /(?:\b__import__|\bimportlib|\beval|\bexec|\bcompile|\bbreakpoint)\s*\(|\bos\s*\.\s*(?:system|popen|exec\w*|spawn\w*|fork\w*|kill\w*|remove|unlink|rmdir|removedirs|rename|renames|replace|chmod|chown|symlink|link|chroot|setuid|environ|putenv|startfile)\b|\bsys\s*\.\s*(?:modules|exit)\s*\[|\.\s*(?:unlink|rmdir|rename|replace|symlink_to|hardlink_to|chmod)\s*\(/;

/** Why python source may not run here, or undefined. It is a screen for what the sandbox would refuse anyway (no network, no credentials). */
export function pythonProblem(source: string): string | undefined {
	for (const match of source.matchAll(/(?:^|[\s;:])import\s+([\w., \t]+)/gm)) {
		for (const part of match[1]!.split(",")) {
			const module = part.trim().split(/\s+/)[0]!.split(".")[0]!;
			if (DENIED_MODULES.has(module)) return `python may not import ${module}: there is no network, no subprocess and no file removal, only analysis of data you saved`;
		}
	}
	for (const match of source.matchAll(/(?:^|[\s;:])from\s+([\w.]+)\s+import\b/gm)) {
		const module = match[1]!.split(".")[0]!;
		if (DENIED_MODULES.has(module)) return `python may not import ${module}: there is no network, no subprocess and no file removal, only analysis of data you saved`;
	}
	const call = DENIED_CALLS.exec(source);
	return call ? `python may not use ${call[0].replace(/\s+/g, "").slice(0, 40)}: only analysis of the files in data/ and scratch/ is allowed` : undefined;
}

const AWK_DENIED = /\bsystem\s*\(|\bgetline\b|\bclose\s*\(|\bfflush\s*\(|\bENVIRON\b|\bprintf?\b[^;}\n]*?[>|]|@(?:load|include|namespace)|\|\s*&|\bPROCINFO\b/;

/** `sed` programs this policy understands: `[address]p|d|q` and `s/…/…/[flags]`, joined by `;`. Anything that can write a file or run a command (w, e, r) is not among them. */
function sedProgramOk(program: string): boolean {
	const address = String.raw`(?:\d+|\$|/(?:\\.|[^/\\])*/)`;
	const range = String.raw`(?:${address}(?:,${address})?!?)?`;
	const substitute = String.raw`s([/|,#:])(?:\\.|(?!\1)[^\\])*\1(?:\\.|(?!\1)[^\\])*\1[gpiIm0-9]*`;
	const command = new RegExp(String.raw`^\s*${range}\s*(?:[pdq]|${substitute})\s*$`);
	return program.split(/;|\n/).filter((part) => part.trim() !== "").every((part) => command.test(part)) && program.trim() !== "";
}

// ---- one command -----------------------------------------------------------------------------------------------------------------

function checkCommandWords(words: string[]): Verdict {
	const [head, ...args] = words;
	if (head === undefined) return refuse("an empty command");
	if (head.includes("/")) return refuse(`${head.slice(0, 60)}: commands are run by name, not by path`);
	if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(head)) return refuse("setting environment variables for a command is not allowed");
	if (NETWORK.has(head)) return refuse(`${head} is not available: there is no network, no git, no package manager and no other shell, only ${ALLOWED_COMMANDS.slice(0, 16).join(", ")}`);
	if (!ALLOWED_COMMANDS.includes(head)) return refuse(`${head} is not one of the allowed commands (${ALLOWED_COMMANDS.join(", ")})`);
	switch (head) {
		case "python3": {
			// options come before the program; everything after the script or the -c code belongs to the program
			const options = ["-B", "-u", "-I", "-E", "-s", "-S", "-O", "-OO", "-q", "-b", "-bb"];
			let index = 0;
			let code: string | undefined;
			let module: string | undefined;
			for (; index < args.length; index++) {
				const arg = args[index]!;
				if (!arg.startsWith("-") || arg === "-") break;
				if (arg === "-c" || arg === "-m") {
					if (arg === "-c") code = args[index + 1];
					else module = args[index + 1];
					index += 2;
					break;
				}
				if (!options.includes(arg)) return refuse("python3 takes only -B -u -I -E -s -S -O -q, -c <code>, -m json.tool, or a script file");
			}
			const rest = args.slice(index);
			if (module !== undefined) return module === "json.tool" ? readPaths(rest, "python3") : refuse("python3 -m is only allowed for json.tool");
			if (args.includes("-c") && code === undefined) return refuse("python3 -c needs code");
			if (code !== undefined) {
				// what follows the code is data for it, not a file name; the code itself is screened
				const problem = pythonProblem(code);
				if (problem) return refuse(problem);
				return rest.some(looksOutside) ? refuse("an argument points outside the workspace") : ALLOWED;
			}
			const [script, ...scriptArgs] = rest;
			if (script === undefined) return refuse("python3 needs -c <code> or a script file in scratch/ (standard input is not available)");
			if (script === "-") return refuse("python3 reads no program from standard input: use -c or a script file");
			if (!writable(script) || !script.endsWith(".py")) return refuse("a python script must be a .py file in scratch/ or data/ (write it with the write tool)");
			return scriptArgs.some(looksOutside) ? refuse("an argument points outside the workspace") : ALLOWED;
		}
		case "jq": {
			const parsed = split(args, ["--indent", "--arg", "--argjson", "--slurpfile", "--rawfile"], []);
			if (hasFlag(parsed, "-f", "--from-file", "-L", "--rawfile", "--slurpfile", "--args", "--jsonargs", "--seq", "--stream-errors") || clusteredShort(parsed, "fL")) return refuse("jq takes a program on the command line and files from data/ or scratch/; -f, -L, --rawfile and --slurpfile are not allowed");
			// --arg and --argjson take a name and a value: both words land in `positional`, so the program is the first word that is not one of them
			const rest = positionalAfterPairs(args);
			const [, ...files] = rest;
			return readPaths(files, "jq");
		}
		case "awk": {
			const parsed = split(args, ["-F", "-v"]);
			if (hasFlag(parsed, "-f", "--file", "-i", "--include", "-e", "--source", "-E", "--exec", "-l", "--load", "-o", "--pretty-print", "-d", "--dump-variables", "-D", "--debug") || clusteredShort(parsed, "fieEldoD")) return refuse("awk takes its program on the command line; -f, -i, -e, -l and friends are not allowed");
			const [program, ...files] = parsed.positional;
			if (program === undefined) return refuse("awk needs a program");
			if (AWK_DENIED.test(program)) return refuse("this awk program writes, pipes or runs something (print > file, system, getline, ENVIRON): print to standard output only");
			return readPaths(files, "awk");
		}
		case "sed": {
			const parsed = split(args, ["-e", "--expression"]);
			if (hasFlag(parsed, "-i", "--in-place", "-f", "--file", "-s", "--separate", "-z", "--null-data", "--follow-symlinks", "--sandbox") || clusteredShort(parsed, "ifsz")) return refuse("sed may only print to standard output: -i, -f and -z are not allowed");
			const programs = parsed.values.length > 0 ? parsed.values : parsed.positional.slice(0, 1);
			const files = parsed.values.length > 0 ? parsed.positional : parsed.positional.slice(1);
			if (programs.length === 0) return refuse("sed needs a program");
			if (!programs.every(sedProgramOk)) return refuse("sed programs are limited to addresses with p, d or q, and s/…/…/ with the flags g, p, i, I, m or a number; use awk or python3 for more");
			return readPaths(files, "sed");
		}
		case "sort": {
			const parsed = split(args, ["-k", "-t", "-S", "-T", "-o", "--key", "--field-separator", "--buffer-size", "--temporary-directory", "--output", "--parallel"]);
			if (hasFlag(parsed, "-o", "--output", "-T", "--temporary-directory", "--compress-program", "--files0-from") || clusteredShort(parsed, "oT")) return refuse("sort writes to standard output only (-o, -T and --compress-program are not allowed)");
			return readPaths(parsed.positional, "sort");
		}
		case "uniq": {
			const parsed = split(args, ["-f", "-s", "-w", "--skip-fields", "--skip-chars", "--check-chars"]);
			if (parsed.positional.length > 1) return refuse("uniq takes at most one input file and writes to standard output only");
			return readPaths(parsed.positional, "uniq");
		}
		case "head":
		case "tail": {
			const parsed = split(args, ["-n", "-c", "--lines", "--bytes", "--pid", "-s", "--sleep-interval"]);
			if (hasFlag(parsed, "-f", "-F", "--follow", "--retry", "--pid") || clusteredShort(parsed, "fF")) return refuse(`${head} -f would wait forever`);
			return readPaths(parsed.positional, head);
		}
		case "cut": {
			const parsed = split(args, ["-d", "-f", "-c", "-b", "--delimiter", "--fields", "--characters", "--bytes"]);
			return readPaths(parsed.positional, "cut");
		}
		case "tr": {
			const parsed = split(args);
			return parsed.positional.length > 2 ? refuse("tr takes character sets, not files") : ALLOWED;
		}
		case "grep": {
			const parsed = split(args, ["-e", "-m", "-A", "-B", "-C", "--max-count", "--include", "--exclude", "--exclude-dir", "--context", "--regexp", "--label", "-d", "-D"]);
			if (hasFlag(parsed, "-f", "--file", "--exclude-from") || clusteredShort(parsed, "f")) return refuse("grep takes its pattern on the command line (-f is not allowed)");
			const files = parsed.flags.includes("-e") || parsed.flags.includes("--regexp") ? parsed.positional : parsed.positional.slice(1);
			return readPaths(files, "grep");
		}
		case "cat":
		case "ls":
		case "wc":
		case "bc": {
			const parsed = split(args);
			if (head === "wc" && hasFlag(parsed, "--files0-from")) return refuse("wc --files0-from is not allowed");
			return readPaths(parsed.positional, head);
		}
		case "date": {
			const parsed = split(args, ["-d", "--date"]);
			if (hasFlag(parsed, "-s", "--set", "-f", "--file") || clusteredShort(parsed, "sf")) return refuse("date may not set the clock");
			if (parsed.positional.some((word) => !word.startsWith("+"))) return refuse("date takes a +FORMAT only");
			return ALLOWED;
		}
		case "echo":
		case "printf":
		case "pwd":
			return ALLOWED;
		case "mkdir": {
			const parsed = split(args);
			if (parsed.flags.some((flag) => flag !== "-p" && flag !== "--parents")) return refuse("mkdir takes only -p");
			if (parsed.positional.length === 0) return refuse("mkdir needs a directory");
			return parsed.positional.every((path) => WRITABLE_DIRS.includes(bare(path).replace(/\/$/, "")) || writable(path)) ? ALLOWED : refuse("mkdir only creates directories inside data/ and scratch/");
		}
		case "touch":
		case "rm":
		case "mv":
		case "cp": {
			const parsed = split(args);
			const flagsOk = parsed.flags.every((flag) => (head === "rm" ? ["-f", "-r", "-R", "-v", "-rf", "-fr", "--force", "--recursive"] : head === "cp" ? ["-r", "-R", "-v", "-f", "-p", "-a"] : head === "mv" ? ["-f", "-v", "-n"] : ["-c"]).includes(flag));
			if (!flagsOk) return refuse(`${head} flag not allowed`);
			if (parsed.positional.length === 0) return refuse(`${head} needs a path`);
			if (head !== "cp" && !parsed.positional.every(writable)) return refuse(`${head} only changes files inside data/ and scratch/`);
			if (head === "cp") {
				const destination = parsed.positional.at(-1)!;
				if (parsed.positional.length < 2 || !writable(destination)) return refuse("cp copies into data/ or scratch/ only");
				return readPaths(parsed.positional.slice(0, -1), "cp");
			}
			if ((head === "mv") && parsed.positional.length < 2) return refuse("mv needs a source and a destination");
			return ALLOWED;
		}
		default:
			return refuse(`${head} is not allowed`);
	}
}

/** The positional words of jq's arguments after `--arg name value` and `--argjson name value` pairs are dropped. */
function positionalAfterPairs(args: string[]): string[] {
	const out: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (arg === "--arg" || arg === "--argjson") i += 2;
		else if (arg === "--indent") i += 1;
		else if (arg.startsWith("-") && arg !== "-") continue;
		else out.push(arg);
	}
	return out;
}

function checkRedirect(redirect: Redirect): Verdict {
	if (redirect.op === ">&") return redirect.target === "1" || redirect.target === "2" ? ALLOWED : refuse("a redirection to another file descriptor is not allowed");
	if (redirect.op === "<") return readable(redirect.target) ? ALLOWED : refuse("input redirection reads paths inside the workspace only");
	if (redirect.target === "/dev/null") return ALLOWED;
	return writable(redirect.target) ? ALLOWED : refuse(`output redirection writes only inside data/ and scratch/ (${redirect.target.slice(0, 80)} is not)`);
}

/** Whether a bash command may run. */
export function checkCommand(command: string): Verdict {
	const parsed = parse(command);
	if (typeof parsed === "string") return refuse(parsed);
	for (const segment of parsed) {
		for (const redirect of segment.redirects) {
			const verdict = checkRedirect(redirect);
			if (!verdict.allowed) return verdict;
		}
		const verdict = checkCommandWords(segment.words);
		if (!verdict.allowed) return verdict;
	}
	return ALLOWED;
}

// ---- the file tools --------------------------------------------------------------------------------------------------------------

/** Absolute paths the sandbox shows: `/…/<16 hex>/data/…` is the task's own workspace. */
const ABSOLUTE_WORKSPACE = /^\/(?:[\w.-]+\/)*[0-9a-f]{16}\/((?:data|scratch)\/[^/].*)$/;

/** The path as the workspace sees it when it is inside the workspace, else undefined. */
export function workspaceRelative(path: string): string | undefined {
	if (path.includes("\0") || dotDot(path)) return undefined;
	const absolute = ABSOLUTE_WORKSPACE.exec(path);
	return absolute ? absolute[1] : path.startsWith("/") || path.startsWith("~") ? undefined : bare(path);
}

const strings = (value: unknown, depth = 0): string[] => (typeof value === "string" ? [value] : depth < 4 && value !== null && typeof value === "object" ? Object.values(value).flatMap((item) => strings(item, depth + 1)) : []);

/** The `write` and `edit` tools: only files inside `data/` and `scratch/`, and python files are screened like python commands. */
export function checkFileTool(tool: "write" | "edit", args: Record<string, unknown>): string | undefined {
	const path = typeof args.path === "string" ? args.path : "";
	const relative = workspaceRelative(path);
	if (relative === undefined || !writable(relative)) return `${REFUSED}: ${tool} changes files inside data/ and scratch/ only (${path.slice(0, 80) || "no path"} is not)`;
	if (relative.endsWith(".py")) {
		const { path: _path, ...rest } = args;
		const problem = pythonProblem(strings(rest).join("\n"));
		if (problem) return `${REFUSED}: ${problem}`;
	}
	return undefined;
}

/** The `toolApprovals` entry of `bash`: undefined when the command may run, else why it may not. */
export function bashApproval(args: Record<string, unknown>): string | undefined {
	const verdict = checkCommand(String(args.command ?? ""));
	return verdict.allowed ? undefined : verdict.reason;
}

import { assignmentFinding, basename, checkWrite, clip, found, hasFlag, isOwnPath, isWorkspaceRoot, isWorkspaceWildcard, joinWords, parseArgs, texts, valueOf, word, type Call, type Finding, type Parsed, type Settings } from "./common.ts";
import { classifyDatabase, DATABASE_PROGRAMS } from "./database.ts";
import { classifyDocker } from "./docker.ts";
import { classifyGit } from "./git.ts";
import { isHypervisorName, HYPERVISOR_PROGRAMS, secretPathReason } from "./patterns.ts";
import type { Word } from "./shell.ts";

type Handler = (call: Call) => Finding | undefined;

const remote = (settings: Settings): boolean => settings.workspaces.length === 0;

// ---- programs that only look ----------------------------------------------------------------------------------------------------

/** Programs that read, print or measure and change nothing, whatever their arguments. */
export const READ_ONLY_PROGRAMS = new Set(["ls", "ll", "la", "dir", "pwd", "cd", "pushd", "popd", "dirs", "echo", "printf", "true", "false", ":", "test", "[", "[[", "]]", "expr", "seq", "sleep", "cal", "uname", "whoami", "id", "groups", "who", "w", "last", "lastlog", "uptime", "free", "vmstat", "iostat", "mpstat", "pgrep", "top", "htop", "lsof", "ss", "netstat", "which", "type", "whereis", "realpath", "dirname", "basename", "readlink", "nproc", "lscpu", "lsblk", "findmnt", "blkid", "getent", "locale", "tput", "clear", "wc", "head", "tail", "cut", "tr", "uniq", "paste", "join", "column", "fold", "fmt", "rev", "tac", "nl", "od", "hexdump", "xxd", "strings", "base64", "md5sum", "sha1sum", "sha224sum", "sha256sum", "sha384sum", "sha512sum", "cksum", "b2sum", "diff", "diff3", "cmp", "comm", "cat", "less", "more", "file", "stat", "du", "df", "dig", "nslookup", "host", "ping", "traceroute", "tracepath", "mtr", "whois", "read", "wait", "exit", "return", "break", "continue", "shopt", "shift", "umask", "ulimit", "hash", "let", "jobs", "fg", "bg", "disown", "times", "getopts", "alias", "unalias", "mkdir", "touch", "mktemp", "lsmod", "getcap", "tty", "arch", "numfmt", "factor", "yes", "sync", "nm", "objdump", "readelf", "size", "uuidgen", "tsort", "unexpand", "expand", "pr", "lspci", "lsusb", "pstree", "zcat", "zless", "bzcat", "xzcat", "bat", "eza", "exa", "tokei", "cloc", "hyperfine", "jless", "delta"]);

/** Programs that look at files by name only: a secret file's name is not a secret. */
const METADATA_PROGRAMS = new Set(["ls", "ll", "la", "dir", "stat", "test", "[", "[[", "file", "realpath", "dirname", "basename", "readlink", "du", "df", "find", "cd", "pwd", "wc", "mkdir", "touch", "chmod", "chown", "chgrp", "tree"]);

export const WRAPPER_PROGRAMS = new Set(["sudo", "doas", "env", "nice", "nohup", "time", "command", "builtin", "exec", "stdbuf", "setsid", "ionice", "chrt", "taskset", "unbuffer", "timeout", "watch", "flock", "busybox", "xargs", "su", "runuser"]);

export const skipsSecretPathScan = (program: string): boolean => METADATA_PROGRAMS.has(program) || WRAPPER_PROGRAMS.has(program);

// ---- running scripts ------------------------------------------------------------------------------------------------------------

export const scriptMatches = (path: string, scripts: readonly string[]): boolean => scripts.some((script) => path === script || path.endsWith(`/${script}`) || path.replace(/^\.\//, "") === script);

/** A script file: the repository's own deploy scripts, or the agent's own files in its workspace. */
export function runsScript(script: Word, call: Call): Finding | undefined {
	if (/firewall/i.test(basename(script.text))) return found("firewall", `runs a firewall script: ${clip(script.text, 60)}`);
	if (script.dynamic) return found("unknown", "runs a script whose path is computed when the command runs");
	if (call.shared.downloads.has(script.text) || call.shared.downloads.has(basename(script.text))) return found("download", `runs a script that the same command line downloaded (${clip(script.text, 60)})`);
	if (scriptMatches(script.text, call.settings.scripts)) return undefined;
	if (!remote(call.settings) && isOwnPath(script.text, call.settings)) return undefined;
	return found("unknown", `runs a program that is not one of the repository's deploy scripts: ${clip(script.text, 60)}`);
}

const CODE_DANGER = /\b(?:rmtree|os\s*\.\s*(?:remove|unlink|rmdir|removedirs|rename|replace|system|popen|exec\w*|spawn\w*|kill|killpg|chmod|chown)|shutil\s*\.\s*(?:rmtree|move|copy\w*)|subprocess|Popen|check_output|socket|__import__|ctypes|pty\s*\.\s*spawn|fs\s*\.\s*(?:rm|rmSync|unlink|unlinkSync|rmdir|rmdirSync|writeFile\w*|appendFile\w*|rename\w*|copyFile\w*|createWriteStream|chmod\w*|truncate\w*)|child_process|execSync|execFileSync|spawnSync|process\s*\.\s*kill|Deno\s*\.\s*(?:remove|writeFile|writeTextFile|run|Command|env)|File\s*\.\s*(?:delete|write|unlink|rename)|FileUtils|Dir\s*\.\s*(?:rmdir|unlink)|IO\s*\.\s*popen|Kernel\s*\.\s*system)\b|\b(?:unlink|rmdir|remove_tree|rmtree)\b|\b(?:eval|exec|compile|system|unlink|rmdir|rename|popen|passthru|shell_exec)\s*\(|`[^`]+`|\bopen\s*\([^)]*['"][wax][b+]?['"]|\bqx\s*[{(\/]|\brequire\s*\(\s*['"](?:child_process|fs)['"]|\bimport\s*\(?\s*['"](?:node:)?(?:child_process|fs)/;
const CODE_SECRETS = /(?:id_(?:rsa|ed25519|ecdsa|dsa)|\.pem\b|\.ssh\/|(?:^|[\s'"/\\])\.env\b|\/run\/secrets|\.aws\/credentials|auth\.json|\/etc\/shadow|\.netrc|\.git-credentials|credentials\.json|\.gnupg|\.kube\/config)/;
const CODE_ENVIRONMENT = /\b(?:process\s*\.\s*env|os\s*\.\s*(?:environ|getenv)|getenv|Deno\s*\.\s*env)\b|\bENV\b|%ENV\b|\$ENV\b|\$_ENV\b|\$_SERVER\b/;

function inlineCode(code: string, interpreter: string): Finding | undefined {
	if (CODE_ENVIRONMENT.test(code)) return found("secrets", `${interpreter} code that reads the environment, which holds secrets`);
	if (CODE_SECRETS.test(code)) return found("secrets", `${interpreter} code that reads key or secret files`);
	if (CODE_DANGER.test(code)) return found("data", `${interpreter} code that removes or writes files, runs commands or reads the environment`);
	return undefined;
}

const INTERPRETERS: Record<string, { inline: string[]; valued: string[] }> = {
	python: { inline: ["-c"], valued: ["-W", "-X", "-m", "--check-hash-based-pycs"] },
	node: { inline: ["-e", "--eval", "-p", "--print"], valued: ["-r", "--require", "--import", "--loader", "--env-file", "--conditions", "-C", "--input-type", "--stack-size", "--max-old-space-size", "--test-name-pattern", "--test-reporter", "--test-concurrency", "--watch-path"] },
	deno: { inline: ["eval"], valued: ["--config", "-c"] },
	bun: { inline: ["-e", "--eval", "-p", "--print"], valued: ["--config", "-c", "--cwd"] },
	perl: { inline: ["-e", "-E"], valued: ["-I", "-M", "-m"] },
	ruby: { inline: ["-e"], valued: ["-I", "-r"] },
	php: { inline: ["-r"], valued: ["-c", "-d", "-f"] },
	lua: { inline: ["-e"], valued: ["-l"] },
	tsx: { inline: ["-e", "--eval", "-p", "--print"], valued: ["--tsconfig", "-r", "--import"] },
};

const INTERPRETER_NAMES: [RegExp, string][] = [[/^python[0-9.]*$/, "python"], [/^node(?:js)?$/, "node"], [/^(?:deno|bun|perl|ruby|php|lua|tsx)$/, ""], [/^ts-node$/, "tsx"]];
const PYTHON_MODULES = new Set(["json.tool", "pytest", "unittest", "py_compile", "compileall", "venv", "timeit", "doctest", "mypy", "ruff", "black", "flake8", "isort", "pylint", "coverage", "tomllib", "calendar", "this", "zipfile", "tarfile", "http.client", "ensurepip"]);

function interpreter(call: Call, kind: string): Finding | undefined {
	const spec = INTERPRETERS[kind]!;
	const args = call.args;
	const name = kind === "python" ? "python" : kind;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (arg.dynamic) return found("unknown", `${name} was given a computed argument`);
		if (kind === "perl" && /^-[A-Za-z]*i/.test(arg.text)) return found("data", "perl -i edits files in place");
		const cluster = spec.inline.find((flag) => flag.length === 2 && /^-[A-Za-z]{2,}$/.test(arg.text) && arg.text.endsWith(flag[1]!));
		const inlineFlag = spec.inline.find((flag) => arg.text === flag || (flag.length === 2 && arg.text.startsWith(flag) && arg.text.length > 2 && !arg.text.startsWith("--"))) ?? cluster;
		if (inlineFlag) {
			const attached = arg.text !== inlineFlag && !cluster ? arg.text.slice(2) : undefined;
			const code = attached ?? args[i + 1]?.text;
			if (code === undefined) return found("unknown", `${name} ${inlineFlag} without code`);
			if (attached === undefined && args[i + 1]?.dynamic) return found("unknown", `${name} code is computed when the command runs`);
			return inlineCode(code, name);
		}
		if (kind === "python" && arg.text === "-m") {
			const module = args[i + 1]?.text ?? "";
			if (module === "pip") return pip({ ...call, program: "pip", args: args.slice(i + 2) });
			if (!PYTHON_MODULES.has(module)) return found("unknown", `python -m ${clip(module, 30)} runs a module that is not on the list of harmless ones`);
			return remote(call.settings) && module !== "json.tool" ? found("unknown", `python -m ${module} runs code on a machine that is not the agent's workspace`) : undefined;
		}
		if (spec.valued.includes(arg.text)) {
			i++;
			continue;
		}
		if (arg.text === "-") return stdinProgram(call, name);
		if (arg.text.startsWith("-") && arg.text.length > 1) continue;
		if (kind === "deno" && ["run", "test", "fmt", "lint", "check", "info", "doc", "task", "bench", "compile"].includes(arg.text)) continue;
		if (kind === "bun" && ["run", "test", "x", "install", "add", "remove", "build"].includes(arg.text)) continue;
		return runsScript(arg, call);
	}
	if (kind === "node" && args.some((arg) => arg.text === "--test")) return remote(call.settings) ? found("unknown", "node --test runs code on a machine that is not the agent's workspace") : undefined;
	if (args.some((arg) => ["--version", "-v", "-V", "--help", "-h"].includes(arg.text))) return undefined;
	return stdinProgram(call, name);
}

function stdinProgram(call: Call, name: string): Finding | undefined {
	const text = call.io.stdinText ?? call.io.piped;
	if (text === undefined) return found("unknown", `${name} reads its program from standard input, which cannot be seen`);
	return inlineCode(text, name);
}

// ---- shells ---------------------------------------------------------------------------------------------------------------------

function shell(call: Call): Finding | undefined {
	const args = call.args;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (arg.dynamic) return found("unknown", `${call.program} was given a computed argument`);
		if (arg.text === "-c" || (/^-[A-Za-z]+$/.test(arg.text) && arg.text.includes("c") && !arg.text.includes("s"))) {
			const code = args[i + 1];
			if (!code) return found("unknown", `${call.program} -c without a command`);
			if (code.dynamic) return found("unknown", `${call.program} -c runs text computed when the command runs`);
			return call.runText(code.text);
		}
		if (arg.text === "-s") break;
		if (arg.text === "-o" || arg.text === "+o" || arg.text === "--rcfile" || arg.text === "--init-file") {
			i++;
			continue;
		}
		if (arg.text.startsWith("-") && arg.text.length > 1) continue;
		return runsScript(arg, call);
	}
	const text = call.io.stdinText ?? call.io.piped;
	if (text !== undefined) return call.runText(text);
	return found("unknown", `${call.program} runs a script read from standard input, which cannot be seen`);
}

// ---- files ----------------------------------------------------------------------------------------------------------------------

function removal(call: Call, valued: string[] = []): Finding | undefined {
	const parsed = parseArgs(call.args, valued);
	if (hasFlag(parsed, "--no-preserve-root")) return found("data", "rm --no-preserve-root removes the root of the filesystem");
	for (const target of parsed.positionals) {
		if (target.dynamic) return found("data", `${call.program} of a path that is computed when the command runs`);
		if (isWorkspaceRoot(target.text, call.settings) || isWorkspaceWildcard(target.text, call.settings)) return found("data", `${call.program} would remove the whole workspace root or every job's directory in it (${clip(target.text)})`);
		if (!isOwnPath(target.text, call.settings)) return found("data", `${call.program} removes files outside the workspace: ${clip(target.text)}`);
	}
	return undefined;
}

function copying(call: Call): Finding | undefined {
	const parsed = parseArgs(call.args, ["-t", "--target-directory", "-S", "--suffix", "-m", "--mode", "-o", "--owner", "-g", "--group"]);
	if (call.program === "install" && hasFlag(parsed, "-d", "--directory")) return undefined;
	const target = valueOf(parsed, "-t", "--target-directory");
	const destination = target ?? (parsed.positionals.length >= 2 ? parsed.positionals.at(-1) : undefined);
	if (!destination) return undefined;
	const written = checkWrite(destination, `${call.program} writes`, call.settings);
	if (written) return written;
	if (call.program === "mv") for (const source of target ? parsed.positionals : parsed.positionals.slice(0, -1)) {
		const moved = checkWrite(source, "mv takes away", call.settings);
		if (moved) return moved;
	}
	return undefined;
}

function linking(call: Call): Finding | undefined {
	const parsed = parseArgs(call.args, ["-t", "--target-directory", "-S", "--suffix"]);
	const destination = valueOf(parsed, "-t", "--target-directory") ?? (parsed.positionals.length >= 2 ? parsed.positionals.at(-1) : undefined);
	return destination ? checkWrite(destination, "ln creates a link", call.settings) : undefined;
}

function dd(call: Call): Finding | undefined {
	for (const arg of call.args) {
		if (arg.text.startsWith("of=")) {
			const written = checkWrite(word(arg.text.slice(3), arg.dynamic), "dd writes", call.settings);
			if (written) return written;
		}
	}
	return undefined;
}

function tee(call: Call): Finding | undefined {
	const parsed = parseArgs(call.args);
	for (const target of parsed.positionals) {
		const written = checkWrite(target, "tee writes", call.settings);
		if (written) return written;
	}
	return undefined;
}

function permissions(call: Call): Finding | undefined {
	const parsed = parseArgs(call.args, ["--reference", "--from"]);
	const targets = hasFlag(parsed, "--reference") || parsed.flags.some((flag) => flag.name.startsWith("--reference=")) ? parsed.positionals : parsed.positionals.slice(1);
	for (const target of targets) {
		const written = checkWrite(target, `${call.program} changes`, call.settings);
		if (written) return written;
	}
	return undefined;
}

function tar(call: Call): Finding | undefined {
	const args = call.args;
	const first = args[0]?.text ?? "";
	const bundled = !first.startsWith("-") && /^[a-zA-Z]+$/.test(first) ? `-${first}` : "";
	const parsed = parseArgs(bundled ? args.slice(1) : args, ["-f", "--file", "-C", "--directory", "-T", "--files-from", "-X", "--exclude-from", "--exclude", "-I", "--use-compress-program", "--transform", "--strip-components", "--owner", "--group", "-b", "--blocking-factor", "-L", "--tape-length", "-N", "--newer", "--newer-mtime", "--mode", "--one-top-level", "--wildcards"]);
	const letters = bundled + parsed.flags.map((flag) => flag.name).filter((name) => /^-[A-Za-z]+$/.test(name)).join("");
	if (hasFlag(parsed, "--delete", "--remove-files") || parsed.flags.some((flag) => flag.name === "--to-command" || flag.name === "--checkpoint-action")) return found("data", "tar that deletes members or the files it archives");
	if (parsed.flags.some((flag) => ["-I", "--use-compress-program"].includes(flag.name))) return found("unknown", "tar was told to run a program");
	const extracting = /x/.test(letters) || hasFlag(parsed, "--extract", "--get");
	const creating = /[cru]/.test(letters.replace(/--\w+/g, "")) || hasFlag(parsed, "--create", "--append", "--update");
	let archive = parsed.flags.find((flag) => flag.value && (flag.name === "-f" || flag.name === "--file" || /^-[A-Za-z]*f$/.test(flag.name)))?.value;
	if (!archive && bundled) {
		const fIndex = bundled.indexOf("f");
		if (fIndex > 0 && args[1]) archive = args[1];
	}
	if (creating && archive && archive.text !== "-") {
		const written = checkWrite(archive, "tar writes an archive", call.settings);
		if (written) return written;
	}
	if (creating && remote(call.settings)) return found("secrets", "tar archives a directory tree on a machine, which may hold secret files");
	if (extracting) {
		const directory = valueOf(parsed, "-C", "--directory");
		const written = checkWrite(directory ?? word("."), "tar extracts files", call.settings);
		if (written) return written;
	}
	return undefined;
}

function unzip(call: Call): Finding | undefined {
	const parsed = parseArgs(call.args, ["-d", "-x", "-P", "-O", "-I"]);
	if (hasFlag(parsed, "-l", "-p", "-t", "-v", "-z", "-Z")) return undefined;
	return checkWrite(valueOf(parsed, "-d") ?? word("."), "unzip extracts files", call.settings);
}

function zip(call: Call): Finding | undefined {
	const parsed = parseArgs(call.args, ["-b", "-n", "-t", "-tt", "-i", "-x", "-P", "-O", "-fz", "-z", "-ds", "-dc", "-s"]);
	const archive = parsed.positionals[0];
	if (!archive) return undefined;
	const written = checkWrite(archive, "zip writes an archive", call.settings);
	if (written) return written;
	if (hasFlag(parsed, "-m", "--move", "-d", "--delete")) for (const source of parsed.positionals.slice(1)) {
		const removed = checkWrite(source, "zip removes the files it archives", call.settings);
		if (removed) return removed;
	}
	return undefined;
}

function compressor(call: Call): Finding | undefined {
	const parsed = parseArgs(call.args, ["-S", "--suffix", "-p", "-T", "--threads", "-M", "--memlimit", "-C", "--check"]);
	if (hasFlag(parsed, "-c", "--stdout", "--to-stdout", "-t", "--test", "-l", "--list", "-V", "--version", "-h", "--help")) return undefined;
	for (const target of parsed.positionals) {
		const written = checkWrite(target, `${call.program} replaces the file`, call.settings);
		if (written) return written;
	}
	return undefined;
}

const isRemoteOperand = (operand: string): boolean => /^(?:rsync|ssh|sftp|scp):\/\//.test(operand) || /^(?:[\w.-]+@)?[\w.-]+:(?!\/\/)/.test(operand) && !operand.startsWith("/") && !operand.startsWith(".");

function scp(call: Call): Finding | undefined {
	const parsed = parseArgs(call.args, ["-i", "-P", "-l", "-o", "-F", "-J", "-S", "-c", "-D", "-X"]);
	const operands = parsed.positionals;
	if (operands.length < 2) return undefined;
	const destination = operands.at(-1)!;
	if (destination.dynamic || isRemoteOperand(destination.text)) return found("data", `scp copies onto a remote host (${clip(destination.text, 60)})`);
	if (hasFlag(parsed, "-r") && operands.slice(0, -1).some((operand) => isRemoteOperand(operand.text))) return found("secrets", "scp -r copies a directory tree from a host, which may hold secret files");
	return checkWrite(destination, "scp writes", call.settings);
}

function rsync(call: Call): Finding | undefined {
	const parsed = parseArgs(call.args, ["-e", "--rsh", "--exclude", "--include", "--filter", "--port", "--rsync-path", "--chmod", "--timeout", "-T", "--temp-dir", "--backup-dir", "--log-file", "--files-from", "--partial-dir", "-B", "--bwlimit", "--max-size", "--min-size", "--compare-dest", "--link-dest", "--copy-dest", "--info", "--out-format", "--usermap", "--groupmap", "--exclude-from", "--include-from", "-M", "--remote-option"]);
	if (parsed.flags.some((flag) => /^--(?:del|delete\S*|remove-source-files|remove-sent-files)$/.test(flag.name))) return found("data", "rsync --delete removes files at the destination (or --remove-source-files at the source)");
	const rsh = valueOf(parsed, "-e", "--rsh");
	if (rsh && /ProxyCommand|LocalCommand/i.test(rsh.text)) return found("system", "rsync -e runs a proxy command");
	const logFile = valueOf(parsed, "--log-file");
	if (logFile) {
		const written = checkWrite(logFile, "rsync writes its log", call.settings);
		if (written) return written;
	}
	const operands = parsed.positionals;
	if (operands.length < 2) return undefined;
	const destination = operands.at(-1)!;
	if (destination.dynamic || isRemoteOperand(destination.text)) return found("data", `rsync copies onto a remote host (${clip(destination.text, 60)})`);
	if (hasFlag(parsed, "-a", "-r", "--archive", "--recursive") && operands.slice(0, -1).some((operand) => isRemoteOperand(operand.text))) return found("secrets", "rsync copies a directory tree from a host, which may hold secret files");
	return checkWrite(destination, "rsync writes", call.settings);
}

// ---- search and text tools ------------------------------------------------------------------------------------------------------

const KEY_SEARCH = /PRIVATE KEY|BEGIN (?:RSA|EC|OPENSSH|DSA|PGP)|AKIA[0-9A-Z]|ghp_|github_pat_|xox[abprs]-|sk-[A-Za-z0-9]{6}|eyJhbGci/;
const BROAD_ROOTS = /^(?:\/|~|~\/|\/root|\/home|\/etc|\/run|\/var\/lib\/docker|\/proc|\/var\/lib|\/srv|\/opt)\/?$|^\/(?:root|home\/[^/]+|etc|run)(?:\/|$)/;

/** What a pattern has to look like to be the kind that finds code: words that name secrets, and patterns too short or loose to be about one thing, are not. */
const SECRET_WORDS = /token|secret|passw|credential|bearer|api[_-]?key|private[_ -]?key|authoriz|authentic|oauth|cookie|jwt|ssh-|\bBEGIN\b|\bkeys?\b/i;
const specificPattern = (pattern: string): boolean => pattern.replace(/[\\^$.*+?()[\]{}|]/g, "").length >= 4 && !SECRET_WORDS.test(pattern);
/** Project directories a search may name: absolute (or under the home directory), below a root such as /home/<user>, not hidden, not where the system keeps secrets. */
const SEARCHABLE_ROOT = /^(?:\/home\/[^/]+|~|\/srv|\/opt|\/tmp|\/workspace|\/var\/log)\/[^/.][^/]*(?:\/[^/.][^/]*)*\/?$/;

/**
 * A recursive search that cannot sweep up secrets: the roots are named project directories (not a home directory, not a hidden one, not `.`),
 * every pattern is specific and does not look for secrets, and nothing dumps whole files (invert, pass-through, pattern file, wide context).
 * What it prints is lines that match a pattern about code, and the service scrubs the secrets it holds from every answer.
 */
function containedSearch(parsed: Parsed, patterns: string[], patternFile: boolean, roots: Word[]): boolean {
	if (patternFile || patterns.length === 0 || roots.length === 0 || !patterns.every(specificPattern)) return false;
	if (hasFlag(parsed, "-v", "--invert-match", "--passthru", "--hidden", "-u", "--unrestricted", "--no-ignore", "-a", "--text", "-U", "--multiline")) return false;
	for (const flag of parsed.flags) if (["-A", "-B", "-C", "--context", "--after-context", "--before-context"].includes(flag.name) && !(Number(flag.value?.text) <= 5)) return false;
	return roots.every((root) => !root.dynamic && SEARCHABLE_ROOT.test(root.text));
}

function search(call: Call): Finding | undefined {
	const parsed = parseArgs(call.args, ["-e", "--regexp", "-f", "--file", "-m", "--max-count", "-A", "-B", "-C", "--context", "--include", "--exclude", "--exclude-dir", "-d", "--directories", "-D", "--devices", "--label", "-g", "--glob", "--iglob", "--type", "--type-not", "--threads", "--color", "--colour", "--max-depth", "--ignore", "--path-to-ignore", "--type-add", "--sort", "--sortr", "--max-columns", "--encoding"]);
	const patterns = parsed.flags.filter((flag) => flag.name === "-e" || flag.name === "--regexp").map((flag) => flag.value!.text);
	const patternFile = hasFlag(parsed, "-f", "--file");
	const patternSource = patterns.length > 0 || patternFile ? parsed.positionals : parsed.positionals.slice(1);
	if (patterns.length === 0 && !patternFile && parsed.positionals[0]) patterns.push(parsed.positionals[0].text);
	if (patterns.some((pattern) => KEY_SEARCH.test(pattern))) return found("secrets", `${call.program} searches for key material`);
	const recursive = ["ag", "rg", "ack"].includes(call.program) || hasFlag(parsed, "-r", "-R", "--recursive") || valueOf(parsed, "-d", "--directories")?.text === "recurse";
	if (recursive && containedSearch(parsed, patterns, patternFile, patternSource)) return undefined;
	if (recursive) for (const root of patternSource) if (BROAD_ROOTS.test(root.text)) return found("secrets", `${call.program} searches ${clip(root.text, 40)}, which holds secrets`);
	if (recursive && remote(call.settings) && (patternSource.length === 0 || patternSource.some((root) => !/^\/var\/log(?:\/|$)/.test(root.text)))) return found("secrets", `${call.program} searches a directory tree on a machine, which may hold secret files (only /var/log is searched without asking)`);
	return undefined;
}

const SED_WRITES = /(?:^|[;{}\n])\s*(?:\d+|\$|\/(?:\\.|[^/\\])*\/)?(?:\s*,\s*(?:\d+|\$|\/(?:\\.|[^/\\])*\/))?\s*!?\s*[wWeER]\b|\bs(.)(?:(?!\1)[^\\]|\\.)*\1(?:(?!\1)[^\\]|\\.)*\1[a-zA-Z0-9]*[we]/;

function sed(call: Call): Finding | undefined {
	const parsed = parseArgs(call.args, ["-e", "--expression", "-f", "--file", "-l", "--line-length"]);
	const inPlace = parsed.flags.some((flag) => flag.name === "--in-place" || flag.name.startsWith("--in-place=") || /^-[A-Za-z]*i/.test(flag.name));
	if (hasFlag(parsed, "-f", "--file")) return found("unknown", "sed runs a script from a file that cannot be read here");
	const scripts = parsed.flags.filter((flag) => flag.name === "-e" || flag.name === "--expression").map((flag) => flag.value!.text);
	const files = scripts.length > 0 ? parsed.positionals : parsed.positionals.slice(1);
	if (scripts.length === 0 && parsed.positionals[0]) scripts.push(parsed.positionals[0].text);
	if (scripts.some((script) => SED_WRITES.test(script))) return found("data", "sed script that writes a file or runs a command");
	if (inPlace) for (const file of files) {
		const written = checkWrite(file, "sed -i edits", call.settings);
		if (written) return written;
	}
	return undefined;
}

const AWK_DANGER = /\bsystem\s*\(|\bgetline\b|"\s*\|\s*&?|\|\s*["$a-zA-Z_]|\bprintf?\b[^;}\n]*>>?|ENVIRON|PROCINFO|@load|@include|\bclose\s*\(|\bfflush\s*\(/;

function awk(call: Call): Finding | undefined {
	const parsed = parseArgs(call.args, ["-F", "-v", "-f", "--file", "-e", "--source", "-i", "--include", "-l", "--load", "-E", "--exec", "-W", "--field-separator", "--assign"]);
	if (hasFlag(parsed, "-f", "--file", "-i", "--include", "-l", "--load", "-E", "--exec")) return found("unknown", "awk runs a program or extension from a file that cannot be read here");
	const programs = parsed.flags.filter((flag) => flag.name === "-e" || flag.name === "--source").map((flag) => flag.value!.text);
	if (programs.length === 0 && parsed.positionals[0]) programs.push(parsed.positionals[0].text);
	return programs.some((program) => AWK_DANGER.test(program)) ? found("data", "awk program that runs commands, writes files or reads the environment") : undefined;
}

function jq(call: Call): Finding | undefined {
	return texts(call.args).some((entry) => /\benv\b|\$ENV|\binput_filename\b/.test(entry)) ? found("secrets", "jq program that reads the environment") : undefined;
}

function yq(call: Call): Finding | undefined {
	const parsed = parseArgs(call.args, ["-e", "--expression", "-f", "--front-matter", "-I", "--indent", "-p", "--input-format", "-o", "--output-format", "--from-file"]);
	const program = parsed.positionals[0]?.text ?? "";
	if (/\benv\s*\(|\bstrenv\s*\(|\$ENV|\benvsubst\b/.test(program)) return found("secrets", "yq program that reads the environment");
	if (hasFlag(parsed, "-i", "--inplace")) for (const file of parsed.positionals.slice(1)) {
		const written = checkWrite(file, "yq -i edits", call.settings);
		if (written) return written;
	}
	return undefined;
}

/** `uniq in out` and `xxd -r in out` write their second file. */
function secondFileWritten(call: Call): Finding | undefined {
	const parsed = parseArgs(call.args, call.program === "uniq" ? ["-f", "-s", "-w", "--skip-fields", "--skip-chars", "--check-chars"] : ["-c", "-g", "-l", "-s", "-o", "-n", "-R", "-d"]);
	const output = parsed.positionals[1];
	return output ? checkWrite(output, `${call.program} writes its output file`, call.settings) : undefined;
}

function getent(call: Call): Finding | undefined {
	return ["shadow", "gshadow"].includes(call.args.find((arg) => !arg.text.startsWith("-"))?.text ?? "") ? found("secrets", "getent shadow prints password hashes") : undefined;
}

function sort(call: Call): Finding | undefined {
	const parsed = parseArgs(call.args, ["-o", "--output", "-k", "--key", "-t", "--field-separator", "-S", "--buffer-size", "-T", "--temporary-directory", "--parallel", "--batch-size", "--compress-program", "--random-source"]);
	const output = valueOf(parsed, "-o", "--output");
	if (parsed.flags.some((flag) => flag.name === "--compress-program")) return found("unknown", "sort was told to run a program");
	return output ? checkWrite(output, "sort writes", call.settings) : undefined;
}

function find(call: Call): Finding | undefined {
	const args = call.args;
	const startsEnd = args.findIndex((arg) => arg.text.startsWith("-") || arg.text === "(" || arg.text === "!");
	const starts = startsEnd < 0 ? args : args.slice(0, startsEnd);
	const expression = startsEnd < 0 ? [] : args.slice(startsEnd);
	const startsOwn = (starts.length > 0 ? starts : [word(".")]).every((start) => !start.dynamic && isOwnPath(start.text, call.settings));
	const acts = expression.some((arg) => ["-exec", "-execdir", "-ok", "-okdir"].includes(arg.text) || /^-f(?:print0?|printf|ls)$/.test(arg.text));
	for (const [index, arg] of expression.entries()) {
		if (acts && ["-name", "-iname", "-path", "-ipath", "-wholename", "-regex"].includes(arg.text) && expression[index + 1] && secretPathReason(expression[index + 1]!.text.replace(/\\\./g, "."))) return found("secrets", `find -exec on ${clip(expression[index + 1]!.text, 40)} reads secret files it finds`);
	}
	for (let i = 0; i < expression.length; i++) {
		const arg = expression[i]!.text;
		if (arg === "-delete" && !startsOwn) return found("data", "find -delete outside the workspace");
		if (/^-f(?:print0?|printf|ls)$/.test(arg) && expression[i + 1]) {
			const written = checkWrite(expression[i + 1]!, `find ${arg} writes`, call.settings);
			if (written) return written;
		}
		if (["-exec", "-execdir", "-ok", "-okdir"].includes(arg)) {
			let end = i + 1;
			while (end < expression.length && expression[end]!.text !== ";" && expression[end]!.text !== "+") end++;
			const placeholder = startsOwn ? "./found" : "/find-result";
			const inner = expression.slice(i + 1, end).map((entry) => (entry.text.includes("{}") ? { ...entry, text: entry.text.split("{}").join(placeholder) } : entry));
			if (inner.length === 0) return found("unknown", "find -exec without a command");
			const finding = call.runWords(inner);
			if (finding) return finding;
			i = end;
		}
	}
	return undefined;
}

function fd(call: Call): Finding | undefined {
	const index = call.args.findIndex((arg) => ["-x", "--exec", "-X", "--exec-batch"].includes(arg.text));
	if (index < 0) return undefined;
	const inner = call.args.slice(index + 1).map((entry) => (entry.text.includes("{}") ? { ...entry, text: entry.text.split("{}").join("./found") } : entry));
	return inner.length === 0 ? found("unknown", "fd --exec without a command") : call.runWords(inner);
}

function xargs(call: Call): Finding | undefined {
	const parsed = parseArgs(call.args, ["-I", "-n", "-P", "-d", "-L", "-l", "-s", "-E", "-e", "-a", "--arg-file", "--max-args", "--max-procs", "--delimiter", "--max-lines", "--max-chars", "--eof"], true);
	const flag = parsed.flags.find((candidate) => candidate.name === "-I" || candidate.name === "--replace" || candidate.name.startsWith("--replace=") || /^-i/.test(candidate.name));
	const replace = flag ? (flag.value?.text ?? (flag.name.length > 2 && flag.name.startsWith("-i") ? flag.name.slice(2) : "{}")) : undefined;
	const command = parsed.positionals;
	if (command.length === 0) return undefined;
	const input = "/xargs-input";
	const words = replace ? command.map((entry) => ({ ...entry, text: entry.text.split(replace).join(input) })) : [...command, word(input)];
	return call.runWords(words);
}

// ---- wrappers -------------------------------------------------------------------------------------------------------------------

function unwrap(args: Word[], valued: string[], positionals = 0): Word[] {
	let i = 0;
	let skipped = 0;
	for (; i < args.length; i++) {
		const arg = args[i]!;
		if (arg.text === "--") {
			i++;
			break;
		}
		if (arg.text.startsWith("-") && arg.text.length > 1) {
			if (valued.includes(arg.text)) i++;
			continue;
		}
		if (skipped < positionals) {
			skipped++;
			continue;
		}
		break;
	}
	return args.slice(i);
}

const WRAPPER_TABLE: Record<string, { valued: string[]; positionals: number }> = {
	nice: { valued: ["-n", "--adjustment"], positionals: 0 },
	nohup: { valued: [], positionals: 0 },
	time: { valued: ["-f", "--format", "-o", "--output"], positionals: 0 },
	stdbuf: { valued: ["-i", "-o", "-e", "--input", "--output", "--error"], positionals: 0 },
	setsid: { valued: [], positionals: 0 },
	ionice: { valued: ["-c", "-n", "-p", "-P", "-u", "--class", "--classdata"], positionals: 0 },
	chrt: { valued: [], positionals: 1 },
	taskset: { valued: ["-c"], positionals: 1 },
	unbuffer: { valued: [], positionals: 0 },
	timeout: { valued: ["-s", "--signal", "-k", "--kill-after"], positionals: 1 },
	watch: { valued: ["-n", "--interval", "-d", "--differences", "-w", "--width"], positionals: 0 },
	flock: { valued: ["-w", "--timeout", "-E", "--conflict-exit-code"], positionals: 1 },
	builtin: { valued: [], positionals: 0 },
};

/** The command a chain of wrappers (sudo, env, nohup, timeout, xargs, ...) finally runs. */
export function innerCommand(words: Word[]): Word[] {
	let current = words;
	for (let depth = 0; depth < 6 && current.length > 0; depth++) {
		const program = basename(current[0]!.text);
		const rest = current.slice(1);
		const spec = Object.hasOwn(WRAPPER_TABLE, program) ? WRAPPER_TABLE[program]! : undefined;
		if (program === "sudo" || program === "doas") current = unwrap(rest, ["-u", "-g", "-h", "-p", "-C", "-D", "-R", "-T", "-U", "-r", "-t"]);
		else if (program === "env") current = unwrap(rest, ["-u", "-C"]).filter((entry, index, all) => index >= all.findIndex((candidate) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(candidate.text)));
		else if (spec) current = unwrap(rest, spec.valued, spec.positionals);
		else if (program === "command" || program === "exec" || program === "busybox") current = unwrap(rest, []);
		else if (program === "xargs") current = unwrap(rest, ["-I", "-n", "-P", "-d", "-L", "-s", "-E", "-a"]);
		else break;
	}
	return current;
}

function wrapper(call: Call): Finding | undefined {
	const { program, args } = call;
	if (program === "command") {
		if (args.some((arg) => arg.text === "-v" || arg.text === "-V")) return undefined;
		const inner = unwrap(args, []);
		return inner.length === 0 ? undefined : call.runWords(inner);
	}
	if (program === "exec") {
		const inner = unwrap(args, ["-a"]);
		return inner.length === 0 ? undefined : call.runWords(inner);
	}
	if (program === "busybox") return args.length === 0 ? undefined : call.runWords(args);
	if (program === "flock" && args.some((arg) => arg.text === "-c" || arg.text === "--command")) {
		const index = args.findIndex((arg) => arg.text === "-c" || arg.text === "--command");
		return args[index + 1] ? call.runText(args[index + 1]!.text) : found("unknown", "flock -c without a command");
	}
	const spec = WRAPPER_TABLE[program]!;
	const inner = unwrap(args, spec.valued, spec.positionals);
	if (inner.length === 0) return undefined;
	return program === "watch" ? call.runText(joinWords(inner)) : call.runWords(inner);
}

function sudo(call: Call): Finding | undefined {
	const parsed = parseArgs(call.args, ["-u", "-g", "-h", "-p", "-C", "-D", "-R", "-T", "-U", "-r", "-t", "--user", "--group", "--host", "--prompt", "--chdir", "--role", "--type", "--other-user", "--close-from"], true);
	if (hasFlag(parsed, "-e", "--edit")) return found("system", `${call.program} -e edits files as root`);
	const command = parsed.positionals;
	if (command.length === 0) return hasFlag(parsed, "-l", "--list", "-v", "--validate", "-k", "--reset-timestamp", "-K", "--remove-timestamp", "-V", "--version") ? undefined : found("system", `${call.program} opens a shell as root`);
	return call.runWords(command);
}

function su(call: Call): Finding | undefined {
	const parsed = parseArgs(call.args, ["-c", "--command", "-s", "--shell", "-g", "--group", "-G", "--supp-group", "-u", "--user"]);
	const command = valueOf(parsed, "-c", "--command");
	if (command) return call.runText(command.text);
	const separator = call.args.findIndex((arg) => arg.text === "--");
	if (call.program === "runuser" && separator >= 0 && separator + 1 < call.args.length) return call.runWords(call.args.slice(separator + 1));
	return found("system", `${call.program} opens a shell as another user`);
}

function env(call: Call): Finding | undefined {
	const args = call.args;
	let i = 0;
	for (; i < args.length; i++) {
		const arg = args[i]!;
		if (arg.text === "-S" || arg.text === "--split-string") return args[i + 1] ? call.runText(args[i + 1]!.text) : found("unknown", "env -S without a command");
		if (["-u", "--unset", "-C", "--chdir"].includes(arg.text)) i++;
		else if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(arg.text)) {
			const changed = assignmentFinding(arg, call.settings);
			if (changed) return changed;
		} else if (arg.text.startsWith("-")) continue;
		else break;
	}
	const command = args.slice(i);
	if (command.length === 0) return found("secrets", "env prints the environment, which holds secrets");
	return call.runWords(command);
}

// ---- network --------------------------------------------------------------------------------------------------------------------

const CREDENTIAL_HEADER = /^(?:authorization|cookie|proxy-authorization|x-api-key|x-auth\S*|private-token|x-token|x-gitlab-token|x-vault-token)\s*:/i;

function curl(call: Call): Finding | undefined {
	const valued = ["-X", "--request", "-d", "--data", "--data-raw", "--data-binary", "--data-urlencode", "--data-ascii", "--json", "-F", "--form", "--form-string", "-T", "--upload-file", "-H", "--header", "-u", "--user", "-o", "--output", "-b", "--cookie", "-c", "--cookie-jar", "-K", "--config", "-A", "--user-agent", "-e", "--referer", "-m", "--max-time", "--connect-timeout", "-w", "--write-out", "--retry", "--retry-delay", "--retry-max-time", "--resolve", "--cacert", "--capath", "--cert", "-E", "--key", "-x", "--proxy", "--oauth2-bearer", "--netrc-file", "-r", "--range", "-D", "--dump-header", "--limit-rate", "--max-filesize", "-Y", "--speed-limit", "-y", "--speed-time", "--interface", "--dns-servers", "--proxy-user", "-U", "--aws-sigv4", "--unix-socket", "--url", "--output-dir", "--trace", "--trace-ascii", "--stderr", "-z", "--time-cond", "--connect-to", "--hsts", "--alt-svc", "--ciphers", "--tls-max", "--tlsv1", "--pinnedpubkey", "--expect100-timeout", "--happy-eyeballs-timeout-ms", "--local-port", "--proto", "--proto-redir", "--proxy-header", "--request-target", "--sasl-authzid", "--service-name", "--socks5", "--variable", "--ftp-account", "--mail-from", "--mail-rcpt", "--max-redirs", "-C", "--continue-at", "--quote", "-Q", "--telnet-option", "-t", "--krb", "--login-options", "--parallel-max", "--rate", "--retry-connrefused", "--true-url", "--url-query", "--xattr"];
	const parsed = parseArgs(call.args, valued);
	const method = valueOf(parsed, "-X", "--request")?.text.toUpperCase();
	if (method && !["GET", "HEAD", "OPTIONS"].includes(method)) return found("data", `curl -X ${clip(method, 12)} sends a request that changes something`);
	if (hasFlag(parsed, "-d", "--data", "--data-raw", "--data-binary", "--data-urlencode", "--data-ascii", "--json", "-F", "--form", "--form-string", "-T", "--upload-file")) return found("data", "curl sends a body, which changes something at the other end");
	if (hasFlag(parsed, "-u", "--user", "--oauth2-bearer", "--netrc", "-n", "--netrc-file", "--netrc-optional", "-b", "--cookie", "-K", "--config", "--key", "-E", "--cert", "--proxy-user", "-U", "--aws-sigv4")) return found("secrets", "curl with credentials, cookies, a client key or a config file");
	for (const flag of parsed.flags) if ((flag.name === "-H" || flag.name === "--header" || flag.name === "--proxy-header") && flag.value && (CREDENTIAL_HEADER.test(flag.value.text) || flag.value.text.startsWith("@"))) return found("secrets", "curl with an authorization or cookie header");
	for (const flag of parsed.flags) if (["-o", "--output", "-c", "--cookie-jar", "-D", "--dump-header", "--trace", "--trace-ascii", "--stderr"].includes(flag.name) && flag.value) {
		const written = checkWrite(flag.value, "curl writes", call.settings);
		if (written) return written;
		if (flag.name === "-o" || flag.name === "--output") call.shared.downloads.add(flag.value.text);
	}
	if (hasFlag(parsed, "-O", "--remote-name", "--remote-name-all")) {
		const written = checkWrite(word("."), "curl -O writes", call.settings);
		if (written) return written;
		for (const url of parsed.positionals) call.shared.downloads.add(basename(url.text.split("?")[0]!));
	}
	return undefined;
}

function wget(call: Call): Finding | undefined {
	const parsed = parseArgs(call.args, ["-O", "--output-document", "-o", "--output-file", "-a", "--append-output", "-P", "--directory-prefix", "--header", "--post-data", "--post-file", "--body-data", "--body-file", "--method", "--user", "--password", "--http-user", "--http-password", "--ftp-user", "--ftp-password", "--load-cookies", "--save-cookies", "-i", "--input-file", "-t", "--tries", "-T", "--timeout", "-e", "--execute", "--bearer", "--ca-certificate", "--certificate", "--private-key", "-U", "--user-agent", "-w", "--wait", "-Q", "--quota", "-l", "--level", "-A", "--accept", "-R", "--reject", "-X", "--exclude-directories", "-I", "--include-directories", "-D", "--domains", "--proxy-user", "--proxy-password", "--limit-rate"]);
	if (parsed.flags.some((flag) => ["--post-data", "--post-file", "--body-data", "--body-file"].includes(flag.name))) return found("data", "wget sends a body, which changes something at the other end");
	const method = valueOf(parsed, "--method")?.text.toUpperCase();
	if (method && !["GET", "HEAD"].includes(method)) return found("data", `wget --method ${clip(method, 12)} changes something at the other end`);
	if (parsed.flags.some((flag) => ["--user", "--password", "--http-user", "--http-password", "--ftp-user", "--ftp-password", "--load-cookies", "--save-cookies", "--bearer", "--private-key", "--certificate", "--proxy-user", "--proxy-password"].includes(flag.name))) return found("secrets", "wget with credentials, cookies or a client key");
	for (const flag of parsed.flags) if (flag.name === "--header" && flag.value && CREDENTIAL_HEADER.test(flag.value.text)) return found("secrets", "wget with an authorization or cookie header");
	if (hasFlag(parsed, "-e", "--execute")) return found("system", "wget -e runs a wgetrc command");
	const output = valueOf(parsed, "-O", "--output-document");
	if (output && output.text !== "-") {
		const written = checkWrite(output, "wget writes", call.settings);
		if (written) return written;
		call.shared.downloads.add(output.text);
		return undefined;
	}
	if (output?.text === "-") return undefined;
	for (const flag of ["-o", "--output-file", "-a", "--append-output", "-P", "--directory-prefix"]) {
		const target = valueOf(parsed, flag);
		if (target) {
			const written = checkWrite(target, "wget writes", call.settings);
			if (written) return written;
		}
	}
	const written = checkWrite(valueOf(parsed, "-P", "--directory-prefix") ?? word("."), "wget writes", call.settings);
	if (written) return written;
	for (const url of parsed.positionals) call.shared.downloads.add(basename(url.text.split("?")[0]!));
	return undefined;
}

const SSH_VALUED = ["-b", "-c", "-D", "-E", "-e", "-F", "-I", "-i", "-J", "-L", "-l", "-m", "-O", "-o", "-p", "-Q", "-R", "-S", "-W", "-w"];

function ssh(call: Call): Finding | undefined {
	const parsed = parseArgs(call.args, SSH_VALUED, true);
	for (const flag of parsed.flags) {
		if (["-L", "-R", "-D", "-W", "-w"].includes(flag.name)) return found("system", `ssh ${flag.name} opens a tunnel`);
		if (flag.name === "-F" && flag.value?.text !== "/dev/null") return found("system", "ssh -F reads a configuration that can run a program");
		if (flag.name === "-o" && /^\s*(?:ProxyCommand|LocalCommand|PermitLocalCommand|RemoteCommand|KnownHostsCommand|ProxyJump|Tunnel|LocalForward|RemoteForward|DynamicForward)\b/i.test(flag.value?.text ?? "")) return found("system", `ssh -o ${clip(flag.value!.text, 30)} runs a program or opens a tunnel`);
		if (flag.name === "-J") return found("system", "ssh -J goes through another host");
	}
	const [target, ...command] = parsed.positionals;
	if (!target) return found("unknown", "ssh without a host");
	if (target.dynamic) return found("unknown", "ssh to a host that is computed when the command runs");
	if (isHypervisorName(target.text, call.settings.hypervisorHosts)) return found("hypervisor", `ssh to the hypervisor ${clip(target.text, 40)}`);
	if (command.length === 0) return found("unknown", "ssh without a command opens an interactive session");
	return call.runText(joinWords(command), { ...call.settings, host: target.text.replace(/^.*@/, ""), workspaces: [] }, call.io);
}

// ---- the system -----------------------------------------------------------------------------------------------------------------

function firewall(call: Call): Finding | undefined {
	const names = texts(call.args);
	switch (call.program) {
		case "iptables":
		case "ip6tables":
		case "ebtables":
		case "arptables": {
			const mutating = names.some((name) => /^-[AIDRFXPNEZ]$/.test(name) || /^--(?:append|insert|delete|replace|flush|delete-chain|policy|new-chain|rename-chain|zero)(?:=|$)/.test(name) || (/^-[A-Za-z]{2,}$/.test(name) && /[AIDRFXPNEZ]/.test(name.slice(1))));
			const reads = names.some((name) => /^(?:-[A-Za-z]*[LSC][A-Za-z]*|--list|--list-rules|--check|--version|-V|--help|-h)$/.test(name));
			return reads && !mutating ? undefined : found("firewall", `${call.program} changes firewall rules`);
		}
		case "nft":
			return names.some((name) => ["add", "delete", "flush", "insert", "replace", "create", "destroy", "rename", "reset", "-f", "--file", "-i", "--interactive"].includes(name)) || !names.some((name) => ["list", "--version", "-v", "--help", "-h"].includes(name)) ? found("firewall", "nft changes firewall rules") : undefined;
		case "ufw":
			return ["status", "version", "show", "--version"].includes(names.find((name) => !name.startsWith("-")) ?? "") || names.includes("--version") ? undefined : found("firewall", "ufw changes firewall rules");
		case "firewall-cmd":
			return names.length > 0 && names.every((name) => /^--(?:list-\w+|get-\w+|state|query-\w+|info-\w+|version|help|zone=\S+|permanent)$/.test(name) || !name.startsWith("-")) && !names.some((name) => /--(?:add|remove|set|change|reload|complete-reload|runtime-to-permanent|panic|lockdown|new|delete|load-zone-defaults)/.test(name)) ? undefined : found("firewall", "firewall-cmd changes firewall rules");
		case "iptables-restore":
		case "ip6tables-restore":
		case "nft-restore":
		case "netsh":
		case "pfctl":
		case "ipset":
		case "conntrack":
		case "iptables-apply":
		case "fail2ban-client":
		case "csf":
			return found("firewall", `${call.program} changes firewall rules`);
		default:
			return found("firewall", `${call.program} changes firewall rules`);
	}
}

const SYSTEMCTL_READ = new Set(["status", "show", "cat", "is-active", "is-enabled", "is-failed", "list-units", "list-unit-files", "list-timers", "list-sockets", "list-dependencies", "list-jobs", "get-default", "list-machines", "help"]);
const SYSTEMCTL_RESTART = new Set(["restart", "start", "stop", "reload", "try-restart", "reload-or-restart", "try-reload-or-restart", "kill"]);

const ownService = (unit: string, settings: Settings): boolean => settings.ownServices.some((pattern) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}(?:\\.service)?$`).test(unit));

function systemctl(call: Call): Finding | undefined {
	const parsed = parseArgs(call.args, ["-t", "--type", "-p", "--property", "-n", "--lines", "-o", "--output", "-s", "--state", "--signal", "-M", "--machine", "-H", "--host", "--root", "-P", "--value"]);
	const properties = parsed.flags.filter((flag) => flag.name === "-p" || flag.name === "--property").map((flag) => flag.value?.text ?? "");
	if (parsed.positionals[0]?.text === "show" && (properties.length === 0 || properties.some((property) => /Environment|Exec/i.test(property)))) return found("secrets", "systemctl show without a property filter prints the unit's environment, which may hold secrets");
	if (parsed.flags.some((flag) => flag.name === "-H" || flag.name === "--host" || flag.name === "-M" || flag.name === "--machine")) return found("system", "systemctl on another host or machine");
	const [verb, ...units] = parsed.positionals;
	if (!verb) return undefined;
	if (SYSTEMCTL_READ.has(verb.text)) return undefined;
	if (SYSTEMCTL_RESTART.has(verb.text)) return units.length > 0 && units.every((unit) => !unit.dynamic && ownService(unit.text, call.settings)) ? undefined : found("system", `systemctl ${verb.text} on a host service that is not one of the agent's own (${clip(units.map((unit) => unit.text).join(" "), 50)})`);
	return found("system", `systemctl ${clip(verb.text, 30)} changes the host's services`);
}

function service(call: Call): Finding | undefined {
	const names = call.args.filter((arg) => !arg.text.startsWith("-"));
	if (names[0]?.text === "--status-all" || call.args.some((arg) => arg.text === "--status-all")) return undefined;
	const [unit, verb] = names;
	if (!unit || !verb) return undefined;
	if (verb.text === "status") return undefined;
	if (SYSTEMCTL_RESTART.has(verb.text) || verb.text === "force-reload") return !unit.dynamic && ownService(unit.text, call.settings) ? undefined : found("system", `service ${verb.text} on a host service that is not one of the agent's own (${clip(unit.text, 40)})`);
	return found("system", `service ${clip(verb.text, 30)} changes the host's services`);
}

function journalctl(call: Call): Finding | undefined {
	return call.args.some((arg) => /^--(?:vacuum-\w+|rotate|flush|sync|relinquish-var|smart-relinquish-var|setup-keys|update-catalog|rotate)(?:=|$)/.test(arg.text)) ? found("data", "journalctl that removes or rotates the journal") : undefined;
}

function dmesg(call: Call): Finding | undefined {
	return call.args.some((arg) => /^(?:-[A-Za-z]*[cC][A-Za-z]*|--clear|--read-clear)$/.test(arg.text)) ? found("data", "dmesg --clear empties the kernel log") : undefined;
}

function sysctl(call: Call): Finding | undefined {
	const parsed = parseArgs(call.args, ["-p", "--load", "-N"]);
	const writes = hasFlag(parsed, "-w", "--write", "-p", "--load", "--system") || parsed.positionals.some((entry) => entry.text.includes("="));
	return writes ? found("system", "sysctl changes kernel settings") : undefined;
}

function crontab(call: Call): Finding | undefined {
	const parsed = parseArgs(call.args, ["-u"]);
	return hasFlag(parsed, "-l") && parsed.positionals.length === 0 && !hasFlag(parsed, "-r", "-e", "-i") ? undefined : found("system", "crontab changes or removes scheduled jobs");
}

function ps(call: Call): Finding | undefined {
	const parsed = parseArgs(call.args, ["-o", "-p", "-C", "-u", "-U", "-g", "-G", "-t", "-s", "-O", "--sort", "--pid", "--ppid", "--format", "-N", "--user", "--group", "--tty", "--cols", "--columns", "--width", "--rows", "--lines"]);
	const bsd = parsed.positionals.find((arg) => /^[A-Za-z]+$/.test(arg.text));
	if (bsd?.text.includes("e")) return found("secrets", "ps with the e option prints every process's environment");
	return parsed.flags.some((flag) => /^-[A-Za-z]*E/.test(flag.name) || flag.name === "--environment") ? found("secrets", "ps prints process environments") : undefined;
}

function date(call: Call): Finding | undefined {
	const parsed = parseArgs(call.args, ["-d", "--date", "-f", "--file", "-r", "--reference", "-s", "--set"]);
	return hasFlag(parsed, "-s", "--set") || parsed.positionals.some((entry) => /^\d{8,12}(?:\.\d\d)?$/.test(entry.text)) ? found("system", "date sets the clock") : undefined;
}

function hostname(call: Call): Finding | undefined {
	const parsed = parseArgs(call.args, ["-F", "--file"]);
	return parsed.positionals.length > 0 || hasFlag(parsed, "-F", "--file") ? found("system", "hostname changes the host's name") : undefined;
}

function ip(call: Call): Finding | undefined {
	const words = texts(call.args).filter((entry) => !entry.startsWith("-"));
	if (call.args.some((arg) => arg.text === "-b" || arg.text === "-batch" || arg.text === "-force")) return found("system", "ip -batch changes network configuration");
	return words.slice(1).some((entry) => ["add", "del", "delete", "flush", "set", "replace", "change", "append", "exec", "up", "down", "attach", "link-netns"].includes(entry)) || words[0] === "netns" && words[1] === "exec" ? found("system", "ip changes network configuration") : undefined;
}

function ifconfig(call: Call): Finding | undefined {
	const names = texts(call.args).filter((entry) => !entry.startsWith("-"));
	return names.length > 1 ? found("system", "ifconfig changes network configuration") : undefined;
}

const SYSTEM_CHANGERS: Record<string, string> = {
	shutdown: "shutdown stops the machine",
	reboot: "reboot restarts the machine",
	halt: "halt stops the machine",
	poweroff: "poweroff stops the machine",
	init: "init changes the runlevel",
	telinit: "telinit changes the runlevel",
	useradd: "useradd changes accounts",
	userdel: "userdel changes accounts",
	usermod: "usermod changes accounts",
	groupadd: "groupadd changes accounts",
	groupdel: "groupdel changes accounts",
	groupmod: "groupmod changes accounts",
	passwd: "passwd changes a password",
	chpasswd: "chpasswd changes passwords",
	chage: "chage changes password policy",
	visudo: "visudo changes who may become root",
	vipw: "vipw edits the account database",
	adduser: "adduser changes accounts",
	deluser: "deluser changes accounts",
	chsh: "chsh changes a login shell",
	newusers: "newusers changes accounts",
	mount: "mount changes what is attached to the filesystem",
	umount: "umount detaches storage",
	swapon: "swapon changes swap",
	swapoff: "swapoff changes swap",
	modprobe: "modprobe loads or unloads kernel modules",
	insmod: "insmod loads a kernel module",
	rmmod: "rmmod unloads a kernel module",
	depmod: "depmod rewrites module dependencies",
	chroot: "chroot runs a command in another root",
	nsenter: "nsenter enters other namespaces",
	unshare: "unshare runs a command in new namespaces",
	setpriv: "setpriv changes privileges",
	capsh: "capsh changes capabilities",
	setcap: "setcap changes file capabilities",
	newgrp: "newgrp changes the group",
	sg: "sg runs a command as another group",
	"update-grub": "update-grub rewrites the boot configuration",
	"grub-install": "grub-install writes the boot loader",
	"update-initramfs": "update-initramfs rewrites the boot image",
	timedatectl: "timedatectl changes the clock",
	hostnamectl: "hostnamectl changes the host",
	localectl: "localectl changes the locale",
	loginctl: "loginctl changes sessions",
	resolvectl: "resolvectl changes name resolution",
	networkctl: "networkctl changes the network",
	nmcli: "nmcli changes network connections",
	netplan: "netplan changes network configuration",
	ethtool: "ethtool changes network devices",
	brctl: "brctl changes bridges",
	route: "route changes routing",
	tc: "tc changes traffic control",
	bridge: "bridge changes bridges",
	wg: "wg changes WireGuard",
	"wg-quick": "wg-quick changes WireGuard",
	screen: "screen starts a session that cannot be checked",
	tmux: "tmux can type anything into a session",
	script: "script runs a recorded shell",
};

const DISK_TOOLS = new Set(["fdisk", "sfdisk", "cfdisk", "parted", "gdisk", "sgdisk", "mkswap", "wipefs", "blkdiscard", "cryptsetup", "lvremove", "vgremove", "pvremove", "lvcreate", "vgcreate", "pvcreate", "lvextend", "lvreduce", "vgextend", "vgreduce", "mdadm", "fsck", "e2fsck", "tune2fs", "resize2fs", "xfs_repair", "losetup", "mkfs", "mke2fs", "partprobe", "hdparm", "zpool", "zfs", "btrfs", "xfs_growfs", "growpart", "pvresize", "lvresize", "dmsetup", "fstrim"]);

function kill(call: Call): Finding | undefined {
	if (remote(call.settings)) return found("system", `${call.program} ends processes on a machine that is not the agent's workspace`);
	const numbers = texts(call.args).filter((entry) => /^-?\d+$/.test(entry));
	return numbers.slice(numbers.length > 1 ? 1 : 0).some((entry) => entry === "1" || entry === "-1" || entry === "0") ? found("system", `${call.program} would end every process or init`) : undefined;
}

const PACKAGE_READ: Record<string, string[]> = {
	apt: ["list", "show", "search", "policy", "depends", "rdepends", "showpkg", "--version", "-v"],
	"apt-get": ["--version", "-v", "check", "changelog", "source-check"],
	"apt-cache": ["search", "show", "policy", "depends", "rdepends", "showpkg", "stats", "madison", "--version"],
	dpkg: ["-l", "-L", "-s", "-S", "-p", "--list", "--listfiles", "--status", "--search", "-V", "--verify", "--get-selections", "--version", "-C", "--audit"],
	"dpkg-query": ["-l", "-L", "-s", "-S", "-W", "--list", "--listfiles", "--status", "--search", "--show", "--version"],
	snap: ["list", "info", "find", "version", "services", "logs", "--version"],
	rpm: ["-q", "-qa", "-qi", "-ql", "-qf", "-V", "--version", "--query", "--verify"],
	yum: ["list", "info", "search", "repolist", "provides", "--version", "check-update"],
	dnf: ["list", "info", "search", "repolist", "provides", "--version", "check-update"],
	apk: ["info", "list", "search", "--version", "version"],
	brew: ["list", "info", "search", "outdated", "--version", "--prefix", "deps", "uses", "config"],
	pacman: ["-Q", "-Qi", "-Ql", "-Qs", "-Ss", "-Si", "--version", "-V"],
	zypper: ["search", "info", "list-updates", "--version"],
};

function packages(call: Call): Finding | undefined {
	const allowed = PACKAGE_READ[call.program] ?? [];
	const first = call.args.find((arg) => !arg.text.startsWith("-") || allowed.includes(arg.text));
	return first && allowed.includes(first.text) ? undefined : found("system", `${call.program} ${clip(first?.text ?? "", 20)} changes installed system packages`.replace(/ +/g, " "));
}

const SECRET_TOOLS: Record<string, string> = {
	op: "1Password",
	pass: "the password store",
	gpg: "gpg keys and encrypted data",
	gpg2: "gpg keys and encrypted data",
	gpgconf: "gpg configuration",
	"gpg-agent": "the gpg agent",
	age: "age encryption keys",
	"age-keygen": "age keys",
	sops: "encrypted secrets",
	vault: "HashiCorp Vault",
	security: "the macOS keychain",
	"secret-tool": "the desktop keyring",
	keyctl: "the kernel keyring",
	"ssh-keygen": "ssh keys",
	"ssh-add": "the ssh agent's keys",
	"ssh-agent": "the ssh agent",
	"ssh-copy-id": "authorized ssh keys",
	certbot: "certificates and their keys",
	lego: "certificates and their keys",
	"acme.sh": "certificates and their keys",
	step: "certificate keys",
	cfssl: "certificate keys",
	cmdkey: "stored Windows credentials",
	vaultcmd: "stored Windows credentials",
	mimikatz: "credentials",
	printenv: "the environment",
	history: "the shell history, which holds secrets typed on the command line",
	"git-credential": "git credentials",
	"docker-credential-desktop": "docker credentials",
};

function openssl(call: Call): Finding | undefined {
	const [sub] = texts(call.args).filter((entry) => !entry.startsWith("-"));
	if (!sub || !["version", "s_client", "x509", "verify", "ciphers", "list", "help", "dgst", "crl"].includes(sub)) return found("secrets", `openssl ${clip(sub ?? "", 20)} generates, converts or reads key material or random secrets`.replace(/ +/g, " "));
	return texts(call.args).some((entry) => /^-(?:key|signkey|CAkey|passin|passout|pass|sign|hmac|prverify|keyform|decrypt|noout-key)$/.test(entry)) ? found("secrets", "openssl with a private key or password") : undefined;
}

// ---- developer tools ------------------------------------------------------------------------------------------------------------

const NPM_REMOTE_RUNS = new Set(["run", "run-script", "test", "t", "tst", "start", "stop", "restart", "exec", "ci", "install", "i", "add", "rebuild", "version", "pkg", "x", "install-test", "it", "install-ci-test", "cit", "dlx", "create", "init"]);
const NPM_FORBIDDEN = new Set(["publish", "unpublish", "deprecate", "dist-tag", "owner", "access", "token", "login", "logout", "adduser", "profile", "team", "org", "hook", "star", "unstar", "set-script", "link", "unlink", "ln", "config", "c", "get", "set", "npmrc", "completion", "bugs", "repo", "docs"]);
const NPM_OK = new Set(["run", "run-script", "test", "t", "tst", "start", "stop", "restart", "exec", "ci", "install", "i", "add", "remove", "rm", "uninstall", "un", "ls", "list", "ll", "la", "outdated", "audit", "view", "info", "show", "v", "pack", "prune", "dedupe", "rebuild", "version", "pkg", "explain", "why", "doctor", "fund", "search", "help", "bin", "root", "prefix", "whoami", "ping", "install-test", "it", "install-ci-test", "cit", "update", "up", "upgrade", "x", "--version", "-v", "-h", "--help", "cache", "diff", "init", "query", "sbom", "stars", "cache"]);

function npm(call: Call): Finding | undefined {
	const parsed = parseArgs(call.args, ["--prefix", "-C", "--cwd", "--dir", "--registry", "-w", "--workspace", "--filter", "-F", "--userconfig", "--globalconfig", "--cache", "--tag", "--otp", "--scope", "--access"]);
	if (hasFlag(parsed, "-g", "--global") || parsed.flags.some((flag) => flag.name === "--location" && flag.value?.text === "global")) return found("system", `${call.program} with --global installs outside the workspace`);
	const registryTarget = parsed.flags.find((flag) => flag.name === "--prefix" || flag.name === "--userconfig" || flag.name === "--globalconfig" || flag.name === "--cache");
	if (registryTarget?.value && !isOwnPath(registryTarget.value.text, call.settings)) return found("data", `${call.program} ${registryTarget.name} points outside the workspace`);
	const sub = parsed.positionals[0]?.text;
	if (call.program === "npx" || call.program === "bunx") return call.args.some((arg) => ["--no-install", "--no", "--offline"].includes(arg.text)) ? undefined : found("download", `${call.program} downloads and runs a package from the registry`);
	if (!sub) return undefined;
	if (sub === "dlx" || sub === "create" || sub === "init") return found("download", `${call.program} ${sub} downloads and runs a package from the registry`);
	if (NPM_FORBIDDEN.has(sub)) return found(sub === "config" || sub === "c" || sub === "get" || sub === "set" || sub === "token" || sub === "login" || sub === "logout" || sub === "adduser" || sub === "npmrc" ? "secrets" : "system", `${call.program} ${sub} publishes or changes registry credentials and settings`);
	if (sub === "cache" && !parsed.positionals.slice(1).some((entry) => ["ls", "ls-cache", "verify"].includes(entry.text))) return found("data", `${call.program} cache removes cached packages outside the workspace`);
	if (remote(call.settings) && NPM_REMOTE_RUNS.has(sub)) return found("unknown", `${call.program} ${sub} runs code on a machine that is not the agent's workspace`);
	if (NPM_OK.has(sub)) return undefined;
	if (["yarn", "pnpm", "bun"].includes(call.program)) return remote(call.settings) ? found("unknown", `${call.program} ${clip(sub, 20)} runs a script on a machine that is not the agent's workspace`) : undefined;
	return found("unknown", `${call.program} ${clip(sub, 30)} is not a command this agent may run without asking`);
}

function cargo(call: Call): Finding | undefined {
	const sub = call.args.find((arg) => !arg.text.startsWith("-") && !arg.text.startsWith("+"))?.text;
	if (!sub) return undefined;
	if (["publish", "login", "logout", "owner", "yank", "install", "uninstall", "package"].includes(sub)) return found(["login", "logout", "owner", "yank"].includes(sub) ? "secrets" : "system", `cargo ${sub} publishes or changes what is installed outside the workspace`);
	if (remote(call.settings) && !["version", "help", "tree", "metadata", "locate-project", "search"].includes(sub)) return found("unknown", `cargo ${clip(sub, 20)} runs code on a machine that is not the agent's workspace`);
	return undefined;
}

function pip(call: Call): Finding | undefined {
	const parsed = parseArgs(call.args, ["-r", "--requirement", "-c", "--constraint", "-t", "--target", "-i", "--index-url", "--extra-index-url", "-f", "--find-links", "--prefix", "--root", "--python", "--cache-dir", "-e", "--editable", "--python-version", "--platform", "--abi", "--implementation", "--progress-bar", "--proxy", "--retries", "--timeout", "--exists-action", "--trusted-host", "--cert", "--client-cert", "--log", "--isolated"]);
	const sub = parsed.positionals[0]?.text;
	if (!sub || ["list", "show", "freeze", "check", "download", "wheel", "index", "inspect", "debug", "hash", "help", "--version"].includes(sub)) return undefined;
	if (sub === "install") {
		if (hasFlag(parsed, "--user", "--break-system-packages", "--root-user-action", "--force-reinstall") || parsed.flags.some((flag) => flag.name === "--break-system-packages" || flag.name === "--prefix" || flag.name === "--root")) return found("system", "pip install outside the project's environment");
		const target = valueOf(parsed, "-t", "--target");
		if (target) {
			const written = checkWrite(target, "pip install writes", call.settings);
			if (written) return written;
		}
		return remote(call.settings) ? found("system", "pip install changes a machine that is not the agent's workspace") : undefined;
	}
	return found("system", `pip ${clip(sub, 20)} removes packages or changes pip's configuration`);
}

function uv(call: Call): Finding | undefined {
	const sub = call.args.find((arg) => !arg.text.startsWith("-"))?.text;
	if (!sub || ["run", "sync", "lock", "add", "remove", "venv", "tree", "export", "build", "version", "help", "init"].includes(sub)) return remote(call.settings) && sub && sub !== "version" && sub !== "help" ? found("unknown", `uv ${sub} runs code on a machine that is not the agent's workspace`) : undefined;
	if (sub === "pip") return pip({ ...call, args: call.args.slice(call.args.findIndex((arg) => arg.text === "pip") + 1) });
	if (["tool", "publish", "self", "cache"].includes(sub)) return found("system", `uv ${sub} installs, publishes or removes things outside the project`);
	return found("unknown", `uv ${clip(sub, 20)} is not a command this agent may run without asking`);
}

const CODE_RUNNERS = new Set(["make", "gmake", "cmake", "ctest", "ninja", "meson", "gradle", "gradlew", "mvn", "mvnw", "go", "rustc", "gcc", "g++", "cc", "c++", "clang", "clang++", "ld", "tsc", "eslint", "prettier", "jest", "vitest", "mocha", "pytest", "ruff", "black", "mypy", "flake8", "rustfmt", "clippy-driver", "dotnet", "bazel", "bazelisk", "just", "task", "javac", "java", "kotlinc", "swift", "swiftc", "zig", "nim", "tox", "nox", "poetry", "pipx", "rake", "bundle", "gem", "composer", "sbt", "lein", "stack", "cabal", "ghc", "ocaml", "dune", "opam", "elixir", "mix", "erl", "rebar3", "tsx", "ts-node", "biome", "oxlint", "playwright", "cypress", "wasm-pack", "trunk", "cross", "sccache", "ccache", "strip", "ar", "ranlib", "protoc", "buf", "gofmt", "goimports", "golangci-lint", "staticcheck", "shellcheck", "yamllint", "hadolint", "actionlint", "markdownlint", "typos", "taplo", "sqlfluff", "codespell", "bun-test", "vite", "webpack", "esbuild", "rollup", "parcel", "turbo", "nx", "lerna"]);

function codeRunner(call: Call): Finding | undefined {
	if (remote(call.settings)) return found("unknown", `${call.program} runs code on a machine that is not the agent's workspace`);
	const words = texts(call.args);
	if (call.program === "dotnet" && words[0] === "nuget" && ["push", "delete", "add", "remove", "locals"].includes(words[1] ?? "")) return found("system", "dotnet nuget changes or publishes packages");
	if (call.program === "dotnet" && words[0] === "tool" && words.includes("-g")) return found("system", "dotnet tool -g installs outside the workspace");
	if (call.program === "go" && words[0] === "clean" && words.some((entry) => /^-(?:modcache|cache|fuzzcache|testcache)$/.test(entry))) return found("data", "go clean removes the module cache outside the workspace");
	if (["pipx", "gem"].includes(call.program) && words.some((entry) => ["install", "uninstall", "push", "yank", "login", "logout", "update", "upgrade", "cleanup", "owner"].includes(entry))) return found("system", `${call.program} installs or publishes outside the project`);
	if (["poetry", "composer", "bundle"].includes(call.program) && words.some((entry) => ["publish", "push", "login", "logout", "config", "self", "global", "--global", "remove"].includes(entry))) return found("system", `${call.program} publishes or changes things outside the project`);
	return undefined;
}

// ---- GitHub, CI and Windows -----------------------------------------------------------------------------------------------------

const GH_ALLOWED: Record<string, string[] | "any"> = {
	pr: ["view", "list", "checks", "diff", "status", "create", "comment", "ready", "review", "merge", "edit", "close", "reopen", "checkout"],
	run: ["list", "view", "watch", "download", "rerun"],
	workflow: ["list", "view", "run"],
	repo: ["view", "list", "clone"],
	issue: ["list", "view", "create", "comment", "status", "edit", "close", "reopen"],
	release: ["list", "view", "download"],
	status: "any",
	search: "any",
	browse: "any",
	api: "any",
	auth: ["status"],
	"--version": "any",
	version: "any",
	help: "any",
	label: ["list"],
	cache: ["list"],
};

function gh(call: Call): Finding | undefined {
	const names = texts(call.args).filter((entry) => !entry.startsWith("-"));
	const [sub, action] = names;
	if (!sub) return undefined;
	if (["auth", "secret", "ssh-key", "gpg-key"].includes(sub) && !(sub === "auth" && action === "status")) return found("secrets", `gh ${sub} handles tokens and keys`);
	const allowed = GH_ALLOWED[sub];
	if (!allowed) return found("unknown", `gh ${clip(sub, 20)} is not a command this agent may run without asking`);
	if (sub === "auth" && call.args.some((arg) => arg.text === "-t" || arg.text === "--show-token")) return found("secrets", "gh auth status --show-token prints the token");
	if (sub === "api") {
		const parsed = parseArgs(call.args.slice(1), ["-X", "--method", "-f", "--raw-field", "-F", "--field", "-H", "--header", "--input", "-q", "--jq", "-t", "--template", "--cache", "--hostname"]);
		const method = valueOf(parsed, "-X", "--method")?.text.toUpperCase();
		if ((method && method !== "GET") || hasFlag(parsed, "-f", "--raw-field", "-F", "--field", "--input")) return found("data", "gh api that sends a body or a non-GET method changes something on GitHub");
		if (parsed.flags.some((flag) => (flag.name === "-H" || flag.name === "--header") && flag.value && CREDENTIAL_HEADER.test(flag.value.text))) return found("secrets", "gh api with an authorization header");
		return undefined;
	}
	if (allowed === "any") return undefined;
	return action && allowed.includes(action) ? undefined : found("data", `gh ${sub} ${clip(action ?? "", 20)} deletes, configures or publishes on GitHub`.replace(/ +/g, " "));
}

function woodpecker(call: Call): Finding | undefined {
	const names = texts(call.args).filter((entry) => !entry.startsWith("-"));
	const [sub, action] = names;
	if (!sub || sub === "info" || sub === "help" || sub === "--version") return undefined;
	if (sub === "pipeline" && ["ls", "list", "info", "last", "logs", "ps", "create", "start", "show"].includes(action ?? "")) return undefined;
	if (sub === "repo" && ["ls", "list", "show", "info"].includes(action ?? "")) return undefined;
	return found("data", `woodpecker-cli ${clip(`${sub} ${action ?? ""}`.trim(), 30)} removes, stops or changes CI state`);
}

const WINDOWS_CHANGES = /\b(?:Remove-\w+|ri|del|erase|rd|rmdir|rm|Clear-\w+|Format-Volume|Initialize-Disk|New-Partition|Stop-Computer|Restart-Computer|Stop-\w+|Restart-\w+|Set-\w+|New-\w+|Add-\w+|Move-Item|Copy-Item|Rename-Item|Out-File|Start-Process|Invoke-Expression|iex|Invoke-WebRequest|iwr|Invoke-RestMethod|irm|Invoke-Command|Enter-PSSession|DownloadString|DownloadFile|Install-\w+|Uninstall-\w+|Disable-\w+|Enable-\w+|Unregister-\w+|Register-\w+|Export-\w+|Import-\w+|ConvertFrom-SecureString|ConvertTo-SecureString|Get-Credential|Get-Secret|reg(?:\.exe)?\s+(?:add|delete|import|save|restore)|schtasks|sc(?:\.exe)?\s+(?:delete|stop|config|create)|taskkill|net\s+(?:user|localgroup|stop|start|use)|netsh|\w*NetFirewall\w*|cipher\s+\/w|format(?:\.com)?\s+[a-z]:|diskpart|bcdedit|wmic|icacls|takeown|attrib|robocopy|xcopy|move|copy|ren|mklink|cmdkey|vaultcmd|mimikatz|-EncodedCommand|-enc\b|-ExecutionPolicy\s+Bypass)\b|>>?\s*[\w"'$.\\/:~-]/i;
const WINDOWS_SECRETS = /\benv:|\$env:|\bset\s*$|%[A-Za-z_]*(?:TOKEN|SECRET|KEY|PASS)[A-Za-z_]*%|\\secrets\\|(?:\.env|\.pem|\.pfx|id_rsa|\.ssh\\|credentials)/i;

function windows(call: Call): Finding | undefined {
	const args = texts(call.args);
	const encoded = args.find((entry) => /^-e(?:nc|ncodedcommand)?$/i.test(entry));
	if (encoded) return found("unknown", `${call.program} -EncodedCommand hides the command`);
	const file = args.findIndex((entry) => /^-file$/i.test(entry));
	if (file >= 0 && call.args[file + 1]) return runsScript(call.args[file + 1]!, call);
	const index = args.findIndex((entry) => /^(?:-c|-command|\/c|\/k)$/i.test(entry));
	const text = index >= 0 ? args.slice(index + 1).join(" ") : args.filter((entry) => !entry.startsWith("-")).join(" ");
	if (text === "") return found("unknown", `${call.program} without a command cannot be checked`);
	if (WINDOWS_SECRETS.test(text)) return found("secrets", `${call.program} command that reads the environment or secret files`);
	if (WINDOWS_CHANGES.test(text)) return found("system", `${call.program} command that changes the system or runs downloaded code`);
	const verbs = [...text.matchAll(/\b([A-Za-z]+)-[A-Za-z]+\b/g)].map((match) => match[1]!.toLowerCase());
	const harmless = new Set(["get", "test", "select", "where", "measure", "format", "sort", "group", "write", "out", "convertto", "resolve", "split", "join", "foreach", "compare", "start", "show", "read", "new"]);
	return verbs.some((verb) => !harmless.has(verb)) ? found("system", `${call.program} cmdlet that is not a plain read`) : undefined;
}

// ---- the table ------------------------------------------------------------------------------------------------------------------

function script(call: Call): Finding | undefined {
	const target = call.args[0];
	if (!target) return undefined;
	return runsScript(target, call);
}

function evaluate(call: Call): Finding | undefined {
	if (call.args.some((arg) => arg.dynamic)) return found("unknown", "eval of text computed when the command runs");
	return call.args.length === 0 ? undefined : call.runText(joinWords(call.args));
}

function trap(call: Call): Finding | undefined {
	const action = call.args.find((arg) => !arg.text.startsWith("-"));
	return !action || action.text === "" || action.text === "-" ? undefined : call.runText(action.text);
}

function declaring(call: Call): Finding | undefined {
	const parsed = parseArgs(call.args);
	const assignments = parsed.positionals.length > 0;
	if (call.program === "declare" || call.program === "typeset" || call.program === "export" || call.program === "readonly" || call.program === "local") {
		if (hasFlag(parsed, "-f", "-F")) return undefined;
		if (hasFlag(parsed, "-p") || !assignments) return found("secrets", `${call.program} without a name prints every variable, secrets included`);
	}
	return undefined;
}

function compgen(call: Call): Finding | undefined {
	return call.args.some((arg) => ["-v", "-e", "variable", "export"].includes(arg.text)) ? found("secrets", "compgen lists the environment's variable names and more") : undefined;
}

function setBuiltin(call: Call): Finding | undefined {
	return call.args.length === 0 ? found("secrets", "set without arguments prints every variable, secrets included") : undefined;
}

const TAILSCALE_READS = new Set(["status", "ip", "version", "whois", "netcheck", "ping", "dns", "metrics", "id-token-never"]);

/** `tailscale` looks at the network freely; what changes the node (up, down, set, login, logout, serve, funnel, cert, file, ssh, lock) is not read-only. */
function tailscale(call: Call): Finding | undefined {
	const parsed = parseArgs(call.args, ["--socket", "--timeout", "-c", "--count"]);
	const verb = parsed.positionals[0]?.text;
	if (verb === undefined) return hasFlag(parsed, "--version", "--help", "-h") ? undefined : found("unknown", "tailscale without a command");
	if (!TAILSCALE_READS.has(verb)) return found("system", `tailscale ${clip(verb, 30)} changes the node or its keys`);
	if (verb === "dns" && !["status", "query"].includes(parsed.positionals[1]?.text ?? "")) return found("system", "tailscale dns changes the node's DNS settings");
	return undefined;
}

const HANDLERS: Record<string, Handler> = {
	tailscale,
	rm: (call) => removal(call),
	unlink: (call) => removal(call),
	rmdir: (call) => removal(call),
	shred: (call) => removal(call, ["-n", "--iterations", "-s", "--size", "--random-source"]),
	truncate: (call) => removal(call, ["-s", "--size", "-r", "--reference", "-o"]),
	trash: (call) => removal(call),
	cp: copying,
	mv: copying,
	install: copying,
	ln: linking,
	dd,
	tee,
	chmod: permissions,
	chown: permissions,
	chgrp: permissions,
	setfacl: permissions,
	chattr: permissions,
	tar,
	bsdtar: tar,
	zip,
	unzip,
	gzip: compressor,
	gunzip: compressor,
	bzip2: compressor,
	bunzip2: compressor,
	xz: compressor,
	unxz: compressor,
	zstd: compressor,
	unzstd: compressor,
	rsync,
	scp,
	ssh,
	curl,
	wget,
	grep: search,
	egrep: search,
	fgrep: search,
	zgrep: search,
	rg: search,
	ag: search,
	ack: search,
	sed,
	awk,
	gawk: awk,
	mawk: awk,
	jq,
	yq,
	sort,
	uniq: secondFileWritten,
	xxd: secondFileWritten,
	getent,
	find,
	fd,
	fdfind: fd,
	xargs,
	env,
	sudo,
	doas: sudo,
	su,
	runuser: su,
	eval: evaluate,
	source: script,
	".": script,
	trap,
	export: declaring,
	declare: declaring,
	typeset: declaring,
	local: declaring,
	readonly: declaring,
	unset: () => undefined,
	set: setBuiltin,
	compgen,
	history: () => found("secrets", "history prints the shell history, which holds secrets typed on the command line"),
	printenv: () => found("secrets", "printenv prints the environment, which holds secrets"),
	git: classifyGit,
	docker: classifyDocker,
	podman: classifyDocker,
	"docker-compose": classifyDocker,
	"podman-compose": classifyDocker,
	npm,
	pnpm: npm,
	yarn: npm,
	bun: (call) => (call.args.length === 0 || ["run", "test", "install", "add", "remove", "x", "build", "pm", "update", "upgrade"].includes(call.args[0]!.text) ? npm(call) : interpreter(call, "bun")),
	npx: npm,
	bunx: npm,
	cargo,
	pip,
	pip3: pip,
	uv,
	gh,
	"woodpecker-cli": woodpecker,
	powershell: windows,
	pwsh: windows,
	cmd: windows,
	openssl,
	date,
	hostname,
	ps,
	ip,
	ifconfig,
	systemctl,
	service,
	journalctl,
	dmesg,
	sysctl,
	crontab,
	at: () => found("system", "at schedules a job"),
	atq: () => undefined,
	kill,
	pkill: kill,
	killall: kill,
	skill: kill,
	fuser: (call) => (call.args.some((arg) => /^-[A-Za-z]*k/.test(arg.text) || arg.text === "--kill") ? found("system", "fuser -k ends processes") : undefined),
	bash: shell,
	sh: shell,
	dash: shell,
	zsh: shell,
	ksh: shell,
	ash: shell,
	fish: shell,
	csh: shell,
	tcsh: shell,
	nohup: wrapper,
	nice: wrapper,
	time: wrapper,
	command: wrapper,
	builtin: wrapper,
	exec: wrapper,
	stdbuf: wrapper,
	setsid: wrapper,
	ionice: wrapper,
	chrt: wrapper,
	taskset: wrapper,
	unbuffer: wrapper,
	timeout: wrapper,
	watch: wrapper,
	flock: wrapper,
	busybox: wrapper,
};

for (const name of ["iptables", "ip6tables", "ebtables", "arptables", "nft", "ufw", "firewall-cmd", "iptables-restore", "ip6tables-restore", "nft-restore", "netsh", "pfctl", "ipset", "conntrack", "iptables-apply", "fail2ban-client", "csf"]) HANDLERS[name] = firewall;
for (const name of DATABASE_PROGRAMS) HANDLERS[name] = classifyDatabase;
for (const name of Object.keys(SECRET_TOOLS)) HANDLERS[name] = (call) => found("secrets", `${call.program} handles ${SECRET_TOOLS[call.program]!}`);
for (const name of Object.keys(SYSTEM_CHANGERS)) HANDLERS[name] ??= (call) => found("system", SYSTEM_CHANGERS[call.program]!);
for (const name of DISK_TOOLS) HANDLERS[name] = (call) => found("data", `${call.program} formats, repartitions or repairs disks`);
for (const name of HYPERVISOR_PROGRAMS) HANDLERS[name] = (call) => found("hypervisor", `${call.program} is a hypervisor command`);
for (const name of Object.keys(PACKAGE_READ)) HANDLERS[name] = packages;
for (const name of CODE_RUNNERS) HANDLERS[name] ??= codeRunner;

/** The handler of a program: its own, an interpreter's, `mkfs.*` and friends, or none. */
export function handlerFor(program: string): Handler | undefined {
	if (Object.hasOwn(HANDLERS, program)) return HANDLERS[program];
	if (/^mkfs(?:\.\w+)?$|^mke2fs$/.test(program)) return (call) => found("data", `${call.program} formats a filesystem`);
	for (const [pattern, kind] of INTERPRETER_NAMES) if (pattern.test(program)) return (call) => interpreter(call, kind === "" ? program : kind);
	if (/firewall/i.test(program)) return (call) => found("firewall", `${call.program} changes firewall rules`);
	return undefined;
}


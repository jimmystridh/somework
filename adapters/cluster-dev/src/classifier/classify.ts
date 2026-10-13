import { posix } from "node:path";
import { assignmentFinding, basename, checkWrite, clip, found, isOwnPath, type Call, type Category, type Finding, type Io, type Settings, type Shared } from "./common.ts";
import { credentialLiteralReason, DEFAULT_HYPERVISOR_HOSTS, hypervisorMention, isHypervisorName, secretPathReason, secretVariablesIn } from "./patterns.ts";
import { handlerFor, innerCommand, READ_ONLY_PROGRAMS, runsScript, scriptMatches, skipsSecretPathScan } from "./programs.ts";
import { parseScript, type Command, type Script, type Word } from "./shell.ts";

/**
 * Whether a shell command is destructive: it removes or overwrites data, touches secrets, touches the hypervisor or a firewall, rewrites
 * or removes git history, or runs a download. This is the single source of truth for what the cluster development agent may do without
 * asking; the model's prompt only describes it. The command is read the way a shell reads it (see `shell.ts`) and every command it would
 * run is judged, including what runs inside `sudo`, `ssh host '...'`, `bash -c`, `docker exec`, `$(...)`, here-documents and wrappers.
 *
 * It errs on the side of asking: a command is allowed unattended only when it is one this module knows to be harmless with the arguments
 * given. A program it does not know, a command name or path that is computed when the command runs, and text it cannot read are all
 * destructive. `forbidden` marks the one thing that is not even asked about: pushing anywhere but the organisation remote.
 */
export interface ClassifyContext {
	/** The machine the command runs on. Unset: the agent's own sandbox. The hypervisor makes every command destructive. */
	host?: string;
	/** Directories the agent may change freely (its workspace). Unset or empty: there are none, so every change to files is destructive. */
	workspaces?: readonly string[];
	/**
	 * `"free"`: in the agent's own sandbox (no `host`) nothing is destructive, since it holds no secrets and has no way into the cluster; only what is
	 * `forbidden` stays. Unset: the sandbox is judged like any machine, as far as its workspace goes.
	 */
	sandbox?: "free";
	/** The git remote that may be pushed to (default `org`). */
	remote?: string;
	/** More remotes that may be pushed to: the other repositories the deployment names. Never `origin`. */
	extraRemotes?: readonly string[];
	/** Names the hypervisor goes by. */
	hypervisorHosts?: readonly string[];
	/** systemd units the agent may start, stop and restart (patterns with `*`). */
	ownServices?: readonly string[];
	/** The repository's own scripts that may run on any machine, as path suffixes. */
	scripts?: readonly string[];
}

export interface Classification {
	destructive: boolean;
	reason?: string;
	category?: Category;
	/** Never allowed, whoever approves. */
	forbidden?: boolean;
}

export const DEFAULT_SCRIPTS = ["deploy/agents/roll-agent.sh", "deploy/agents/deploy-from-ci.sh", "roll-agent.sh", "deploy-from-ci.sh"];

const MAX_COMMAND_LENGTH = 20_000;
const MAX_DEPTH = 6;

function resolve(context: ClassifyContext): Settings {
	return {
		...(context.host !== undefined ? { host: context.host } : {}),
		workspaces: (context.workspaces ?? []).map((root) => root.replace(/\/+$/, "") || "/"),
		remote: context.remote ?? "org",
		sandboxFree: context.sandbox === "free",
		extraRemotes: (context.extraRemotes ?? []).filter((name) => name !== "origin"),
		hypervisorHosts: [...(context.hypervisorHosts ?? DEFAULT_HYPERVISOR_HOSTS)],
		ownServices: [...(context.ownServices ?? [])],
		scripts: [...(context.scripts ?? DEFAULT_SCRIPTS)],
	};
}

/** Forbidden findings win: whatever else is wrong with the command, it must not run. */
const pick = (findings: Finding[]): Finding | undefined => findings.find((entry) => entry.forbidden) ?? findings[0];

const DOWNLOADERS = new Set(["curl", "wget", "aria2c", "fetch", "nc", "ncat", "socat", "http", "https", "xh"]);
const SHELLS = new Set(["sh", "bash", "dash", "zsh", "ksh", "ash", "fish", "csh", "tcsh", "pwsh", "powershell", "python", "python3", "perl", "ruby", "node", "php", "lua", "deno", "bun", "source", ".", "eval"]);

function pipedText(previous: Command | undefined): string | undefined {
	if (!previous || previous.words.length === 0 || previous.words.some((entry) => entry.dynamic)) return undefined;
	const program = basename(previous.words[0]!.text);
	const args = previous.words.slice(1).map((entry) => entry.text);
	if (program === "echo") return args.filter((arg) => !/^-[neE]+$/.test(arg)).join(" ");
	if (program === "printf" && args.length >= 1 && !args[0]!.includes("%")) return args[0];
	if (program === "cat" && args.length === 0) return previous.stdinText;
	return undefined;
}

const programOf = (words: Word[]): string => {
	const inner = innerCommand(words);
	const name = inner[0] ? basename(inner[0].text) : "";
	return /^python[0-9.]+$/.test(name) ? "python" : name;
};

/** A shell or interpreter that takes its program from standard input or from computed text. */
function runsComputedText(command: Command, computedOnly: boolean): boolean {
	const inner = innerCommand(command.words);
	if (inner.length === 0) return false;
	const program = basename(inner[0]!.text);
	const base = program.replace(/\d+(?:\.\d+)*$/, "");
	if (!SHELLS.has(program) && !SHELLS.has(base)) return false;
	const args = inner.slice(1);
	if (program === "eval" || program === "source" || program === ".") return args.some((arg) => arg.dynamic) || (!computedOnly && args.length === 0);
	if (args.some((arg) => arg.dynamic)) return true;
	if (computedOnly) return false;
	if (args.length === 0 || args.some((arg) => arg.text === "-" || arg.text === "-s" || arg.text === "/dev/stdin")) return true;
	return !args.some((arg) => !arg.text.startsWith("-"));
}

function downloadExecution(script: Script): Finding | undefined {
	const downloads = script.commands.some((command) => DOWNLOADERS.has(programOf(command.words)));
	if (!downloads) return undefined;
	const groups = new Map<number, Command[]>();
	for (const command of script.commands) groups.set(command.pipeline, [...(groups.get(command.pipeline) ?? []), command]);
	for (const group of groups.values()) {
		if (group.some((command) => DOWNLOADERS.has(programOf(command.words))) && group.some((command) => command.index > 0 && runsComputedText(command, false))) return found("download", "pipes a download into a shell or interpreter");
	}
	if (script.commands.some((command) => runsComputedText(command, true))) return found("download", "runs text that a download produced");
	return undefined;
}

/** Programs that print or copy what a file holds, for the check on what was found by name. */
const CONTENT_READERS = new Set(["cat", "less", "more", "head", "tail", "tac", "nl", "od", "hexdump", "xxd", "strings", "base64", "diff", "cmp", "comm", "grep", "egrep", "fgrep", "rg", "ag", "sort", "uniq", "cut", "paste", "jq", "awk", "gawk", "sed", "cp", "mv", "scp", "rsync", "tar", "zip", "gzip", "openssl", "curl", "wget", "tee"]);
const LISTERS = new Set(["find", "fd", "fdfind", "ls", "locate", "stat", "tree"]);

/**
 * Looking for secret files by name is allowed; reading what was found is not. A command line that lists files by a secret's name and then
 * hands what it found to a program that reads content, as arguments (`find / -name id_rsa | xargs cat`, `cat $(find ... -name '*.pem')`,
 * `for f in $(find ...); do cat $f; done`), is refused. Passing the names through `head` or `sort` reads nothing.
 */
function listedSecretsRead(script: Script): Finding | undefined {
	const names = (command: Command) => command.words.some((entry, index) => index > 0 && secretPathReason(entry.text.replace(/\\\./g, ".")) !== undefined);
	const listing = script.commands.some((command) => LISTERS.has(programOf(command.words)) && names(command));
	if (!listing) return undefined;
	const reading = script.commands.some((command) => {
		const program = programOf(command.words);
		const dynamic = command.words.slice(1).some((entry) => entry.dynamic);
		const viaXargs = basename(command.words[0]?.text ?? "") === "xargs";
		return CONTENT_READERS.has(program) && (dynamic || viaXargs);
	});
	return reading ? found("secrets", "finds secret files by name and then reads what it found") : undefined;
}

function scanWords(words: Word[], program: string, settings: Settings): Finding | undefined {
	const skipPaths = skipsSecretPathScan(program);
	for (const [index, entry] of words.entries()) {
		if (hypervisorMention(entry.text, settings.hypervisorHosts)) return found("hypervisor", `names the hypervisor: ${clip(entry.text, 50)}`);
		const variable = secretVariablesIn(entry.text);
		if (variable) return found("secrets", `expands the secret variable ${variable}`);
		if (index === 0 || skipPaths) continue;
		const reason = secretPathReason(entry.text);
		if (reason) return found("secrets", `touches ${reason}: ${clip(entry.text, 60)}`);
		if (settings.secretCwd && !entry.text.startsWith("-") && !entry.text.startsWith("/") && !entry.text.startsWith("~") && entry.text !== "") return found("secrets", `works in a directory that holds secrets: ${clip(entry.text, 60)}`);
	}
	return undefined;
}

const WRITING_REDIRECTS = new Set([">", ">>", ">|", "&>", "&>>", "<>", ">&"]);

function checkRedirects(command: Command, settings: Settings): Finding | undefined {
	for (const redirect of command.redirects) {
		if (redirect.op.startsWith("<<")) continue;
		if ((redirect.op === ">&" || redirect.op === "<&") && /^(?:\d+|-)$/.test(redirect.target.text)) continue;
		const reason = secretPathReason(redirect.target.text);
		if (reason) return found("secrets", `redirects to or from ${reason}: ${clip(redirect.target.text, 60)}`);
		if (WRITING_REDIRECTS.has(redirect.op)) {
			const written = checkWrite(redirect.target, `redirection ${redirect.op} writes`, settings);
			if (written) return written;
		}
	}
	return undefined;
}

function checkWords(words: Word[], io: Io, settings: Settings, shared: Shared, depth: number, functions: ReadonlySet<string>): Finding | undefined {
	if (depth > MAX_DEPTH) return found("unknown", "commands nested too deeply to read");
	const head = words[0];
	if (!head) return undefined;
	if (head.dynamic) return found("unknown", "the command name is computed when the command runs");
	if (/[*?[]/.test(head.text) && head.text !== "[" && head.text !== "[[") return found("unknown", "the command name is a pattern that the shell expands");
	if (functions.has(head.text)) return undefined;
	const program = basename(head.text);
	const call: Call = {
		program,
		args: words.slice(1),
		io,
		settings,
		shared,
		runWords: (inner, other, otherIo) => pick(checkWordsList(inner, otherIo ?? io, other ?? settings, shared, depth + 1, functions)),
		runText: (text, other, stdin) => pick(checkText(text, other ?? settings, shared, depth + 1, stdin)),
	};
	const scanned = scanWords(words, program, settings);
	if (scanned) return scanned;
	const handler = handlerFor(program);
	if (handler) return handler(call);
	if (READ_ONLY_PROGRAMS.has(program)) return undefined;
	if (scriptMatches(head.text, settings.scripts)) return runsScript(head, call);
	if (head.text.includes("/")) return runsScript(head, call);
	return found("unknown", `${clip(program, 40)} is not a command this agent may run without asking`);
}

const checkWordsList = (words: Word[], io: Io, settings: Settings, shared: Shared, depth: number, functions: ReadonlySet<string>): Finding[] => {
	const finding = checkWords(words, io, settings, shared, depth, functions);
	return finding ? [finding] : [];
};

/** The settings after a `cd`: relative paths mean the new directory, or nothing the agent owns when it left the workspace. */
function afterCd(command: Command, settings: Settings): Settings {
	const program = command.words[0] ? basename(command.words[0].text) : "";
	if (program !== "cd" && program !== "pushd") return settings;
	const target = command.words.slice(1).find((entry) => entry.dynamic || !entry.text.startsWith("-"));
	if (!target || target.dynamic || target.text === "-") return { ...settings, relativeOutside: true };
	if (secretPathReason(target.text) !== undefined) return { ...settings, relativeOutside: true, secretCwd: true };
	if (!isOwnPath(target.text, settings)) return { ...settings, relativeOutside: true };
	if (target.text.startsWith("/")) return { ...settings, cwd: posix.normalize(target.text), relativeOutside: false };
	if (settings.cwd) return { ...settings, cwd: posix.resolve(settings.cwd, target.text) };
	return settings;
}

function checkText(text: string, settings: Settings, shared: Shared, depth: number, stdin?: Io): Finding[] {
	if (depth > MAX_DEPTH) return [found("unknown", "commands nested too deeply to read")];
	const script = parseScript(text);
	if (script.problem) return [found("unknown", `cannot be read as a shell command (${script.problem})`)];
	const findings: Finding[] = [];
	const download = downloadExecution(script);
	if (download) findings.push(download);
	const leak = listedSecretsRead(script);
	if (leak) findings.push(leak);
	let current = settings;
	for (const command of script.commands) {
		const settings = current;
		const previous = script.commands.find((candidate) => candidate.pipeline === command.pipeline && candidate.index === command.index - 1);
		const io: Io = { hasPipe: command.index > 0, ...(command.stdinText !== undefined ? { stdinText: command.stdinText } : {}) };
		const piped = pipedText(previous);
		if (piped !== undefined) io.piped = piped;
		if (stdin && command.index === 0 && command.pipeline === script.commands[0]?.pipeline) {
			if (io.stdinText === undefined && stdin.stdinText !== undefined) io.stdinText = stdin.stdinText;
			if (io.piped === undefined && stdin.piped !== undefined) io.piped = stdin.piped;
		}
		const redirected = checkRedirects(command, settings);
		if (redirected) findings.push(redirected);
		const assigned = [...(command.assignments ?? []), ...(["export", "declare", "readonly", "local", "typeset"].includes(command.words[0]?.text ?? "") ? command.words.slice(1) : [])].map((entry) => assignmentFinding(entry, settings)).find(Boolean);
		if (assigned) findings.push(assigned);
		const finding = checkWords(command.words, io, settings, shared, depth, script.functions);
		if (finding) findings.push(finding);
		current = afterCd(command, settings);
	}
	return findings;
}

/** Judges a shell command. Never throws: a command that cannot be judged is destructive. */
export function classifyCommand(command: string, context: ClassifyContext = {}): Classification {
	if (typeof command !== "string") return { destructive: true, reason: "the command is not text", category: "unknown" };
	if (command.trim() === "") return { destructive: false };
	const settings = resolve(context);
	const shared: Shared = { downloads: new Set() };
	let finding: Finding | undefined;
	try {
		if (command.length > MAX_COMMAND_LENGTH) finding = found("unknown", "the command is too long to read");
		else if (settings.host !== undefined && isHypervisorName(settings.host, settings.hypervisorHosts)) finding = found("hypervisor", `anything on the hypervisor (${clip(settings.host, 40)}) needs approval`);
		else {
			const literal = credentialLiteralReason(command);
			finding = pick([...(literal ? [found("secrets", `the command contains ${literal}`)] : []), ...checkText(command, settings, shared, 0)]);
		}
	} catch (error) {
		finding = found("unknown", `the command could not be judged (${error instanceof Error ? error.message.slice(0, 80) : "error"})`);
	}
	// In the agent's own sandbox (no host) there is nothing to destroy or leak: no secrets, no way into the cluster. Only what is never allowed stays.
	if (finding && settings.host === undefined && settings.sandboxFree && !finding.forbidden) finding = undefined;
	return finding ? { destructive: true, reason: finding.reason, category: finding.category, ...(finding.forbidden ? { forbidden: true } : {}) } : { destructive: false };
}

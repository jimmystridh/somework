import { DEFAULT_APPROVAL_PATTERNS } from "@somework/agent-kit";

/**
 * What the reviewer may run in its bash tool.
 *   allow    plain inspection: git diff/log/show, search, cat, ls, ... possibly piped into head/wc/sort/...
 *   deny     anything that changes files, refs, or the outside world: refused without asking anybody
 *   approve  everything else (build, test, an unknown tool): waits for the requester
 * A command is split at every `;`, `&`, `|` (quotes are ignored on purpose: splitting too much only ever turns "allow" into
 * "approve"). Each part must be a known read-only command; command substitution, redirection and here-documents are never allowed.
 */
export type CommandVerdict = "allow" | "deny" | "approve";

export const DENIED_REASON = "denied by the read-only reviewer policy";

const GIT_READ = new Set(["diff", "diff-tree", "log", "show", "status", "blame", "ls-files", "ls-tree", "cat-file", "rev-parse", "rev-list", "merge-base", "shortlog", "describe", "grep", "name-rev", "show-ref", "for-each-ref", "count-objects", "whatchanged"]);
const GIT_WRITE = new Set(["push", "commit", "checkout", "switch", "reset", "clean", "apply", "am", "merge", "rebase", "cherry-pick", "revert", "stash", "add", "rm", "mv", "restore", "fetch", "pull", "clone", "config", "worktree", "submodule", "gc", "init", "update-ref", "symbolic-ref", "filter-branch", "notes", "remote", "tag", "branch", "bisect", "format-patch", "send-email", "lfs"]);
const WRITE_COMMANDS = new Set(["rm", "rmdir", "mv", "cp", "chmod", "chown", "ln", "mkdir", "touch", "tee", "dd", "truncate", "shred", "install", "sudo", "su", "doas", "curl", "wget", "nc", "ncat", "ssh", "scp", "sftp", "rsync", "ftp", "apt", "apt-get", "dpkg", "kill", "pkill", "killall", "tar", "unzip", "zip", "gzip", "gunzip", "bzip2", "xz", "patch", "ed", "ex", "vi", "vim", "nano", "emacs", "mount", "umount", "crontab", "at", "reboot", "shutdown", "mkfs", "docker", "podman"]);
const READ_COMMANDS = new Set(["cat", "head", "tail", "ls", "wc", "file", "stat", "tree", "nl", "sort", "uniq", "cut", "tr", "rg", "grep", "egrep", "fgrep", "ag", "jq", "diff", "realpath", "basename", "dirname", "pwd", "du", "which", "true", "column", "fold", "expand", "strings", "xxd", "od", "md5sum", "sha1sum", "sha256sum", "cmp", "cd", "echo", "printf"]);
/** Commands that may only appear after a pipe: they read the previous command's output. */
const FILTERS = new Set(["head", "tail", "wc", "sort", "uniq", "cut", "tr", "nl", "grep", "egrep", "fgrep", "rg", "jq", "column", "fold", "expand", "cat"]);

/** Constructs that run something else or write somewhere, whatever the command is. */
const NEVER = /`|\$\(|\$\{|<\(|>\(|>|<|\n|\r|\\\n/;
/** Flags that make an otherwise read-only command write a file or run a program. */
const DANGEROUS_FLAGS = /(^|\s)(--output(=|\s|$)|--open-files-in-pager|-O\S*|--ext-diff|--textconv|--exec-path|--pre(=|\s|-glob)|--pager|--hostname-bin|-exec(dir)?\b|-ok(dir)?\b|-delete\b|-fprint\w*|-fls\b)/;

const words = (segment: string): string[] => segment.trim().split(/\s+/).filter(Boolean);

function gitSubcommand(tokens: string[]): { sub: string; rest: string[] } | undefined {
	let i = 1;
	// `git --no-pager` and `git -C <dir>` are fine; `git -c key=value` can run programs and is not
	while (i < tokens.length) {
		const token = tokens[i]!;
		if (token === "--no-pager" || token === "--no-optional-locks") i += 1;
		else if (token === "-C") i += 2;
		else break;
	}
	const sub = tokens[i];
	return sub === undefined ? undefined : { sub, rest: tokens.slice(i + 1) };
}

type SegmentVerdict = CommandVerdict;

function classifySegment(segment: string, piped: boolean): SegmentVerdict {
	const tokens = words(segment);
	const head = tokens[0];
	if (head === undefined) return "approve";
	if (WRITE_COMMANDS.has(head)) return "deny";
	if (DANGEROUS_FLAGS.test(segment.slice(head.length))) return "deny";
	if (head === "git") {
		const parsed = gitSubcommand(tokens);
		if (!parsed) return "approve";
		if (parsed.sub === "-c") return "deny"; // a config override can name a program to run
		if (GIT_READ.has(parsed.sub)) return "allow";
		if (GIT_WRITE.has(parsed.sub)) return gitListing(parsed.sub, parsed.rest) ? "allow" : "deny";
		return "approve";
	}
	if (head === "sed") {
		if (tokens.some((t) => /^-[a-zA-Z]*i/.test(t) || t === "--in-place")) return "deny";
		// printing a line range is the one use worth allowing: sed -n '10,40p' file
		return /^sed\s+-n\s+["']?\d+(,(\d+|\$))?p["']?(\s+[^\s;&|]+)?$/.test(segment.trim()) ? "allow" : "approve";
	}
	if (head === "awk" || head === "perl" || head === "python" || head === "python3" || head === "node" || head === "ruby" || head === "bash" || head === "sh" || head === "env" || head === "xargs" || head === "eval" || head === "exec") return "approve";
	if (head === "find") return "allow"; // -exec, -delete and friends were refused above
	if (piped && FILTERS.has(head)) return "allow";
	if (READ_COMMANDS.has(head)) return "allow";
	return "approve";
}

/** `git branch`, `git tag` and `git remote` only list when asked to. */
function gitListing(sub: string, rest: string[]): boolean {
	if (sub === "branch") return rest.every((t) => ["-a", "-r", "-v", "-vv", "--list", "--show-current", "--contains", "--merged", "--no-merged", "--all", "--remotes"].includes(t) || !t.startsWith("-"));
	if (sub === "tag") return rest.length === 0 || rest.some((t) => t === "-l" || t === "--list");
	if (sub === "remote") return rest.length === 0 || (rest.length === 1 && (rest[0] === "-v" || rest[0] === "show"));
	return false;
}

/** `2>&1` and `2>/dev/null` change nothing on disk; every other redirection writes. */
const harmlessRedirects = (command: string): string => command.replace(/\s2>&1(?=\s|$)/g, " ").replace(/\s2>\/dev\/null(?=\s|$)/g, " ");

export function classifyCommand(raw: string): CommandVerdict {
	const command = harmlessRedirects(raw);
	if (/>|\btee\b/.test(command)) return "deny";
	if (NEVER.test(command)) return "approve";
	const segments = command.split(/&&|\|\||;|\||&/);
	const separators = command.match(/&&|\|\||;|\||&/g) ?? [];
	let verdict: CommandVerdict = "allow";
	segments.forEach((segment, index) => {
		const piped = index > 0 && separators[index - 1] === "|";
		const one = classifySegment(segment, piped);
		if (one === "deny") verdict = "deny";
		else if (one === "approve" && verdict === "allow") verdict = "approve";
	});
	return verdict;
}

/** A RegExp whose `test` asks a predicate: `approvalPolicy` only calls `test`, so a profile can express rules a regular expression cannot. */
class CommandPattern extends RegExp {
	readonly #matches: (command: string) => boolean;
	constructor(matches: (command: string) => boolean) {
		super("(?:)");
		this.#matches = matches;
	}
	override test(command: string): boolean {
		return this.#matches(command);
	}
}

/**
 * The reviewer's approval patterns, in the order `approvalPolicy` consults them: refuse mutations (the runtime answers "denied" for
 * these itself, nobody is asked), then anything that is not plain inspection waits for the requester. The built-in patterns stay,
 * so `git push` and friends are caught even if the classifier above were ever wrong.
 */
export const REVIEW_APPROVAL_PATTERNS: [RegExp, string][] = [
	[new CommandPattern((command) => classifyCommand(command) === "deny"), DENIED_REASON],
	...DEFAULT_APPROVAL_PATTERNS,
	[new CommandPattern((command) => classifyCommand(command) === "approve"), "a command that is not plain read-only inspection"],
];

import { found, hasFlag, isOwnPath, parseArgs, checkWrite, joinWords, texts, valueOf, type Call, type Finding, type Parsed } from "./common.ts";

const GLOBAL_VALUED = ["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--super-prefix", "--config-env"];

/** Subcommands that only read. */
const READ_ONLY = new Set(["status", "log", "diff", "show", "blame", "grep", "ls-files", "ls-remote", "ls-tree", "rev-parse", "rev-list", "describe", "shortlog", "cat-file", "for-each-ref", "merge-base", "name-rev", "show-ref", "check-ignore", "check-attr", "diff-tree", "diff-index", "diff-files", "range-diff", "cherry", "count-objects", "fsck", "version", "help", "whatchanged", "show-branch", "verify-commit", "verify-tag", "archive", "format-patch", "bundle", "fetch", "annotate", "cherry-pick-info", "var", "instaweb", "mergetool", "difftool", "request-pull", "remote-info"]);

/** Subcommands that change the repository they run in but lose nothing a person has not already committed. */
const LOCAL_CHANGES = new Set(["add", "commit", "merge", "cherry-pick", "revert", "switch", "mv", "rm", "pull", "clone", "init", "apply", "am", "bisect", "submodule", "worktree", "lfs", "notes", "sparse-checkout", "maintenance", "stash", "tag", "branch", "checkout", "restore", "reset", "remote", "config", "gc", "repack", "pack-refs", "update-index", "mktag", "hash-object", "write-tree", "commit-tree", "read-tree", "symbolic-ref", "reflog", "update-ref", "clean", "rebase", "filter-branch", "filter-repo", "replace", "prune", "push"]);

const VALUED: Record<string, string[]> = {
	push: ["-o", "--push-option", "--repo", "--receive-pack", "--exec", "--signed"],
	commit: ["-m", "--message", "-F", "--file", "-C", "-c", "--author", "--date", "--cleanup", "-S", "--gpg-sign"],
	branch: ["--contains", "--no-contains", "--merged", "--no-merged", "--sort", "--format", "-u", "--set-upstream-to", "--points-at"],
	tag: ["-m", "--message", "-F", "--file", "-u", "--local-user", "--contains", "--sort", "--format", "-n", "--points-at"],
	checkout: ["-b", "-B", "--orphan", "--conflict"],
	switch: ["-c", "-C", "--orphan", "--create", "--force-create"],
	restore: ["-s", "--source"],
	clean: ["-e", "--exclude"],
	clone: ["-b", "--branch", "--depth", "-o", "--origin", "--reference", "--template", "-c", "--config", "-j", "--jobs", "--filter", "--separate-git-dir", "--upload-pack", "-u"],
	archive: ["-o", "--output", "--format", "--prefix", "--remote"],
	"format-patch": ["-o", "--output-directory", "--subject-prefix", "-n"],
	bundle: ["-o"],
	config: ["--file", "-f", "--type", "--default"],
	gc: ["--prune"],
	reset: [],
};

const SENSITIVE_CONFIG = /(?:^alias\.|ssh[Cc]ommand|core\.(?:pager|editor|fsmonitor|hooksPath|askpass|gitProxy|sshCommand)|^credential|^http\..*(?:extraHeader|proxy|sslVerify)|^protocol\.|^url\.|^remote\..*\.(?:url|pushurl|receivepack)|^filter\.|^diff\..*\.(?:command|textconv)|^merge\..*\.driver|^include|^safe\.)/i;

function configProblem(value: string): string | undefined {
	const equals = value.indexOf("=");
	const key = equals < 0 ? value : value.slice(0, equals);
	const setting = equals < 0 ? "" : value.slice(equals + 1);
	if (setting.startsWith("!") || SENSITIVE_CONFIG.test(key)) return key;
	return undefined;
}

/** The subcommand and what follows it, and the problems with the global options in front of it. */
function split(args: Call["args"]): { sub?: string; rest: Call["args"]; repo?: string; problem?: Finding } {
	let repo: string | undefined;
	let i = 0;
	for (; i < args.length; i++) {
		const arg = args[i]!;
		if (arg.dynamic) return { rest: [], problem: found("unknown", "git was given a computed option or subcommand") };
		if (!arg.text.startsWith("-")) break;
		if (arg.text === "-C" && args[i + 1]) {
			repo = args[++i]!.text;
		} else if (arg.text === "-c" && args[i + 1]) {
			const value = args[++i]!;
			const problem = configProblem(value.text);
			if (problem) return { rest: [], problem: found("system", `git -c ${problem} makes git run a program or change where it talks to`) };
		} else if (GLOBAL_VALUED.includes(arg.text)) i++;
		else if (arg.text.startsWith("--config-env=") || arg.text.startsWith("--exec-path")) return { rest: [], problem: found("system", "git was told to use another configuration") };
	}
	const sub = args[i];
	return { ...(sub ? { sub: sub.text } : {}), rest: args.slice(i + 1), ...(repo !== undefined ? { repo } : {}) };
}

function push(parsed: Parsed, call: Call): Finding | undefined {
	if (hasFlag(parsed, "-f", "--force", "--force-with-lease", "--force-if-includes", "--mirror", "--prune")) return found("git", "git push that overwrites or removes what the remote has (force, mirror or prune)");
	if (hasFlag(parsed, "-d", "--delete")) return found("git", "git push --delete removes a branch or tag on the remote");
	const [remote, ...refspecs] = parsed.positionals;
	const dry = hasFlag(parsed, "-n", "--dry-run");
	if (!remote) return dry ? undefined : found("git", `git push must name the organisation remote (${call.settings.remote}) explicitly`, true);
	const allowed = [call.settings.remote, ...call.settings.extraRemotes];
	if (remote.dynamic || !allowed.includes(remote.text)) return found("git", `git push may only go to ${allowed.length > 1 ? `one of the configured remotes (${allowed.join(", ")})` : `the organisation remote "${call.settings.remote}"`}, not ${remote.text.slice(0, 60)}`, true);
	for (const refspec of refspecs) {
		if (refspec.dynamic) return found("git", "git push with a refspec that is computed when the command runs");
		if (refspec.text.startsWith("+")) return found("git", "git push +refspec overwrites the remote branch");
		if (refspec.text.startsWith(":")) return found("git", "git push :ref removes a branch or tag on the remote");
	}
	return undefined;
}

function branch(parsed: Parsed): Finding | undefined {
	if (hasFlag(parsed, "-d", "-D", "--delete", "-m", "-M", "--move", "-f", "--force", "-c", "-C") && !hasFlag(parsed, "--list", "-l", "--show-current")) return found("git", "git branch that deletes, renames or moves a branch");
	return undefined;
}

function tag(parsed: Parsed): Finding | undefined {
	return hasFlag(parsed, "-d", "--delete", "-f", "--force") ? found("git", "git tag that deletes or moves a tag") : undefined;
}

function checkout(parsed: Parsed, rest: Call["args"]): Finding | undefined {
	if (hasFlag(parsed, "-f", "--force", "-B", "--discard-changes", "--ours", "--theirs", "-p", "--patch")) return found("git", "git checkout that discards local changes or moves a branch");
	if (rest.some((entry) => entry.text === "--")) return found("git", "git checkout -- <path> discards local changes");
	if (rest.some((entry) => entry.text === ".")) return found("git", "git checkout . discards local changes");
	return undefined;
}

export function classifyGit(call: Call): Finding | undefined {
	const { sub, rest, repo, problem } = split(call.args);
	if (problem) return problem;
	if (!sub) return undefined;
	const parsed = parseArgs(rest, VALUED[sub] ?? []);
	const outside = repo !== undefined ? !isOwnPath(repo, call.settings) : call.settings.workspaces.length === 0;
	if (outside && sub !== "push" && sub !== "clone" && sub !== "init" && !readsOnly(sub, rest, parsed)) return found("git", `git ${sub.slice(0, 40)} changes a repository that is not in the agent's workspace`);
	switch (sub) {
		case "push":
			return push(parsed, call);
		case "branch":
			return branch(parsed);
		case "tag":
			return tag(parsed);
		case "checkout":
			return checkout(parsed, rest);
		case "switch":
			return hasFlag(parsed, "-f", "--force", "--discard-changes", "-C", "--force-create") ? found("git", "git switch that discards local changes or moves a branch") : undefined;
		case "restore":
			return hasFlag(parsed, "--staged", "-S") && !hasFlag(parsed, "--worktree", "-W") ? undefined : found("git", "git restore overwrites files in the working tree");
		case "reset":
			return hasFlag(parsed, "--hard", "--merge", "--keep") ? found("git", "git reset --hard discards local changes and moves the branch") : undefined;
		case "clean":
			return hasFlag(parsed, "-n", "--dry-run") ? undefined : found("git", "git clean deletes untracked files");
		case "rebase":
			return found("git", "git rebase rewrites history");
		case "commit":
			return hasFlag(parsed, "--amend") ? found("git", "git commit --amend rewrites history") : undefined;
		case "filter-branch":
		case "filter-repo":
		case "replace":
		case "prune":
		case "update-ref":
		case "update-index":
		case "symbolic-ref":
			return found("git", `git ${sub} rewrites history or refs`);
		case "gc":
			return rest.some((entry) => /^--prune(?:=|$)/.test(entry.text) && entry.text !== "--prune=never") || hasFlag(parsed, "--aggressive") ? found("git", "git gc --prune removes unreachable objects for good") : undefined;
		case "repack":
		case "pack-refs":
			return hasFlag(parsed, "-d", "-a") ? found("git", `git ${sub} -d removes the objects it replaces`) : undefined;
		case "reflog":
			return ["expire", "delete"].includes(rest[0]?.text ?? "") ? found("git", "git reflog expire/delete removes the record that makes history recoverable") : undefined;
		case "stash":
			return ["drop", "clear"].includes(rest[0]?.text ?? "") ? found("git", "git stash drop/clear throws away stashed work") : undefined;
		case "worktree":
			return ["remove", "prune"].includes(rest[0]?.text ?? "") ? found("git", "git worktree remove/prune deletes a working tree") : undefined;
		case "submodule": {
			const action = rest[0]?.text ?? "";
			if (action === "deinit") return found("git", "git submodule deinit removes a submodule's files");
			if (action === "foreach") return call.runText(joinWords(rest.slice(1).filter((entry) => !entry.text.startsWith("--"))));
			return undefined;
		}
		case "remote": {
			const action = rest[0]?.text ?? "";
			return ["remove", "rm", "prune"].includes(action) ? found("git", "git remote remove forgets a remote") : undefined;
		}
		case "config": {
			const reading = hasFlag(parsed, "--get", "--get-all", "--get-regexp", "-l", "--list", "--get-urlmatch", "--show-origin", "--show-scope", "--type", "--name-only");
			if (reading) return undefined;
			const key = parsed.positionals[0]?.text ?? "";
			if (SENSITIVE_CONFIG.test(key) || /credential|token|password|secret/i.test(key)) return found("secrets", `git config ${key.slice(0, 60)} changes credentials or what git runs`);
			if (hasFlag(parsed, "--global", "--system", "--unset", "--unset-all", "--remove-section", "--replace-all", "-e", "--edit")) return found("git", "git config that changes configuration outside the repository or removes a setting");
			return undefined;
		}
		case "lfs":
			return ["prune", "uninstall", "untrack", "migrate"].includes(rest[0]?.text ?? "") ? found("git", `git lfs ${rest[0]!.text} removes or rewrites stored files`) : undefined;
		case "notes":
			return ["remove", "prune"].includes(rest[0]?.text ?? "") ? found("git", "git notes remove deletes notes") : undefined;
		case "clone": {
			const targets = parsed.positionals.slice(1);
			const directory = targets[0];
			return directory ? checkWrite(directory, "git clone writes", call.settings) : checkWrite({ text: ".", dynamic: false }, "git clone writes", call.settings);
		}
		case "init": {
			const directory = parsed.positionals[0];
			return directory ? checkWrite(directory, "git init writes", call.settings) : undefined;
		}
		case "credential":
		case "credential-store":
		case "credential-cache":
		case "credential-manager":
		case "credential-osxkeychain":
			return found("secrets", "git credential reads or stores credentials");
		case "bisect":
			return ["run"].includes(rest[0]?.text ?? "") ? call.runWords(rest.slice(1)) : undefined;
		case "rm":
		case "mv":
		case "add":
		case "merge":
		case "cherry-pick":
		case "revert":
		case "pull":
		case "apply":
		case "am":
		case "mktag":
		case "hash-object":
		case "write-tree":
		case "commit-tree":
		case "read-tree":
		case "sparse-checkout":
		case "maintenance":
			return sub === "rm" || sub === "mv" ? checkPaths(parsed, call) : undefined;
		case "archive":
		case "format-patch":
		case "bundle": {
			const output = valueOf(parsed, "-o", "--output", "--output-directory");
			if (output) return checkWrite(output, `git ${sub} writes`, call.settings);
			return sub === "bundle" && ["create"].includes(rest[0]?.text ?? "") && rest[1] ? checkWrite(rest[1], "git bundle writes", call.settings) : undefined;
		}
		default:
			if (READ_ONLY.has(sub)) return undefined;
			if (LOCAL_CHANGES.has(sub)) return undefined;
			return found("unknown", `git ${sub.slice(0, 40)} is not a git command this agent may run without asking`);
	}
}

/** Variants of a subcommand that only look: `git branch`, `git stash list`, `git config --get`. */
function readsOnly(sub: string, rest: Call["args"], parsed: Parsed): boolean {
	if (READ_ONLY.has(sub)) return true;
	const first = rest[0]?.text;
	switch (sub) {
		case "pull":
			// bringing a deployment checkout up to date is part of deploying; a rebase, a force or an autostash rewrites or hides local work
			return !hasFlag(parsed, "--rebase", "-r", "--force", "-f", "--autostash", "--allow-unrelated-histories");
		case "branch":
		case "tag":
			return parsed.positionals.length === 0 || hasFlag(parsed, "-l", "--list");
		case "config":
			return hasFlag(parsed, "--get", "--get-all", "--get-regexp", "-l", "--list", "--get-urlmatch", "--show-origin", "--show-scope", "--name-only");
		case "remote":
			return first === undefined || ["-v", "--verbose", "show", "get-url"].includes(first);
		case "stash":
			return first === "list" || first === "show";
		case "worktree":
			return first === "list";
		case "submodule":
			return first === undefined || ["status", "summary"].includes(first);
		case "lfs":
			return ["ls-files", "status", "env", "version", "logs", "fetch", "pull"].includes(first ?? "");
		case "reflog":
			return first !== "expire" && first !== "delete";
		case "notes":
			return first === undefined || ["list", "show"].includes(first);
		case "bisect":
			return ["log", "visualize", "view"].includes(first ?? "");
		default:
			return false;
	}
}

function checkPaths(parsed: Parsed, call: Call): Finding | undefined {
	for (const target of parsed.positionals) {
		if (target.dynamic) return found("data", "git rm/mv of a path that is computed when the command runs");
		if (!isOwnPath(target.text, call.settings)) return found("data", `git ${texts([target])[0]!.slice(0, 40)} is outside the workspace`);
	}
	return undefined;
}

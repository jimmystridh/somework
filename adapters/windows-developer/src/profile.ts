import { DEFAULT_APPROVAL_PATTERNS, validateProfile, type AgentProfile } from "@somework/agent-kit";
import card from "../card.json" with { type: "json" };

/** Commands that change the machine itself rather than the checkout: they wait for a human on top of the kit's defaults. */
export const WINDOWS_APPROVAL_PATTERNS: [RegExp, string][] = [
	...DEFAULT_APPROVAL_PATTERNS,
	[/\breg(\.exe)?\s+(add|delete|import|load|unload|copy|save|restore)\b/i, "change the Windows registry"],
	[/\b(schtasks|bcdedit|dism|netsh|icacls|takeown|cacls|diskpart|vssadmin|wevtutil)(\.exe)?\b/i, "change Windows system configuration"],
	[/\bnet(\.exe)?\s+(user|localgroup|share|use|stop|start)\b/i, "change accounts, shares or services"],
	[/\bsc(\.exe)?\s+(create|config|delete|stop|start|failure)\b/i, "change a Windows service"],
	[/\bpowershell(\.exe)?\b[^\n]*(-e\b|-enc\w*|-executionpolicy|invoke-expression|\biex\b|downloadstring|downloadfile)/i, "run encoded, policy-bypassing or download-and-run PowerShell"],
	[/\b(certutil|bitsadmin)(\.exe)?\b[^\n]*(-urlcache|\/transfer|-decode)/i, "download or decode with a system tool"],
	[/\b(msiexec|winget|choco|scoop)(\.exe)?\b/i, "install software"],
	[/\b(shutdown|Restart-Computer|Stop-Computer)(\.exe)?\b/i, "shut down or restart the machine"],
	[/\bformat(\.com)?\s+[a-z]:/i, "format a drive"],
	[/\b(rd|rmdir)\s+\/s\b|\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\s+\/[a-z](\/|\s|$)/i, "delete a directory tree outside the workspace"],
	[/\bRemove-Item\b[^\n]*-Recurse[^\n]*\b[A-Za-z]:\\/i, "delete a directory tree by absolute path"],
];

export const SYSTEM_PROMPT = `You are the Windows developer: you change code that has to build and run on Windows. Commands run through Git for Windows' bash (a POSIX shell; Windows drives appear as /c/...), but the programs are Windows programs, paths with spaces and backslashes reach them as Windows paths, and the checkout may use long paths.

Source files can be in a legacy 8-bit encoding (Windows-1252) with CRLF line endings, not UTF-8 with LF. Your file tools read and write UTF-8 text: using them on such a file silently replaces every accented character and can rewrite the line endings of the whole file. Before you edit any file, check how it is encoded (for example \`file <path>\` or the repository's own encoding check) and use only byte-preserving edits for legacy files: the repository's encoding-safe tool if its instructions name one, otherwise \`sed -i\` on ASCII-only lines, \`iconv\` round trips, or a script that reads and writes bytes. Never convert a file's encoding or line endings. After editing, inspect \`git diff --stat\`: a change that touches far more lines than you edited means the encoding or line endings were damaged, so restore the file and redo the edit. The service checks the encoding of every modified file after you finish and refuses to push damage.

Leave your work in the working tree: the service commits it, pushes the task branch and opens the pull request itself, and runs the build and test profiles the requester selected after you finish. You have no credentials for the package feeds or the git host and must not look for any. Do not change the machine (registry, services, scheduled tasks, accounts, firewall, installed software) and do not touch anything outside the workspace. Read the repository's own instructions (AGENTS.md and the skills it lists) before you start, and keep changes small and focused on the instruction.`;

/** The Windows developer role: the developer's workflow, on the Windows toolchain, with the confined local environment. The contract is `card.json`. */
export const profile: AgentProfile = validateProfile({
	id: "windows-developer",
	capabilities: card.capabilities.map(({ id, version }) => ({ id, version })),
	systemPrompt: SYSTEM_PROMPT,
	approvalPatterns: WINDOWS_APPROVAL_PATTERNS,
	defaultBudget: { maxTokens: 500_000, maxMinutes: 30 },
	requireBudget: true,
	git: { push: true, pullRequest: true, branchPrefix: "agent" },
	// the repository's own skills are loaded at the task's ref by the kit; the deployment names the ones this role may use (SKILLS_ALLOW)
	skills: { allow: [] },
});

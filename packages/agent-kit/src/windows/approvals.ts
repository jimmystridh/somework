import { DEFAULT_APPROVAL_PATTERNS } from "../policy.ts";

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

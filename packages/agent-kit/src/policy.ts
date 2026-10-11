import type { ApprovalPolicy } from "./pi-runtime.ts";

/** Commands that should wait for a human even inside the sandbox. Deliberately conservative; extend with `APPROVAL_PATTERNS`. */
export const DEFAULT_APPROVAL_PATTERNS: [RegExp, string][] = [
	[/\bsudo\b/, "run a command as root"],
	[/(curl|wget)\b[^|;&]*\|\s*(sudo\s+)?(ba|z)?sh\b/, "pipe a download into a shell"],
	[/\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\s+(\/(?!workspace\b)|~|\$HOME)/, "delete files outside the workspace"],
	[/\bgit\s+push\b/, "push to a remote (the service pushes the task branch itself)"],
	[/\bchmod\s+-R\b/, "change permissions recursively"],
	[/\b(npm|pnpm|yarn)\s+publish\b|\bcargo\s+publish\b|\bdocker\s+push\b/, "publish an artifact"],
];

/** What an operator's setup changes in the policy, read on every call so a new revision applies from the next tool call. */
export interface LiveApprovals {
	/** Replaces the role's own pattern list when it returns one. */
	patterns(): [RegExp, string][] | undefined;
	/** The approval summary of a tool the setup brought (the MCP call), or `undefined`. */
	tool?(tool: string, args: Record<string, unknown>): string | undefined;
}

/** `base` is the role's own pattern list (default: the built-in one); `extra` are deployment additions (`APPROVAL_PATTERNS`). */
export function approvalPolicy(extra: string[] = [], base: [RegExp, string][] = DEFAULT_APPROVAL_PATTERNS, toolApprovals: Record<string, (args: Record<string, unknown>) => string | undefined> = {}, live?: LiveApprovals): ApprovalPolicy {
	const added: [RegExp, string][] = extra.map((p): [RegExp, string] => [new RegExp(p), `a command matching ${p}`]);
	return {
		needsApproval(tool, args) {
			const own = Object.hasOwn(toolApprovals, tool) ? toolApprovals[tool] : undefined;
			if (own) return own(args);
			const setupTool = live?.tool?.(tool, args);
			if (setupTool) return setupTool;
			if (tool !== "bash") return undefined;
			const command = String(args.command ?? "");
			const hit = [...(live?.patterns() ?? base), ...added].find(([pattern]) => pattern.test(command));
			return hit ? `${hit[1]}: ${command.slice(0, 160)}` : undefined;
		},
	};
}

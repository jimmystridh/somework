import { createHash } from "node:crypto";

export interface PolicyConfig {
	/** Messages the Manager may send to agents per hour. */
	messagesPerHour: number;
	/** How long a switch the model asked for waits for the owner's confirmation. */
	approvalTtlMs: number;
}

export const defaultPolicy: PolicyConfig = {
	messagesPerHour: 60,
	approvalTtlMs: 10 * 60_000,
};

/** A refusal that is the gateway's decision, not a failure: `status` is the HTTP answer the agent sees. */
export class PolicyError extends Error {
	override readonly name = "PolicyError";
	readonly status: number;
	readonly code: string;

	constructor(status: number, code: string, message: string) {
		super(message);
		this.status = status;
		this.code = code;
	}
}

export class RateLimiter {
	readonly #limit: number;
	readonly #windowMs: number;
	readonly #now: () => number;
	#stamps: number[] = [];

	constructor(limit: number, windowMs = 3_600_000, now: () => number = Date.now) {
		this.#limit = limit;
		this.#windowMs = windowMs;
		this.#now = now;
	}

	/** Counts one use; false when the window is full. */
	take(): boolean {
		const now = this.#now();
		this.#stamps = this.#stamps.filter((at) => now - at < this.#windowMs);
		if (this.#stamps.length >= this.#limit) return false;
		this.#stamps.push(now);
		return true;
	}
}

export type McpApproval = "ask" | "never" | "writes";

export interface ApprovalPattern {
	/** A regular expression tested against a bash command. */
	pattern: string;
	reason: string;
}

/** What the Manager asks the owner about before a tool call of its model goes ahead. The Manager's own default is nothing; Operations replaces it (ADR 0004). */
export interface ApprovalSettings {
	patterns: ApprovalPattern[];
	/** By MCP server name as the catalog names it. */
	mcp: Record<string, McpApproval>;
}

export type ToolCall = { kind: "bash"; command: string } | { kind: "mcp"; tool: string; input: string; readOnly: boolean };

/** Pi names the tools of a server `mcp__<server>__<tool>` with every character that is not a letter, digit or `_` replaced by `_`. */
const piServerName = (name: string): string => name.replace(/[^A-Za-z0-9_]/g, "_");

export class ApprovalRules {
	#patterns: { regex: RegExp; reason: string }[] = [];
	#mcp = new Map<string, McpApproval>();
	#settings: ApprovalSettings = { patterns: [], mcp: {} };

	/** Replaces everything at once; a pattern that is not a regular expression throws and leaves the earlier rules in place. */
	replace(settings: ApprovalSettings): void {
		const patterns = settings.patterns.map((entry) => ({ regex: new RegExp(entry.pattern), reason: entry.reason }));
		this.#patterns = patterns;
		this.#mcp = new Map(Object.entries(settings.mcp).map(([server, approval]) => [piServerName(server), approval]));
		this.#settings = { patterns: settings.patterns.map((entry) => ({ ...entry })), mcp: { ...settings.mcp } };
	}

	settings(): ApprovalSettings {
		return this.#settings;
	}

	/** Why the call needs the owner, or undefined when it may go ahead. */
	reasonFor(call: ToolCall): string | undefined {
		if (call.kind === "bash") return this.#patterns.find((entry) => entry.regex.test(call.command))?.reason;
		const server = [...this.#mcp.keys()].filter((name) => call.tool.startsWith(`mcp__${name}__`)).sort((a, b) => b.length - a.length)[0];
		const approval = server === undefined ? undefined : this.#mcp.get(server);
		if (approval === "ask") return `every call of the tool server ${server} needs the owner's approval`;
		if (approval === "writes" && !call.readOnly) return `${call.tool} is not read-only and the tool server ${server} asks for writes`;
		return undefined;
	}
}

export const callKey = (call: ToolCall): string => createHash("sha256").update(call.kind === "bash" ? `bash\0${call.command}` : `mcp\0${call.tool}\0${call.input}`).digest("hex").slice(0, 32);

/** One-use permissions the owner gave to exact calls (command text, or tool and arguments); they run out. */
export class ApprovalGrants {
	readonly #until = new Map<string, number>();
	readonly #now: () => number;

	constructor(now: () => number = Date.now) {
		this.#now = now;
	}

	allow(key: string, ttlMs: number): void {
		for (const [known, until] of this.#until) if (until <= this.#now()) this.#until.delete(known);
		this.#until.set(key, this.#now() + ttlMs);
	}

	consume(key: string): boolean {
		const until = this.#until.get(key);
		this.#until.delete(key);
		return until !== undefined && until > this.#now();
	}
}

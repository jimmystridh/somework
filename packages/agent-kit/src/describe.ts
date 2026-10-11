import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentProfile } from "./profile.ts";
import type { SetupReport } from "./setup/contract.ts";

/** What a service tells about itself on `/profile`: how it is set up, never what it holds. No keys, tokens, file paths or environment values. */
export interface AgentDescription {
	schema: 1;
	role: string;
	agentId: string;
	/** The image tag or build the service runs (`AGENT_VERSION`). */
	version: string;
	capabilities: { id: string; version: string }[];
	model: { provider: string; modelId: string; allowed: string[] };
	systemPrompt: { sha256: string; characters: number; text?: string };
	tools: { allowed: string[] | "all"; commandApprovals: { pattern: string; reason: string }[]; toolApprovals: string[]; extraApprovalPatterns: number };
	budgets: { default: { maxTokens: number; maxMinutes: number }; required: boolean; maxTokensCap: number; maxMinutesCap: number; dailyTokenLimit: number };
	concurrency: number;
	repository: {
		push: boolean;
		pullRequest: boolean;
		branchPrefix: string;
		noRepository: boolean;
		credential: "none" | "token" | "github-app";
		githubIdentity?: string;
		tokenHosts: string[];
		tokenExpires?: string;
		draftPullRequests: boolean;
		mirror?: { repositories: string[]; refreshMinutes: number };
	};
	skills: string[];
	chat: { mode: string; approvers?: string[] };
	events: { enabled: boolean; notifyTo?: string };
	observe: { enabled: boolean; scope?: string };
	timers?: { enabled: boolean };
	/** The agent's own Telegram bot: whether it runs and how many people may write to it (never who). */
	telegram?: { enabled: boolean; allowedUsers: number };
	/** What an operator's setup override and the fleet limits changed, with the role's defaults beside it (ADR 0004). Not part of `hash`. */
	setup?: SetupReport;
	/** Of everything above; changes when the setup changes. */
	hash: string;
}

export interface DescribeInput {
	profile: AgentProfile;
	agentId: string;
	version?: string;
	model: { provider: string; modelId: string };
	allowedModels: { provider: string; modelId: string }[];
	limits: { maxTokensCap: number; maxMinutesCap: number; dailyTokenLimit: number };
	concurrency: number;
	approvalPatterns: string[];
	git: { app: boolean; token: boolean; tokenHosts: string[]; tokenExpires?: string; draft: boolean; identity?: string; mirror?: { repositories: string[]; refreshMinutes: number } };
	chat: { mode: string; approvers?: string[] };
	events: { enabled: boolean; notifyTo?: string };
	observe: { enabled: boolean; scope?: string };
	timers?: { enabled: boolean };
	telegram?: { enabled: boolean; allowedUsers: number };
	setup?: SetupReport;
	/** False leaves out the prompt text (its hash and length stay). */
	includePrompt: boolean;
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/** `GIT_TOKEN_EXPIRES` is a note for people (an ISO date); anything else is dropped rather than shown. */
export const isoDateOrUndefined = (value: string | undefined): string | undefined => (value && /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z)?$/.test(value) ? value : undefined);

export function describeAgent(input: DescribeInput): AgentDescription {
	const { profile } = input;
	const prompt = profile.systemPrompt ?? "";
	const body: Omit<AgentDescription, "hash" | "setup"> = {
		schema: 1,
		role: profile.id,
		agentId: input.agentId,
		version: input.version || "unknown",
		capabilities: profile.capabilities.map((capability) => ({ id: capability.id, version: capability.version })),
		model: { ...input.model, allowed: input.allowedModels.map((model) => `${model.provider}/${model.modelId}`) },
		systemPrompt: { sha256: sha256(prompt), characters: prompt.length, ...(input.includePrompt ? { text: prompt } : {}) },
		tools: {
			allowed: profile.allowedTools ?? "all",
			commandApprovals: profile.approvalPatterns.map(([pattern, reason]) => ({ pattern: pattern.source, reason })),
			toolApprovals: Object.keys(profile.toolApprovals ?? {}).sort(),
			extraApprovalPatterns: input.approvalPatterns.length,
		},
		budgets: { default: { maxTokens: profile.defaultBudget.maxTokens, maxMinutes: profile.defaultBudget.maxMinutes }, required: profile.requireBudget !== false, ...input.limits },
		concurrency: input.concurrency,
		repository: {
			push: profile.git.push,
			pullRequest: profile.git.pullRequest,
			branchPrefix: profile.git.branchPrefix,
			noRepository: profile.noRepository === true,
			credential: input.git.app ? "github-app" : input.git.token ? "token" : "none",
			...(input.git.identity ? { githubIdentity: input.git.identity } : {}),
			tokenHosts: input.git.tokenHosts,
			...(input.git.tokenExpires ? { tokenExpires: input.git.tokenExpires } : {}),
			draftPullRequests: input.git.draft,
			...(input.git.mirror ? { mirror: input.git.mirror } : {}),
		},
		skills: profile.skills.allow,
		chat: input.chat,
		events: input.events,
		observe: input.observe,
		...(input.timers ? { timers: input.timers } : {}),
		...(input.telegram ? { telegram: input.telegram } : {}),
	};
	return { ...body, ...(input.setup ? { setup: input.setup } : {}), hash: sha256(JSON.stringify({ ...body, systemPrompt: { ...body.systemPrompt, text: undefined }, version: undefined })) };
}

/**
 * The document plus when this hash was first seen by the service: the hash is kept in a small file in the state directory, so a restart with
 * the same setup keeps the date and a changed setup gets a new one. A failure to read or write the file only loses the date.
 */
export function withChangeMarker(description: AgentDescription, stateFile: string, now: () => Date = () => new Date()): AgentDescription & { changedAt?: string } {
	try {
		const known = JSON.parse(readFileSync(stateFile, "utf8")) as { hash?: string; since?: string };
		if (known.hash === description.hash && typeof known.since === "string") return { ...description, changedAt: known.since };
	} catch {
		// first start, or an unreadable marker: it is written below
	}
	const since = now().toISOString();
	try {
		mkdirSync(dirname(stateFile), { recursive: true });
		const tmp = `${stateFile}.tmp`;
		writeFileSync(tmp, JSON.stringify({ hash: description.hash, since }));
		renameSync(tmp, stateFile);
		return { ...description, changedAt: since };
	} catch {
		return description;
	}
}

import { createHash } from "node:crypto";
import { PI_VERSION } from "../pi-version.ts";
import type { ApprovalRules } from "../policy.ts";
import { SYSTEM_PROMPT } from "../prompt.ts";
import type { Effort, SetupOverride, SetupStatus } from "./contract.ts";

/** What the Manager tells Operations about itself on `/profile`: the fields of the kit's description that apply to it, and `setup` as the kit reports it. No secrets, tokens or paths. */
export interface ManagerDescription {
	schema: 1;
	role: "manager";
	agentId: string;
	version: string;
	capabilities: never[];
	/** What Pi runs with now; `effort` is its thinking level. */
	model: { provider: string; modelId: string; effort?: Effort; allowed: string[] } | null;
	systemPrompt: { sha256: string; characters: number };
	operatorInstructions: { characters: number };
	tools: { allowed: "all"; commandApprovals: { pattern: string; reason: string }[]; toolApprovals: string[]; extraApprovalPatterns: number };
	skills: string[];
	mcp: { name: string; transport: string; approval: string }[];
	pi: { version: string; restartPending: boolean };
	setup: SetupStatus;
	/** Of everything above except `setup`; changes when the setup changes. */
	hash: string;
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

export interface DescribeManagerInput {
	agentId: string;
	override: SetupOverride | undefined;
	status: SetupStatus;
	rules: ApprovalRules;
	model: { provider: string; modelId: string; effort?: Effort } | undefined;
	restartPending: boolean;
}

export function describeManager(input: DescribeManagerInput): ManagerDescription {
	const { override } = input;
	const settings = input.rules.settings();
	const body: Omit<ManagerDescription, "setup" | "hash"> = {
		schema: 1,
		role: "manager",
		agentId: input.agentId,
		version: `pi ${PI_VERSION}`,
		capabilities: [],
		model: input.model ? { ...input.model, allowed: [] } : null,
		systemPrompt: { sha256: sha256(SYSTEM_PROMPT), characters: SYSTEM_PROMPT.length },
		operatorInstructions: { characters: override?.instructions?.length ?? 0 },
		tools: { allowed: "all", commandApprovals: settings.patterns, toolApprovals: Object.entries(settings.mcp).filter(([, approval]) => approval !== "never").map(([name]) => `mcp__${name}`).sort(), extraApprovalPatterns: 0 },
		skills: [...(override?.skills.library ?? []).map((skill) => `library/${skill.name}`), ...Object.keys(override?.skills.overlays ?? {}).map((name) => `overlay/${name}`)],
		mcp: (override?.mcp ?? []).map((entry) => ({ name: entry.name, transport: entry.transport, approval: entry.approval })),
		pi: { version: PI_VERSION, restartPending: input.restartPending },
	};
	return { ...body, setup: input.status, hash: sha256(JSON.stringify(body)) };
}

import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type Extension } from "@earendil-works/pi-durable";
import { redactText } from "../events/redact.ts";
import type { JobJournal } from "../journal.ts";
import type { DailyLedger } from "../ledger.ts";

export const AGENT_STATUS_TOOL = "agent_status";

// ---- the state summary and the agent_status tool ------------------------------------------------------------------------------------

export interface StateSources {
	agentId: string;
	role: string;
	capabilities: { id: string; version: string }[];
	ledger: Pick<DailyLedger, "usage">;
	journal?: Pick<JobJournal, "lines">;
	health?: () => { ready: boolean; reason?: string };
	/** True while the agent drains for a deployment (see `Drain`). */
	draining?: () => boolean;
	/** Extra facts from the events component, if there is one. */
	events?: () => unknown;
	/** The role's own facts. */
	roleContext?: () => Promise<string> | string;
	now?: () => Date;
}

/** The facts an agent may state about itself, from the service's own records. The model never writes any of it. */
export async function buildState(sources: StateSources): Promise<string> {
	const usage = sources.ledger.usage();
	const health = sources.health?.() ?? { ready: true };
	const pool = (name: string, p?: { used: number; limit: number; throttled?: boolean; stopped?: boolean }): string => (p ? `${name} ${p.used}/${p.limit} tokens${p.stopped ? " (stopped)" : p.throttled ? " (throttled)" : ""}` : "");
	const events = sources.events?.() as { handlers?: { name: string; enabled: boolean; runs?: number; errors?: number }[] } | undefined;
	const lines = [
		`now: ${(sources.now?.() ?? new Date()).toISOString()}`,
		`agent: ${sources.agentId} (role ${sources.role}); capabilities: ${sources.capabilities.map((c) => `${c.id}@${c.version}`).join(", ")}`,
		`ready: ${health.ready ? "yes" : `no (${health.reason ?? "unknown"})`}`,
		...(sources.draining?.() ? ["draining: yes (a deployment is under way: no new jobs start until it is done, the jobs that run finish, and chat still works)"] : []),
		`token pools today: ${[pool("tasks", usage.tasks), pool("events", usage.events), pool("chat", usage.chat)].filter(Boolean).join("; ")}`,
		...(events?.handlers?.length ? [`event handlers: ${events.handlers.map((h) => `${h.name} ${h.enabled ? "on" : "off"}${h.runs ? ` (${h.runs} runs, ${h.errors ?? 0} errors)` : ""}`).join(", ")}`] : []),
		"recent jobs (newest first):",
		...((sources.journal?.lines(10) ?? []).length > 0 ? sources.journal!.lines(10).map((line) => `  ${line}`) : ["  (none yet)"]),
	];
	const extra = sources.roleContext ? await Promise.resolve(sources.roleContext()).catch(() => "(the role's own facts could not be built)") : "";
	return redactText([...lines, ...(extra ? ["", extra] : [])].join("\n"));
}

/** The read-only tool that returns the same facts live. */
export function createStatusTool(state: () => Promise<string>): { extension: Extension<any>; toolNames: string[] } {
	const tools = [
		defineTool({
			name: AGENT_STATUS_TOOL,
			description: "The facts about this agent right now, as the service records them: readiness, today's token pools, the recent jobs with their outcomes and whatever the role itself tracks. Read only; takes no arguments.",
			parameters: Type.Object({}),
			replay: "safe",
			async execute() {
				return { content: [{ type: "text" as const, text: await state() }] };
			},
		}),
	];
	return { extension: defineExtension({ name: "agent-status", tools }), toolNames: tools.map((tool) => tool.name) };
}

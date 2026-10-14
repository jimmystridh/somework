import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { PR_WATCH_INSTRUCTIONS, mirrorFreshness, type JobPlan, type JobTool, type Log, type ThreadRoleHooks } from "@somework/agent-kit";
import type { AikidoClient } from "./aikido/client.ts";
import { createAikidoLookupTools } from "./aikido/tool.ts";
import { AttemptLedger } from "./attempts.ts";
import { CLI_CHAT_GUIDANCE } from "./prompt.ts";
import { normaliseRepositoryUrl, type FixerSettings } from "./settings.ts";

export const FIXER_CHAT_INSTRUCTIONS = `You are the Aikido fixer of this platform. Aikido reports security issues; you read one, change the repository the smallest safe amount, and open a pull request that a person must review. You offer two jobs, started with tools: fix_issue (an Aikido issue by its number: code.fix) and follow_up_pull_request (for a pull request you opened: the review comments, comments and failing checks since your newest commit: code.fix.followup). A job runs in the background and its result is posted to the conversation when it is done; do not wait for it. The state summary and the tools fixer_status and agent_status tell you what you did recently and what your limits are; aikido_lookup reads one Aikido issue by its id. You never merge, never touch protected paths, and you stop at the daily and per-issue limits. Your own pull requests are followed up automatically after 15, 60 and 240 minutes; beyond that: If you have the watch_pull_request tool, use it on a pull request that was just posted to you, to follow up on its CI or build result and its review comments without polling it. ${PR_WATCH_INSTRUCTIONS}`;

/** A request that says what is wrong or what to do (not just "fix the feedback on PR 5229") carries its words to the model. */
const EXPLAINS = /[:;]|\b(because|since|fails?|failing|failed|broken|stale|needs?|needed|must|should|regenerate|run)\b/i;
const PULL_REQUEST_URL = /https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/pull\/(\d{1,9})/i;

export interface FixerChatOptions {
	settings: FixerSettings;
	aikido: Pick<AikidoClient, "resolveIssue">;
	stateDir: string;
	/** `GIT_MIRROR_DIR` of the service, when it has one: the freshness of the mirror is reported from it. */
	mirrorDir?: string;
	log?: Log;
	now?: () => Date;
}

/** Where the host-side attempt records are, read by the chat only: the model cannot reach the file. */
export const ATTEMPTS_FILE = "aikido-attempts.json";

function factsText(ledger: AttemptLedger, mirrorDir: string | undefined, repository: string, now: Date): string {
	const facts = ledger.facts(10);
	const fresh = mirrorDir ? mirrorFreshness(mirrorDir, repository) : undefined;
	const lines = [
		`Repository: ${repository}`,
		`Fix tasks today: ${facts.today} of ${facts.dailyCap}. Attempts allowed per issue: ${facts.maxAttemptsPerIssue}, with ${facts.cooldownMinutes} minutes between them.`,
		fresh === undefined ? "Local clone: not refreshed since this service started." : `Local clone refreshed ${Math.max(0, Math.round((now.getTime() - fresh) / 60_000))} minutes ago.`,
	];
	if (facts.recent.length === 0) lines.push("No fix attempt has finished since records began.");
	else {
		lines.push("Recent attempts, newest first:");
		for (const entry of facts.recent) {
			lines.push(`- issue ${entry.groupId}: ${entry.outcome} at ${entry.at}${entry.imported ? " (imported history)" : ""}${entry.branch ? `, branch ${entry.branch}` : ""}${entry.prUrl ? `, ${entry.prUrl}` : ""}${entry.tokens !== undefined ? `, ${entry.tokens} tokens` : ""}${entry.imported ? "" : ` (attempts so far: ${entry.attempts})`}`);
		}
	}
	return lines.join("\n");
}

/**
 * What the Aikido fixer adds to conversations. `aikido_lookup` (one issue by id, read only) and `fixer_status` (the host's own record of attempts
 * and limits) sit next to the kit's tools. `fix_issue` starts a code.fix job for an Aikido issue (optionally a `repository` that is configured, and
 * hints), which runs through the same hooks as a job from an event: eligibility, daily cap, per-issue attempts and cool-down, protected paths, size,
 * secret and check guards, and a pull request for a person to review. `follow_up_pull_request` starts a code.fix.followup job for a pull request this
 * agent recorded: the latest one, or the one named.
 */
export function fixerChat(options: FixerChatOptions): ThreadRoleHooks {
	const now = options.now ?? (() => new Date());
	const ledger = new AttemptLedger(
		join(options.stateDir, ATTEMPTS_FILE),
		{ maxAttemptsPerIssue: options.settings.maxAttemptsPerIssue, cooldownMinutes: options.settings.cooldownMinutes, dailyCap: options.settings.dailyCap },
		now,
	);
	const repository = options.settings.repositories[0]!;
	const allowed = new Map(options.settings.repositories.map((url) => [normaliseRepositoryUrl(url), url]));
	const lookup = createAikidoLookupTools({ aikido: options.aikido, ...(options.log ? { log: options.log } : {}) });
	const status = defineTool({
		name: "fixer_status",
		description: "What this agent has done on Aikido issues: today's count against the daily cap, the limits, and the recent attempts with their outcome, branch and pull request. From the service's own records.",
		parameters: Type.Object({}),
		replay: "safe",
		async execute() {
			return { content: [{ type: "text" as const, text: factsText(ledger, options.mirrorDir, repository, now()) }] };
		},
	});
	const extension = defineExtension({ name: "fixer-chat", tools: [status, ...lookup.extension.tools] });
	/** The pull requests this agent opened and recorded, newest first. */
	const openedPullRequests = () => ledger.facts(200).recent.filter((entry) => entry.outcome === "pr_opened" && entry.prUrl && entry.branch);
	const targetOf = (requested: string | undefined): string | { refuse: string } => {
		if (requested === undefined) return repository;
		return allowed.get(normaliseRepositoryUrl(requested)) ?? { refuse: "I only fix the repository I am configured for" };
	};
	const fixIssue: JobTool = {
		name: "fix_issue",
		description: "Fix one Aikido issue: read it, change the repository the smallest safe amount and open a pull request for a person to review. Give the issue's number; `hint` carries what the requester said about how.",
		parameters: Type.Object({
			issue: Type.String({ description: "the Aikido issue's number, for example 1234" }),
			hint: Type.Optional(Type.String({ maxLength: 2000 })),
			repository: Type.Optional(Type.String({ maxLength: 400, description: "only a repository this agent is configured for" })),
		}),
		plan(args: { issue?: string; hint?: string; repository?: string }): JobPlan | { refuse: string } {
			const id = String(args.issue ?? "").trim().replace(/^#/, "");
			if (!/^\d{1,12}$/.test(id)) return { refuse: "name exactly one Aikido issue by its number, for example 1234" };
			const target = targetOf(args.repository);
			if (typeof target !== "string") return target;
			const hint = (args.hint ?? "").replace(/\s+/g, " ").trim();
			return { capability: { id: "code.fix", version: "1" }, input: { issue: { id }, repository: { url: target }, ...(hint.length > 2 ? { hint: hint.slice(0, 2000) } : {}) }, label: `fix Aikido issue ${id}` };
		},
	};
	const followUp: JobTool = {
		name: "follow_up_pull_request",
		description: "Go through the review comments, comments and failing checks of a pull request this agent opened, since its newest commit, and push what they ask for. Without `pullRequest` it is the latest one the agent opened; give its number or address for another. `hint` carries what the requester said is wrong or what to do.",
		parameters: Type.Object({
			pullRequest: Type.Optional(Type.String({ maxLength: 200, description: "the pull request's number or address" })),
			hint: Type.Optional(Type.String({ maxLength: 2000 })),
			repository: Type.Optional(Type.String({ maxLength: 400 })),
		}),
		plan(args: { pullRequest?: string; hint?: string; repository?: string }): JobPlan | { refuse: string } {
			const target = targetOf(args.repository);
			if (typeof target !== "string") return target;
			const named = args.pullRequest === undefined ? undefined : (PULL_REQUEST_URL.exec(args.pullRequest)?.[1] ?? /^#?(\d{1,9})$/.exec(args.pullRequest.trim())?.[1]);
			if (args.pullRequest !== undefined && !named) return { refuse: "name the pull request by its number or its address" };
			const known = openedPullRequests();
			if (known.length === 0) return { refuse: "I have no pull request of my own on record to follow up on" };
			const entry = named ? known.find((candidate) => candidate.prUrl!.endsWith(`/pull/${named}`)) : known[0];
			if (!entry) return { refuse: `I only follow up on pull requests I opened and recorded, and #${named} is not one of them` };
			const hint = (args.hint ?? "").replace(PULL_REQUEST_URL, "").replace(/\s+/g, " ").trim();
			return {
				capability: { id: "code.fix.followup", version: "1" },
				input: { issue: { id: entry.groupId }, repository: { url: target, ref: entry.branch! }, followUp: { pullRequest: entry.prUrl!, branch: entry.branch!, round: 1 }, ...(EXPLAINS.test(hint) ? { hint: hint.slice(0, 2000) } : {}) },
				label: `follow up on pull request #${entry.prUrl!.split("/").pop()}`,
			};
		},
	};
	return {
		instructions: options.settings.sandboxCli ? `${FIXER_CHAT_INSTRUCTIONS}\n\n${CLI_CHAT_GUIDANCE}` : FIXER_CHAT_INSTRUCTIONS,
		context: () => factsText(ledger, options.mirrorDir, repository, now()),
		extension,
		toolNames: ["fixer_status", ...lookup.toolNames],
		checkout: () => ({ repoUrl: repository }),
		jobTools: [fixIssue, followUp],
	};
}

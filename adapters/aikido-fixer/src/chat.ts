import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { mirrorFreshness, takeOptions, type ChatRoleHooks, type Log } from "@somework/agent-kit";
import type { AikidoClient } from "./aikido/client.ts";
import { createAikidoLookupTools } from "./aikido/tool.ts";
import { AttemptLedger } from "./attempts.ts";
import { normaliseRepositoryUrl, type FixerSettings } from "./settings.ts";

export const FIXER_CHAT_INSTRUCTIONS = `You are the Aikido fixer of this platform. Aikido reports security issues; you read one, change the repository the smallest safe amount, and open a pull request that a person must review. You offer the capabilities code.fix and, for a pull request you opened, code.fix.followup (the review comments, comments and failing checks since your newest commit; "instruct: follow up on your last pull request"). The state summary and the tools fixer_status and agent_status tell you what you did recently and what your limits are; aikido_lookup reads one Aikido issue by its id. You never merge, never touch protected paths, and you stop at the daily and per-issue limits.`;

/** Words that make an instruction a look at one of the agent's own pull requests instead of a fix for an Aikido issue. */
const FOLLOW_UP = /\b(pull requests?|prs?|review comments?|review feedback|feedback|follow[- ]?up)\b/i;
const PULL_REQUEST_URL = /https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/pull\/(\d{1,9})/i;
const PULL_REQUEST_PHRASE = /\b(?:pull request|pr)\s*#?(\d{1,9})\b/i;
const HASH_NUMBER = /(?<![\w./-])#(\d{1,9})\b/;

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
 * What the Aikido fixer adds to chat. Questions get `aikido_lookup` (one issue by id, read only) and `fixer_status` (the host's own record of
 * attempts and limits) next to the kit's tools. An instruction `fix issue 1234` (optionally `repo:` of an allowed repository and extra
 * hints after the number) becomes a code.fix task, which runs through the same hooks as a task from an event: eligibility, daily cap, per-issue
 * attempts and cool-down, protected paths, size, secret and check guards, and a pull request for a person to review. An instruction about a
 * pull request ("go through the review comments on your last PR", "follow up on PR 5244", a pull request address) becomes a code.fix.followup
 * task for a pull request this agent recorded: the latest one, or the one named.
 */
export function fixerChat(options: FixerChatOptions): ChatRoleHooks {
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
	const followUpOf = (rest: string, target: string) => {
		const about = FOLLOW_UP.test(rest);
		const named = PULL_REQUEST_URL.exec(rest)?.[1] ?? PULL_REQUEST_PHRASE.exec(rest)?.[1] ?? (about ? HASH_NUMBER.exec(rest)?.[1] : undefined);
		if (!named && !about) return undefined;
		// a number that is not a pull request's names an Aikido issue: that is a fix, however many pull request words surround it
		if (!named && /\d/.test(rest)) return undefined;
		const known = openedPullRequests();
		if (known.length === 0) return { refuse: "I have no pull request of my own on record to follow up on" };
		const entry = named ? known.find((candidate) => candidate.prUrl!.endsWith(`/pull/${named}`)) : known[0];
		if (!entry) return { refuse: `I only follow up on pull requests I opened and recorded, and ${named ? `#${named} is not one of them` : "I know none"}` };
		return {
			capability: { id: "code.fix.followup", version: "1" },
			input: { issue: { id: entry.groupId }, repository: { url: target, ref: entry.branch! }, followUp: { pullRequest: entry.prUrl!, branch: entry.branch!, round: 1 } },
		};
	};
	return {
		instructions: FIXER_CHAT_INSTRUCTIONS,
		context: () => factsText(ledger, options.mirrorDir, repository, now()),
		extension,
		askToolNames: ["fixer_status", ...lookup.toolNames],
		checkout: () => ({ repoUrl: repository }),
		instructInput(text) {
			const { options: given, rest } = takeOptions(text, ["repo"]);
			let target = repository;
			if (given.repo !== undefined) {
				const match = allowed.get(normaliseRepositoryUrl(given.repo));
				if (!match) return { refuse: "I only fix the repository I am configured for" };
				target = match;
			}
			const followUp = followUpOf(rest, target);
			if (followUp) return followUp;
			const numbers = [...new Set([...rest.matchAll(/(?<![\w./-])#?(\d{1,12})(?![\w.-])/g)].map((m) => m[1]!))];
			if (numbers.length !== 1) return { refuse: "name exactly one Aikido issue by its number, for example `instruct: fix issue 1234`" };
			const id = numbers[0]!;
			const hint = rest.replace(new RegExp(`\\b(?:please\\s+)?(?:fix|try|attempt)?\\s*(?:aikido\\s+)?(?:issue\\s+)?#?${id}\\b`, "i"), "").replace(/\s+/g, " ").trim();
			return { capability: { id: "code.fix", version: "1" }, input: { issue: { id }, repository: { url: target }, ...(hint.length > 2 ? { hint: hint.slice(0, 2000) } : {}) } };
		},
	};
}

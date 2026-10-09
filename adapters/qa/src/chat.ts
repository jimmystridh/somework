import { Type } from "@earendil-works/pi-ai";
import { repositoryTarget, takeOptions, type ChatJobTool, type ChatRoleHooks, type PlannedInstruction, type PlannedJob } from "@somework/agent-kit";

/** The tools of the ticket system that only read: the chat may use them, the verification tools that write stay with the job. */
export const CHAT_READ_TOOLS = ["jira_get_issue", "jira_search", "jira_changelog", "jira_get_comments"] as const;

export const CHAT_INSTRUCTIONS = `You are the QA agent of this platform. Your job is to verify a ticket against a revision in a real browser and report a verdict with evidence (capability qa.verify); you write to the ticket system only after the requester approved.
In a conversation you are a capable colleague, not just a status line. You can read the ticket system (jira_get_issue, jira_search, jira_changelog, jira_get_comments) and, when a repository is configured, the checkout of its default branch with the read tool: use them to answer questions about tickets, code, test coverage, risks and what a change should be verified against, to analyse feedback or review comments the requester pastes or names, to draft test scenarios and to say what you would check. Do the reading first and answer from what you found; do not tell the requester to rephrase when you can look it up.
What you cannot do in a conversation is change code, push a branch or write to the ticket system: say so plainly, say what would be needed (a developer agent for code changes, an instruction for a verification: "instruct: verify ABC-123", several tickets "instruct: verify ABC-123 ABC-124", or a state "instruct: verify the tickets in Test"), and offer the analysis or the draft instead. Your recent verifications and their verdicts are in the state summary and the agent_status tool.`;

/**
 * What QA adds to chat. An instruction from the manager becomes a qa.verify task for the ticket it names (a key like ABC-123 in the text);
 * optional leading lines `repo: https://...`, `ref: <branch|sha>`, `scenario: ...` and `app: <profile>`. Writes to the ticket system still wait for
 * approval, which is asked of the manager in the chat.
 */
/** What QA is when the owner's manager asks it to do something in chat (the open tier): its normal tools, in a scratch checkout, with approvals for risky steps. */
export const CHAT_OPEN_INSTRUCTIONS = `You are the QA agent of this platform, on a Windows machine with a real browser (Edge), the product's test stack and a read access token for the repository. When the owner's manager asks you for something, do it: read tickets and code, run the build, tests and the application, drive the browser with qa-browser, reproduce a problem, investigate pull request feedback or failures, change files in your scratch checkout to try a fix and run the checks against it, and report what you found with evidence.
You hold no credential to push to the code host or to write to the ticket system from a conversation (the verification job has its own approved tools for the ticket system). So deliver changes as a clear patch or description in your reply and say that someone with push access must apply it; do not pretend to have pushed anything.
When you are asked to verify tickets ("the tickets in Test", "verify SAD-123", "check again what failed yesterday"), find them with jira_search or jira_get_issue and call verify_ticket once for each. That is the real verification: the revision from the ticket's pull request, the application started from its profile, evidence, the verdict and the ticket update. It is queued to run after your reply, one at a time, and each result is posted to the conversation. Do not verify a ticket by hand with your own commands, and do not queue a ticket that already carries the verified label unless you were asked to run it again. Say which tickets you queued and which you left out, and why.`;

/** What the chat needs from the ticket system to turn "the tickets in Test" into tickets. */
export interface TicketQueue {
	search(jql: string, max: number): Promise<{ key: string; labels: string[]; summary?: string }[]>;
	/** The status a ticket waits in for verification (JIRA_TEST_STATUS): "in Test" in an instruction means this one. */
	testStatus: string;
	/** The label a verified ticket carries; tickets with it are not picked up again unless the instruction says so. */
	verifiedLabel: string;
}

const KEY = /\b([A-Z][A-Z0-9]+-\d+)\b/g;
const STATUS_NAME = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,39}$/;
const AGAIN = /\b(again|re-?verify|re-?test|all of them|even if)\b/i;
const HOW = "name the ticket(s), for example `instruct: verify ABC-123` or `instruct: verify ABC-123 ABC-124`, or say which state to work through, for example `instruct: verify the tickets in Test`, a line `status: <name>` or a line `jql: <query>`";
export const DEFAULT_BATCH_MAX = 5;

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const quoted = (text: string): string => text.replace(/["\\]/g, "");

/** The verification as a tool: what the model may call when the manager asks for a ticket in plain words. */
export function verifyTicketTool(ticketPattern: RegExp, defaults: { url?: string; ref?: string }, perTurn: number): ChatJobTool {
	return {
		name: "verify_ticket",
		description: "Verify one ticket in the browser against its fix and report a verdict (verified, not_fixed or blocked) with evidence, as the verification job does. Give the ticket key; the rest is optional: `scenario` (what to check, in words), `app` (the application profile) and `repo`/`ref` (another repository or revision than the default).",
		parameters: Type.Object({
			ticket: Type.String({ description: "the ticket key, for example SAD-123" }),
			scenario: Type.Optional(Type.String({ maxLength: 1000 })),
			app: Type.Optional(Type.String({ maxLength: 60 })),
			repo: Type.Optional(Type.String({ maxLength: 400 })),
			ref: Type.Optional(Type.String({ maxLength: 200 })),
		}),
		perTurn,
		plan(args: { ticket?: string; scenario?: string; app?: string; repo?: string; ref?: string }): PlannedJob | { refuse: string } {
			const ticket = String(args.ticket ?? "").trim();
			if (!ticketPattern.test(ticket)) return { refuse: `${ticket.slice(0, 40) || "(no key)"} is not a ticket key this agent handles` };
			if (args.app !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,60}$/.test(args.app)) return { refuse: "app must be the name of an application profile of this machine" };
			const target = repositoryTarget({ ...(args.repo ? { repo: args.repo } : {}), ...(args.ref ? { ref: args.ref } : {}) }, defaults);
			if ("refuse" in target) return target;
			return {
				capability: { id: "qa.verify", version: "1" },
				input: { ticket, repository: { url: target.url, ref: target.ref }, ...(args.scenario ? { scenario: args.scenario.slice(0, 1000) } : {}), ...(args.app ? { app: args.app } : {}) },
			};
		},
	};
}

export function qaChat(env: NodeJS.ProcessEnv = process.env, ticketPattern: RegExp = /^[A-Z][A-Z0-9]+-\d+$/, tools?: { extension: ChatRoleHooks["extension"] }, queue?: TicketQueue): ChatRoleHooks {
	const defaults = { url: env.CHAT_REPOSITORY_URL, ref: env.CHAT_REPOSITORY_REF };
	const asked = Number(env.QA_CHAT_BATCH_MAX);
	const batchMax = Number.isInteger(asked) && asked >= 1 && asked <= 10 ? asked : DEFAULT_BATCH_MAX;
	return {
		instructions: CHAT_INSTRUCTIONS,
		openInstructions: CHAT_OPEN_INSTRUCTIONS,
		...(tools ? { extension: tools.extension, askToolNames: CHAT_READ_TOOLS } : {}),
		...(queue ? { jobTools: [verifyTicketTool(ticketPattern, defaults, batchMax)] } : {}),
		...(defaults.url ? { checkout: () => ({ repoUrl: defaults.url!, ...(defaults.ref ? { ref: defaults.ref } : {}) }) } : {}),
		instructInput(text): PlannedInstruction | Promise<PlannedInstruction> {
			const { options, rest } = takeOptions(text, ["repo", "ref", "scenario", "app", "status", "jql"]);
			const target = repositoryTarget(options, defaults);
			if ("refuse" in target) return target;
			if (options.app !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,60}$/.test(options.app)) return { refuse: "app: must be the name of an application profile of this machine" };
			const job = (ticket: string): PlannedJob => ({
				capability: { id: "qa.verify", version: "1" },
				input: { ticket, repository: { url: target.url, ref: target.ref }, ...(options.scenario ? { scenario: options.scenario.slice(0, 1000) } : {}), ...(options.app ? { app: options.app } : {}) },
			});
			const named = [...new Set([...rest.matchAll(KEY)].map((match) => match[1]!))].filter((key) => ticketPattern.test(key));
			if (named.length === 1) return job(named[0]!);
			if (named.length > 1) {
				const some = named.slice(0, batchMax);
				const more = named.length > some.length ? ` The first ${some.length} only: ${named.length - some.length} more are left out (at most ${batchMax} per instruction).` : "";
				return { batch: some.map(job), intro: `Verifying ${some.length} tickets, one at a time: ${some.join(", ")}.${more}` };
			}
			const jql = options.jql ? options.jql.slice(0, 500) : statusJql(options.status ?? statusIn(rest, queue?.testStatus));
			if (jql === undefined) return { refuse: HOW };
			if (!queue) return { refuse: "the ticket system is not connected, so I cannot look tickets up: name them, for example `instruct: verify ABC-123 ABC-124`" };
			const again = AGAIN.test(rest);
			return queue.search(jql, batchMax * 4).then((found): PlannedInstruction => {
				const handled = found.filter((issue) => ticketPattern.test(issue.key));
				const wanted = handled.filter((issue) => again || !issue.labels.includes(queue.verifiedLabel));
				const left = handled.length - wanted.length;
				if (wanted.length === 0) return { refuse: `no ticket matches ${options.jql ? "that query" : "that state"} and is waiting for verification${left > 0 ? ` (${left} already carry the ${queue.verifiedLabel} label: say "again" to verify them anyway)` : ""}` };
				const some = wanted.slice(0, batchMax);
				const skipped = left > 0 ? ` ${left} already verified, skipped.` : "";
				const more = wanted.length > some.length ? ` The first ${some.length} of ${wanted.length} now; ask again for the rest.` : "";
				return { batch: some.map((issue) => job(issue.key)), intro: `Found ${some.length} ticket${some.length === 1 ? "" : "s"} to verify: ${some.map((issue) => issue.key).join(", ")}.${skipped}${more} I verify them one at a time and answer after each.` };
			});
		},
	};

	function statusIn(text: string, testStatus: string | undefined): string | undefined {
		if (!testStatus) return undefined;
		return new RegExp(`\\bin\\s+(?:the\\s+)?["'\`]?${escapeRegExp(testStatus)}\\b`, "i").test(text) ? testStatus : undefined;
	}

	function statusJql(status: string | undefined): string | undefined {
		if (status === undefined) return undefined;
		return STATUS_NAME.test(status) ? `status = "${quoted(status)}" ORDER BY updated ASC` : undefined;
	}
}

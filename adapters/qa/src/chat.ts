import { Type } from "@earendil-works/pi-ai";
import { repositoryTarget, type JobPlan, type JobTool, type ThreadRoleHooks } from "@somework/agent-kit";

/** The tools of the ticket system that only read: conversations may use them, the verification tools that write stay with the job. */
export const CHAT_READ_TOOLS = ["jira_get_issue", "jira_search", "jira_changelog", "jira_get_comments", "jira_get_attachments"] as const;

/** The things only one verification at a time can have: the application stack that is started from a profile, and the browser that drives it. */
export const QA_RESOURCES = ["app-stack"] as const;

export const CHAT_INSTRUCTIONS = `You are the QA agent of this platform, on a Windows machine with a real browser (Edge), the product's test stack and a read access token for the repository. You verify tickets against a revision in a real browser and report a verdict with evidence (capability qa.verify). In a conversation you are a capable colleague: you read tickets and code, run the build, tests and the application, drive the browser with qa-browser, reproduce a problem, investigate pull request feedback or failures, change files in your scratch directory to try a fix, and report what you found with evidence.
You can read the ticket system (jira_get_issue, jira_search, jira_changelog, jira_get_comments, and the ticket's attachments with jira_get_attachments: look at them when a ticket has any). Do the reading first and answer from what you found; do not tell the requester to rephrase when you can look it up.
You hold no credential to push to the code host or to write to the ticket system from a conversation (the verification job has its own approved tools for the ticket system). Deliver changes as a clear patch or description and say that someone with push access must apply it; do not pretend to have pushed anything.
When you are asked to verify tickets ("the tickets in Test", "verify SAD-123", "check again what failed yesterday"), find them with jira_search or jira_get_issue and call verify_ticket once for each. That is the real verification, and it runs as a job in the background: the application stack is used by one verification at a time, so several tickets run one after another and each result is posted to the conversation when it is done. Do not verify a ticket by hand with your own commands, and do not start a ticket that already carries the verified label unless you were asked to run it again. Do not start more than about five at once: say which you started and which you left out, and why. While a verification runs the application stack is its own: look at the resources tool before you start the application by hand.`;

const VERDICT_WORDS: Record<string, string> = {
	verified: "VERIFIED",
	not_fixed: "NOT FIXED",
	blocked: "BLOCKED: the verification could not be completed",
	skipped: "SKIPPED",
};
const squeeze = (text: unknown, max: number): string => {
	const flat = String(text ?? "").replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/**
 * A finished verification in words for the conversation: what it found first (the notes), then every acceptance check with what was seen,
 * what was created for the test, what was written to the ticket and which files hold the evidence. Chat replies are the manager's view of the
 * work, so the findings are in them and not only in the ticket.
 */
export function describeQaResult(result: unknown): string | undefined {
	if (!result || typeof result !== "object") return undefined;
	const r = result as Record<string, any>;
	if (typeof r.verdict !== "string") return undefined;
	const lines = [`${r.ticket ? `${r.ticket}: ` : ""}${VERDICT_WORDS[r.verdict] ?? r.verdict}`];
	const revision = [r.revision?.frontendSha ? `front end ${String(r.revision.frontendSha).slice(0, 12)}` : "", r.revision?.backendRevision ? `back end ${squeeze(r.revision.backendRevision, 40)}` : ""].filter(Boolean);
	if (revision.length > 0) lines.push(`Revision tested: ${revision.join(" · ")}${r.revision?.note ? ` — ${squeeze(r.revision.note, 160)}` : ""}`);
	if (typeof r.notes === "string" && r.notes.trim() !== "") lines.push("", `Findings: ${squeeze(r.notes, 1500)}`);
	const checks = Array.isArray(r.acceptanceChecks) ? r.acceptanceChecks : [];
	if (checks.length > 0) {
		const passed = checks.filter((check: any) => check?.passed === true).length;
		lines.push("", `Acceptance checks (${passed} passed, ${checks.length - passed} failed):`);
		for (const check of checks.slice(0, 20)) lines.push(`${check?.passed === true ? "✔" : "✘"} ${squeeze(check?.criterion, 200)}${check?.evidence ? ` — ${squeeze(check.evidence, 300)}` : ""}`);
		if (checks.length > 20) lines.push(`… and ${checks.length - 20} more`);
	}
	const fixtures = Array.isArray(r.fixtures) ? r.fixtures : [];
	if (fixtures.length > 0) lines.push("", `Created for the test: ${fixtures.slice(0, 8).map((fixture: any) => `${squeeze(fixture?.description, 120)}${fixture?.keys ? ` (${squeeze(fixture.keys, 80)})` : ""}`).join("; ")}`);
	const jira = r.jira ?? {};
	const wrote = [jira.commented ? "commented" : "", jira.labelled ? "labelled" : "", jira.transitioned ? "moved back to In Progress" : "", jira.attached ? "video attached" : ""].filter(Boolean);
	lines.push("", `Ticket: ${wrote.length > 0 ? wrote.join(", ") : "nothing was written"}${jira.skippedReason ? ` (${squeeze(jira.skippedReason, 200)})` : ""}`);
	const evidence = Array.isArray(r.evidence) ? r.evidence.map((item: any) => squeeze(item?.filename, 120)).filter(Boolean) : [];
	if (evidence.length > 0) lines.push(`Evidence: ${evidence.join(", ")}`);
	return lines.join("\n");
}

/** The verification as a tool: what the model may call when the manager asks for a ticket in plain words. */
export function verifyTicketTool(ticketPattern: RegExp, defaults: { url?: string; ref?: string }): JobTool {
	return {
		name: "verify_ticket",
		description: "Verify one ticket in the browser against its fix: the revision from the ticket's pull request, the application started from its profile, evidence, a verdict (verified, not_fixed or blocked) and the update of the ticket. Give the ticket key; the rest is optional: `scenario` (what to check, in words), `app` (the application profile) and `repo`/`ref` (another repository or revision than the default).",
		parameters: Type.Object({
			ticket: Type.String({ description: "the ticket key, for example SAD-123" }),
			scenario: Type.Optional(Type.String({ maxLength: 1000 })),
			app: Type.Optional(Type.String({ maxLength: 60 })),
			repo: Type.Optional(Type.String({ maxLength: 400 })),
			ref: Type.Optional(Type.String({ maxLength: 200 })),
		}),
		plan(args: { ticket?: string; scenario?: string; app?: string; repo?: string; ref?: string }): JobPlan | { refuse: string } {
			const ticket = String(args.ticket ?? "").trim();
			if (!ticketPattern.test(ticket)) return { refuse: `${ticket.slice(0, 40) || "(no key)"} is not a ticket key this agent handles` };
			if (args.app !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,60}$/.test(args.app)) return { refuse: "app must be the name of an application profile of this machine" };
			const target = repositoryTarget({ ...(args.repo ? { repo: args.repo } : {}), ...(args.ref ? { ref: args.ref } : {}) }, defaults);
			if ("refuse" in target) return target;
			return {
				capability: { id: "qa.verify", version: "1" },
				input: { ticket, repository: { url: target.url, ref: target.ref }, ...(args.scenario ? { scenario: args.scenario.slice(0, 1000) } : {}), ...(args.app ? { app: args.app } : {}) },
				label: `verify ${ticket}`,
			};
		},
	};
}


export function qaChat(env: NodeJS.ProcessEnv = process.env, ticketPattern: RegExp = /^[A-Z][A-Z0-9]+-\d+$/, tools?: { extension: ThreadRoleHooks["extension"] }): ThreadRoleHooks {
	const defaults = { url: env.CHAT_REPOSITORY_URL, ref: env.CHAT_REPOSITORY_REF };
	return {
		instructions: CHAT_INSTRUCTIONS,
		describeResult: describeQaResult,
		jobResources: (capabilityId) => (capabilityId === "qa.verify" ? [...QA_RESOURCES] : undefined),
		jobTools: [verifyTicketTool(ticketPattern, defaults)],
		...(tools ? { extension: tools.extension, toolNames: CHAT_READ_TOOLS } : {}),
		...(defaults.url ? { checkout: () => ({ repoUrl: defaults.url!, ...(defaults.ref ? { ref: defaults.ref } : {}) }) } : {}),
	};
}

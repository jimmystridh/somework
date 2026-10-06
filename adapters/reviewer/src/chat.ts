import { repositoryTarget, takeOptions, type ChatRoleHooks } from "@somework/agent-kit";

export const CHAT_INSTRUCTIONS = `You are the reviewer agent of this platform. You review a branch or a pull request read-only and return findings by severity; you never push, comment or change anything. You offer the capability code.review. Your recent reviews and their verdicts are in the state summary and the agent_status tool.`;

/**
 * What the reviewer adds to chat. An instruction from the manager becomes a code.review task: optional leading lines `repo: https://...`,
 * `ref: <branch|sha>`, `pr: <number>` and `ticket: <KEY-1>` (the repository defaults to CHAT_REPOSITORY_URL), the rest is the focus of the
 * review. It stays read-only: the role's own guards refuse every command that is not plain inspection.
 */
export function reviewerChat(env: NodeJS.ProcessEnv = process.env): ChatRoleHooks {
	const defaults = { url: env.CHAT_REPOSITORY_URL, ref: env.CHAT_REPOSITORY_REF };
	return {
		instructions: CHAT_INSTRUCTIONS,
		instructInput(text) {
			const { options, rest } = takeOptions(text, ["repo", "ref", "pr", "ticket"]);
			const target = repositoryTarget(options, defaults);
			if ("refuse" in target) return target;
			let pullRequest: number | undefined;
			if (options.pr !== undefined) {
				pullRequest = Number(options.pr.replace(/^#/, ""));
				if (!Number.isInteger(pullRequest) || pullRequest < 1) return { refuse: "pr: must be a pull request number" };
			}
			if (options.ticket !== undefined && !/^[A-Za-z][A-Za-z0-9]+-\d+$/.test(options.ticket)) return { refuse: "ticket: must be a ticket key like ABC-123" };
			return {
				capability: { id: "code.review", version: "3" },
				input: { repository: { url: target.url, ref: target.ref }, ...(pullRequest ? { pullRequest } : {}), ...(options.ticket ? { ticket: options.ticket } : {}), ...(rest ? { focus: rest.slice(0, 2000) } : {}) },
			};
		},
		describeResult(result) {
			const review = result as { verdict?: unknown; summary?: unknown; findings?: { severity?: unknown }[] };
			if (typeof review?.verdict !== "string") return undefined;
			const counts = new Map<string, number>();
			for (const finding of review.findings ?? []) counts.set(String(finding.severity ?? "?"), (counts.get(String(finding.severity ?? "?")) ?? 0) + 1);
			return [`Review done: ${review.verdict}.`, typeof review.summary === "string" ? review.summary.slice(0, 1500) : "", counts.size > 0 ? `Findings: ${[...counts].map(([severity, n]) => `${n} ${severity}`).join(", ")}.` : "No findings."].filter(Boolean).join("\n");
		},
	};
}

import { Type } from "@earendil-works/pi-ai";
import { repositoryTarget, type JobPlan, type JobTool, type ThreadRoleHooks } from "@somework/agent-kit";

export const CHAT_INSTRUCTIONS = `You are the reviewer agent of this platform. You review a branch or a pull request read-only and return findings by severity; you never push, comment or change anything. You offer the capability code.review.
A review is a job: when someone asks for one, call review_code (a pull request number, a ref, a ticket key, and what to focus on). It runs in the background and its verdict and findings are posted to the conversation when it is done; say what you started, do not wait. Questions about earlier reviews you answer from the state summary and the job_status tool.`;

export function reviewCodeTool(defaults: { url?: string; ref?: string }): JobTool {
	return {
		name: "review_code",
		description: "Review a branch or pull request read-only and report a verdict and findings by severity. Give a pull request number and/or a ref; `ticket` is the ticket key the change is for, `focus` what to look at. `repo`/`ref` choose another repository or revision than the default.",
		parameters: Type.Object({
			pullRequest: Type.Optional(Type.Integer({ minimum: 1 })),
			ticket: Type.Optional(Type.String({ maxLength: 40 })),
			focus: Type.Optional(Type.String({ maxLength: 2000 })),
			repo: Type.Optional(Type.String({ maxLength: 400 })),
			ref: Type.Optional(Type.String({ maxLength: 200 })),
		}),
		plan(args: { pullRequest?: number; ticket?: string; focus?: string; repo?: string; ref?: string }): JobPlan | { refuse: string } {
			const target = repositoryTarget({ ...(args.repo ? { repo: args.repo } : {}), ...(args.ref ? { ref: args.ref } : {}) }, defaults);
			if ("refuse" in target) return target;
			if (args.pullRequest !== undefined && !(Number.isInteger(args.pullRequest) && args.pullRequest >= 1)) return { refuse: "pullRequest must be a pull request number" };
			if (args.ticket !== undefined && !/^[A-Za-z][A-Za-z0-9]+-\d+$/.test(args.ticket)) return { refuse: "ticket must be a ticket key like ABC-123" };
			const focus = args.focus?.trim();
			return {
				capability: { id: "code.review", version: "3" },
				input: { repository: { url: target.url, ref: target.ref }, ...(args.pullRequest ? { pullRequest: args.pullRequest } : {}), ...(args.ticket ? { ticket: args.ticket } : {}), ...(focus ? { focus: focus.slice(0, 2000) } : {}) },
				label: `review ${args.pullRequest ? `PR #${args.pullRequest}` : target.ref}`,
			};
		},
	};
}

/** What the reviewer adds to conversations: the review as a job tool, and the review in words. It stays read-only: the role's own guards refuse every command that is not plain inspection. */
export function reviewerChat(env: NodeJS.ProcessEnv = process.env): ThreadRoleHooks {
	const defaults = { url: env.CHAT_REPOSITORY_URL, ref: env.CHAT_REPOSITORY_REF };
	return {
		instructions: CHAT_INSTRUCTIONS,
		jobTools: [reviewCodeTool(defaults)],
		describeResult(result) {
			const review = result as { verdict?: unknown; summary?: unknown; findings?: { severity?: unknown }[] };
			if (typeof review?.verdict !== "string") return undefined;
			const counts = new Map<string, number>();
			for (const finding of review.findings ?? []) counts.set(String(finding.severity ?? "?"), (counts.get(String(finding.severity ?? "?")) ?? 0) + 1);
			return [`Review done: ${review.verdict}.`, typeof review.summary === "string" ? review.summary.slice(0, 1500) : "", counts.size > 0 ? `Findings: ${[...counts].map(([severity, n]) => `${n} ${severity}`).join(", ")}.` : "No findings."].filter(Boolean).join("\n");
		},
	};
}

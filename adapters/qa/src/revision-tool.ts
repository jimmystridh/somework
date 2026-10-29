import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type Extension } from "@earendil-works/pi-durable";

export const REVISION_TOOL = "qa_use_revision";
export const MAX_COMBINED = 5;

export interface RevisionSwitch {
	/** Merges the refs into the checkout, rebuilds the back end and restarts the application; resolves to what the model is told. Never throws for a conflict or a failed start: those are the answer. */
	use(request: { pullRequests: number[]; commits: string[] }): Promise<{ ok: boolean; text: string }>;
}

/**
 * The agent's way to change what it tests. The harness picks one revision before the model starts; when the ticket needs a front-end and a
 * back-end pull request together, or a commit the checkout does not hold, the model asks for them here. The harness holds the credentials,
 * merges locally (nothing is pushed), rebuilds the back end from the result and restarts the application.
 */
export function createRevisionTool(target: RevisionSwitch): { extension: Extension<any>; toolNames: string[] } {
	const tools = [
		defineTool({
			name: REVISION_TOOL,
			description: `Add pull requests or commits to the revision you are testing. Use it when the ticket needs a change your checkout does not hold: typically the front-end pull request and the back-end pull request of the same ticket. They are merged into your checkout locally (nothing is pushed), the back end is rebuilt from the result and the application is restarted, which can take many minutes when the back end changed. Give pull request numbers of the ticket's repository and/or commit ids (at most ${MAX_COMBINED} together). A conflict leaves your checkout as it was and tells you which pull request clashed: then report blocked and name it. After a successful call re-open the application in the browser (the old pages are gone), take a new snapshot and name every merged pull request in your notes.`,
			parameters: Type.Object({
				pullRequests: Type.Optional(Type.Array(Type.Integer({ minimum: 1, maximum: 999_999_999 }), { maxItems: MAX_COMBINED })),
				commits: Type.Optional(Type.Array(Type.String({ pattern: "^[0-9a-f]{7,40}$" }), { maxItems: MAX_COMBINED })),
			}),
			async execute(args: { pullRequests?: number[]; commits?: string[] }) {
				const pullRequests = args.pullRequests ?? [];
				const commits = args.commits ?? [];
				if (pullRequests.length + commits.length === 0) return { isError: true as const, content: [{ type: "text" as const, text: "give at least one pull request number or commit id" }] };
				if (pullRequests.length + commits.length > MAX_COMBINED) return { isError: true as const, content: [{ type: "text" as const, text: `at most ${MAX_COMBINED} together` }] };
				const answer = await target.use({ pullRequests, commits });
				return { ...(answer.ok ? {} : { isError: true as const }), content: [{ type: "text" as const, text: answer.text }] };
			},
		}),
	];
	return { extension: defineExtension({ name: "qa-revision", tools }), toolNames: tools.map((tool) => tool.name) };
}

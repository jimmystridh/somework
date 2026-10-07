import { readFileSync, statSync } from "node:fs";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type Extension } from "@earendil-works/pi-durable";
import { silent, type AgentProfile, type Log } from "@somework/agent-kit";
import { ConfinementError, nativeFlavour, resolveInside } from "@somework/agent-kit/windows";
import { isDoneStatus, JiraError, previousAssignee, type Comment, type Issue, type JiraClient } from "./jira.ts";
import type { QaJob, QaSession } from "./session.ts";
import type { Verdict } from "./result.ts";

export interface JiraToolsOptions {
	jira: Pick<JiraClient, "getIssue" | "search" | "comments" | "addComment" | "addLabel" | "removeLabel" | "transitions" | "transition" | "assign" | "attach">;
	session: QaSession;
	/** Ticket keys the agent handles. Every key a tool touches must match; writes may only touch the job's own ticket. */
	pattern: RegExp;
	testStatus: string;
	inProgressStatus: string;
	verifiedLabel: string;
	log?: Log;
	/** For tests. */
	readFile?: (path: string) => Buffer;
	fileSize?: (path: string) => number;
}

const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
/** A recording that stalled leaves a file with no frames in it; it is not evidence and must not reach the ticket. */
const MIN_VIDEO_BYTES = 2048;
const MAX_TEXT = 12_000;
const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });
const failure = (value: string) => ({ isError: true as const, content: [{ type: "text" as const, text: value }] });
const clip = (value: string | null | undefined, max: number): string => (value ?? "").slice(0, max);

const CONTENT_TYPES: Record<string, string> = { ".webm": "video/webm", ".png": "image/png" };

/** Why a write is not allowed right now, or undefined. The same checks run in the approval summary and, again, in the tool. */
class Refusal extends Error {}

/**
 * The model's hands in the ticket system. Reads may look at any ticket whose key matches the configured pattern. Writes can only target
 * the ticket of the job (the tools do not even take a key), wait for the requester's approval (the profile's `toolApprovals`), and are
 * limited by rules that live here and not in the prompt:
 *  - the ticket must still be in the expected status and unassigned, re-read right before the write;
 *  - nothing ever moves a ticket into a done status (by status category and by name), only to the configured in-progress status;
 *  - the verified label needs the verdict `verified`, a comment and an attached video from this same job;
 *  - an assignment only restores the previous assignee in a not-fixed hand-back.
 */
export function createJiraTools(options: JiraToolsOptions): { extension: Extension<any>; toolNames: string[] } {
	const log = options.log ?? silent;
	const readFile = options.readFile ?? ((path: string) => readFileSync(path));
	const fileSize = options.fileSize ?? ((path: string) => statSync(path).size);

	const job = (): QaJob => {
		const current = options.session.job;
		if (!current) throw new Refusal("there is no verification in progress");
		return current;
	};
	const readableKey = (key: string | undefined): string => {
		const wanted = key ?? job().ticket;
		if (!options.pattern.test(wanted)) throw new Refusal(`${wanted} is not a ticket this agent handles`);
		return wanted;
	};
	const wrap = async <T>(run: () => Promise<T>): Promise<T | ReturnType<typeof failure>> => {
		try {
			return await run();
		} catch (error) {
			if (error instanceof Refusal) return failure(`refused: ${error.message}`);
			if (error instanceof ConfinementError) return failure(`refused: ${error.message}`);
			if (error instanceof JiraError) return failure(`the ticket system answered with an error: ${error.message}`);
			throw error;
		}
	};

	/** The state a write needs: the job's own ticket, still in the expected status and unassigned. */
	async function writable(changelog = false): Promise<{ current: QaJob; issue: Issue }> {
		const current = job();
		const issue = await options.jira.getIssue(current.ticket, changelog ? "changelog" : undefined);
		const status = issue.fields.status?.name;
		if (status !== options.testStatus) throw new Refusal(`${current.ticket} is in "${status}", not in "${options.testStatus}": it changed while it was being verified, so nothing was written`);
		if (issue.fields.assignee) throw new Refusal(`${current.ticket} is assigned to ${issue.fields.assignee.displayName ?? issue.fields.assignee.name}: it changed while it was being verified, so nothing was written`);
		return { current, issue };
	}

	const describeIssue = (issue: Issue): string => {
		const f = issue.fields;
		const comments = (f.comment?.comments ?? []).slice(-15).map((c: Comment) => `- ${clip(c.author?.displayName ?? c.author?.name, 60)} (${clip(c.created, 25)}): ${clip(c.body, 600)}`);
		return [
			`${issue.key}: ${clip(f.summary, 300)}`,
			`type: ${f.issuetype?.name ?? "?"}; status: ${f.status?.name ?? "?"}; assignee: ${f.assignee ? (f.assignee.displayName ?? f.assignee.name) : "(none)"}`,
			`labels: ${(f.labels ?? []).join(", ") || "(none)"}; components: ${(f.components ?? []).map((c) => c.name).join(", ") || "(none)"}`,
			`attachments: ${(f.attachment ?? []).map((a) => a.filename).join(", ") || "(none)"}`,
			`description:\n${clip(f.description, MAX_TEXT)}`,
			comments.length ? `recent comments:\n${comments.join("\n")}` : "comments: (none)",
		].join("\n");
	};

	const tools = [
		defineTool({
			name: "qa_record_verdict",
			description: "Record your verdict for this verification before you touch the ticket system. The ticket tools check it: the verified label needs `verified`, the hand-back needs `not_fixed`. It changes nothing outside this job.",
			parameters: Type.Object({ verdict: Type.Union([Type.Literal("verified"), Type.Literal("not_fixed"), Type.Literal("blocked")]) }),
			async execute(args: { verdict: Verdict }) {
				const current = job();
				current.verdict = args.verdict;
				return text(`verdict recorded: ${args.verdict}`);
			},
		}),
		defineTool({
			name: "jira_get_issue",
			description: "Read a ticket: summary, status, assignee, labels, components, attachments, description and recent comments. Without a key it reads the ticket under verification.",
			parameters: Type.Object({ key: Type.Optional(Type.String({ maxLength: 40 })) }),
			replay: "safe",
			async execute(args: { key?: string }) {
				return wrap(async () => text(describeIssue(await options.jira.getIssue(readableKey(args.key)))));
			},
		}),
		defineTool({
			name: "jira_search",
			description: "Search tickets with JQL (read only). Returns key, summary, status and assignee of up to 20 matches whose keys this agent handles.",
			parameters: Type.Object({ jql: Type.String({ minLength: 1, maxLength: 1000 }), max: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })) }),
			replay: "safe",
			async execute(args: { jql: string; max?: number }) {
				return wrap(async () => {
					const found = await options.jira.search(args.jql, args.max ?? 20);
					const rows = found.issues.filter((issue) => options.pattern.test(issue.key)).map((issue) => `${issue.key} | ${clip(issue.fields.summary, 120)} | ${issue.fields.status?.name ?? "?"} | ${issue.fields.assignee ? (issue.fields.assignee.displayName ?? issue.fields.assignee.name) : "(unassigned)"}`);
					return text(`${found.total} match(es); showing ${rows.length}\n${rows.join("\n")}`);
				});
			},
		}),
		defineTool({
			name: "jira_changelog",
			description: "The status and assignee history of a ticket, newest first, and who was assigned before it became unassigned. Without a key it reads the ticket under verification.",
			parameters: Type.Object({ key: Type.Optional(Type.String({ maxLength: 40 })) }),
			replay: "safe",
			async execute(args: { key?: string }) {
				return wrap(async () => {
					const issue = await options.jira.getIssue(readableKey(args.key), "changelog");
					const histories = issue.changelog?.histories ?? [];
					const lines = [...histories]
						.sort((a, b) => String(b.created ?? "").localeCompare(String(a.created ?? "")))
						.flatMap((history) => history.items.filter((item) => item.field === "assignee" || item.field === "status").map((item) => `${clip(history.created, 25)} ${item.field}: ${item.fromString ?? "(none)"} -> ${item.toString ?? "(none)"}`))
						.slice(0, 40);
					const before = previousAssignee(histories);
					return text(`${lines.join("\n") || "(no assignee or status changes)"}\nprevious assignee: ${before ? (before.displayName ?? before.name) : "unknown"}`);
				});
			},
		}),
		defineTool({
			name: "jira_get_comments",
			description: "All comments of a ticket (up to 100, each cut at 1500 characters). Without a key it reads the ticket under verification.",
			parameters: Type.Object({ key: Type.Optional(Type.String({ maxLength: 40 })) }),
			replay: "safe",
			async execute(args: { key?: string }) {
				return wrap(async () => {
					const comments = await options.jira.comments(readableKey(args.key));
					return text(comments.map((c) => `- ${clip(c.author?.displayName ?? c.author?.name, 60)} (${clip(c.created, 25)}): ${clip(c.body, 1500)}`).join("\n") || "(no comments)");
				});
			},
		}),
		defineTool({
			name: "jira_attach",
			description: "Attach a file you produced with qa-browser (a .webm video or a .png screenshot, given as the path relative to the evidence folder, for example videos/qa-video-1.webm) to the ticket under verification. Waits for the requester's approval.",
			parameters: Type.Object({ file: Type.String({ minLength: 1, maxLength: 200 }) }),
			async execute(args: { file: string }) {
				return wrap(async () => {
					const { current } = await writable();
					const extension = /\.(webm|png)$/i.exec(args.file)?.[0]?.toLowerCase();
					if (!extension || !/^(videos|screenshots)\//.test(args.file.replaceAll("\\", "/"))) throw new Refusal("only .webm files under videos/ and .png files under screenshots/ of the evidence folder can be attached");
					const absolute = resolveInside(current.evidenceDir, args.file, { flavour: nativeFlavour() });
					let size: number;
					try {
						size = fileSize(absolute);
					} catch {
						throw new Refusal(`there is no file ${args.file} in the evidence folder`);
					}
					if (size > MAX_ATTACHMENT_BYTES) throw new Refusal("that file is larger than 50 MiB");
					if (extension === ".webm" && size < MIN_VIDEO_BYTES) throw new Refusal(`that video is ${size} bytes: the recording produced no frames (the machine was too busy). Record it again with fewer steps in between, or report the result as blocked`);
					if (size === 0) throw new Refusal("that file is empty");
					const name = `${current.ticket}-${args.file.split(/[\\/]/).pop()}`;
					await options.jira.attach(current.ticket, name, readFile(absolute), CONTENT_TYPES[extension]!);
					if (extension === ".webm") current.jira.attachedVideo = true;
					log("info", "jira_write", { taskId: current.taskId, action: "attach", file: args.file });
					return text(`attached ${name} to ${current.ticket}`);
				});
			},
		}),
		defineTool({
			name: "jira_comment",
			description: "Post a comment on the ticket under verification (what you verified, the revision, the fixtures with their keys, the video's file name). Waits for the requester's approval.",
			parameters: Type.Object({ body: Type.String({ minLength: 1, maxLength: 8000 }) }),
			async execute(args: { body: string }) {
				return wrap(async () => {
					const { current } = await writable();
					if (current.verdict === "verified" && !current.jira.attachedVideo) throw new Refusal("a verified comment goes after the attached video: attach the video first (a recording with no frames is refused; then the result is blocked, not verified)");
					const posted = await options.jira.addComment(current.ticket, args.body);
					current.jira.commented = true;
					log("info", "jira_write", { taskId: current.taskId, action: "comment", id: posted.id });
					return text(`comment ${posted.id} posted on ${current.ticket}`);
				});
			},
		}),
		defineTool({
			name: "jira_add_label",
			description: `Add the label ${options.verifiedLabel} to the ticket under verification (the only label this tool adds), keeping its other labels. Allowed only for a recorded verdict \`verified\`, after you attached the video and posted the comment in this verification. Waits for the requester's approval.`,
			parameters: Type.Object({ label: Type.String({ maxLength: 64 }) }),
			async execute(args: { label: string }) {
				return wrap(async () => {
					const { current, issue } = await writable();
					if (args.label !== options.verifiedLabel) throw new Refusal(`the only label this agent adds is ${options.verifiedLabel}`);
					if (current.verdict !== "verified") throw new Refusal(`the label needs a recorded verdict of verified (it is ${current.verdict ?? "not recorded"})`);
					if (!current.jira.attachedVideo) throw new Refusal("attach the video of the verified behaviour first");
					if (!current.jira.commented) throw new Refusal("post the verification comment first");
					if ((issue.fields.labels ?? []).includes(options.verifiedLabel)) return text(`${current.ticket} already has ${options.verifiedLabel}`);
					await options.jira.addLabel(current.ticket, options.verifiedLabel);
					current.jira.labelled = true;
					log("info", "jira_write", { taskId: current.taskId, action: "label", label: options.verifiedLabel });
					return text(`${options.verifiedLabel} added to ${current.ticket}`);
				});
			},
		}),
		defineTool({
			name: "jira_remove_label",
			description: `Remove a stale ${options.verifiedLabel} label from the ticket under verification when you found it NOT fixed (verdict \`not_fixed\`). Waits for the requester's approval.`,
			parameters: Type.Object({ label: Type.String({ maxLength: 64 }) }),
			async execute(args: { label: string }) {
				return wrap(async () => {
					const { current, issue } = await writable();
					if (args.label !== options.verifiedLabel) throw new Refusal(`the only label this agent removes is ${options.verifiedLabel}`);
					if (current.verdict !== "not_fixed") throw new Refusal("a label is removed only for a recorded verdict of not_fixed");
					if (!(issue.fields.labels ?? []).includes(options.verifiedLabel)) return text(`${current.ticket} does not have ${options.verifiedLabel}`);
					await options.jira.removeLabel(current.ticket, options.verifiedLabel);
					log("info", "jira_write", { taskId: current.taskId, action: "remove_label", label: options.verifiedLabel });
					return text(`${options.verifiedLabel} removed from ${current.ticket}`);
				});
			},
		}),
		defineTool({
			name: "jira_transition_to_in_progress_and_reassign",
			description: `The hand-back for a ticket that is NOT fixed (recorded verdict \`not_fixed\`): posts your comment, removes a stale ${options.verifiedLabel} label, moves the ticket to "${options.inProgressStatus}" and gives it back to whoever was assigned before it became unassigned (from its history). If no previous assignee can be found it only comments and leaves the ticket where it is. It can never move a ticket to a done status. Waits for the requester's approval.`,
			parameters: Type.Object({ comment: Type.String({ minLength: 1, maxLength: 8000 }) }),
			async execute(args: { comment: string }) {
				return wrap(async () => {
					const { current, issue } = await writable(true);
					if (current.verdict !== "not_fixed") throw new Refusal("the hand-back is only for a recorded verdict of not_fixed");
					const before = previousAssignee(issue.changelog?.histories);
					const steps: string[] = [];
					const posted = await options.jira.addComment(current.ticket, args.comment);
					current.jira.commented = true;
					steps.push(`commented (${posted.id})`);
					if ((issue.fields.labels ?? []).includes(options.verifiedLabel)) {
						await options.jira.removeLabel(current.ticket, options.verifiedLabel);
						steps.push(`removed ${options.verifiedLabel}`);
					}
					if (!before) return text(`${steps.join("; ")}; no previous assignee could be found in the history, so the ticket stays in "${options.testStatus}" unassigned`);
					const transitions = await options.jira.transitions(current.ticket);
					const target = transitions.find((t) => t.to.name === options.inProgressStatus);
					if (!target) return text(`${steps.join("; ")}; no transition to "${options.inProgressStatus}" is available, so the ticket stays where it is`);
					if (isDoneStatus(target.to)) throw new Refusal(`"${options.inProgressStatus}" is a done status in this workflow: this agent never moves a ticket there`);
					await options.jira.transition(current.ticket, target.id);
					current.jira.transitioned = true;
					steps.push(`moved to "${options.inProgressStatus}"`);
					const after = await options.jira.getIssue(current.ticket);
					if (after.fields.assignee) {
						steps.push(`left the assignment alone (it is now ${after.fields.assignee.displayName ?? after.fields.assignee.name})`);
					} else {
						await options.jira.assign(current.ticket, before.name);
						steps.push(`reassigned to ${before.displayName ?? before.name}`);
					}
					log("info", "jira_write", { taskId: current.taskId, action: "hand_back" });
					return text(steps.join("; "));
				});
			},
		}),
	];

	return { extension: defineExtension({ name: "qa-jira", tools }), toolNames: tools.map((tool) => tool.name) };
}

const flat = (value: unknown, max: number): string => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/**
 * What the requester is shown before each write, built from the call's arguments and the job being verified. These are the tool names the
 * profile lists in `toolApprovals`; every other tool of this role runs without asking.
 */
export function jiraToolApprovals(session: QaSession, verifiedLabel: string, inProgressStatus: string, approve?: readonly string[]): NonNullable<AgentProfile["toolApprovals"]> {
	const ticket = (): string => session.job?.ticket ?? "the ticket under verification";
	const all: NonNullable<AgentProfile["toolApprovals"]> = {
		jira_comment: (args) => `post a comment on ${ticket()} (${String(args.body ?? "").length} characters): "${flat(args.body, 200)}"`,
		jira_attach: (args) => `attach ${flat(args.file, 120)} to ${ticket()}`,
		jira_add_label: (args) => `add the label ${flat(args.label, 64) || verifiedLabel} to ${ticket()}`,
		jira_remove_label: (args) => `remove the label ${flat(args.label, 64) || verifiedLabel} from ${ticket()}`,
		jira_transition_to_in_progress_and_reassign: (args) => `hand ${ticket()} back: comment "${flat(args.comment, 200)}", move it to "${inProgressStatus}" and give it to its previous assignee`,
	};
	// a narrower list lets the other writes run without asking (the verdict's comment, evidence and label); the others still wait
	return approve === undefined ? all : Object.fromEntries(Object.entries(all).filter(([name]) => approve.includes(name)));
}

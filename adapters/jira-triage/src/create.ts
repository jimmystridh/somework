import { evaluate, type ItemId, type Subject } from "./checklist.ts";
import type { JiraUser, SearchHit } from "./jira/client.ts";
import { numbered, oneLine } from "./questions.ts";
import { fingerprintOf } from "./snapshot.ts";
import { newRecord, type TriageStore } from "./store.ts";
import type { TriageSettings } from "./settings.ts";
import { wikiEscape } from "./wiki.ts";
import { silent, type Log } from "@somework/agent-kit";

export interface Draft {
	project?: string;
	type: string;
	summary: string;
	description: string;
	environment?: string;
	components?: string[];
	labels?: string[];
	/** The person asked for the ticket as it is although the checklist found something missing. */
	createAnyway?: boolean;
	/** `slack/<member id>`, as the message that asked for the ticket names its sender. */
	requestedBy: string;
}

export interface CreatePort {
	createIssue(issue: { project: string; type: string; summary: string; description: string; environment?: string; labels?: readonly string[]; components?: readonly string[] }): Promise<{ id: string; key: string }>;
	search(jql: string, maxResults?: number): Promise<{ total: number; issues: SearchHit[] }>;
	user?(name: string): Promise<JiraUser | undefined>;
	browseUrl(key: string): string;
}

export type CreateResult =
	| { ok: true; key: string; url: string; existing?: boolean; advice: string[] }
	| { ok: false; reason: string; missing?: string[]; questions?: string[] };

/** The member of an allowed Slack user as the message names its sender. */
export const REQUESTER = /^slack\/([UW][A-Z0-9]{2,})$/;

const PROJECT_OR_TYPE = /^[A-Za-z][A-Za-z0-9 _-]{0,40}$/;
const LABEL = /^[A-Za-z0-9_.-]{1,50}$/;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

const subjectOf = (draft: Draft): Subject => ({ type: draft.type, summary: draft.summary, description: draft.description, environment: draft.environment ?? "", components: draft.components ?? [], attachments: [] });

/**
 * What a draft lacks. The screenshot is the one item that cannot be asked for in a conversation (the Slack channel reads text only): it is advice, not a
 * reason to hold the ticket back.
 */
export function checkDraft(draft: Draft): { kind: string; missing: { id: ItemId; label: string }[]; advice: { id: ItemId; label: string }[]; complete: boolean } {
	const verdict = evaluate(subjectOf(draft));
	const blocking = verdict.missing.filter((item) => item.id !== "attachment");
	return { kind: verdict.kind, missing: blocking.map(({ id, label }) => ({ id, label })), advice: verdict.missing.filter((item) => item.id === "attachment").map(({ id, label }) => ({ id, label })), complete: blocking.length === 0 };
}

export interface CreateDeps {
	jira: CreatePort;
	settings: TriageSettings;
	store: TriageStore;
	/** A display name for the requester's footer line, when Slack gives one. */
	displayName?: (memberId: string) => Promise<string | undefined>;
	log?: Log;
	now?: () => number;
}

/**
 * Creates a ticket from a draft, at once: nothing is asked of the person here (the model asks before it calls). The ticket gets the marker label, so that the
 * event Jira sends for it is not triaged, and the bot-created label, with a line in the description naming who asked for it. A ticket the same bot created a
 * few minutes ago with the same summary is returned instead of a second one (a retry after a lost answer).
 */
export async function createTicket(deps: CreateDeps, draft: Draft): Promise<CreateResult> {
	const { settings } = deps;
	const log = deps.log ?? silent;
	const now = deps.now ?? Date.now;
	const requester = REQUESTER.exec(draft.requestedBy);
	if (!requester) return { ok: false, reason: "requestedBy must be the sender of the message that asked for the ticket, exactly as it appears there (slack/ and the member id)" };
	if (settings.slackMembers.length > 0 && !settings.slackMembers.includes(requester[1]!)) return { ok: false, reason: `${draft.requestedBy} is not one of the people this agent creates tickets for` };
	const project = (draft.project ?? settings.projects[0]!).toUpperCase();
	if (!settings.projects.includes(project)) return { ok: false, reason: `tickets are created only in ${settings.projects.join(", ")}, not in ${oneLine(project, 20)}` };
	if (!PROJECT_OR_TYPE.test(draft.type)) return { ok: false, reason: "the issue type is not valid" };
	const type = settings.createTypes.find((allowed) => allowed.toLowerCase() === draft.type.trim().toLowerCase());
	if (!type) return { ok: false, reason: `the issue type must be one of ${settings.createTypes.join(", ")}` };
	const summary = oneLine(draft.summary, 200);
	if (summary.length < 10) return { ok: false, reason: "the summary must say what the ticket is about (at least 10 characters)" };
	const body = draft.description.replace(CONTROL, " ").trim();
	if (body.length < 20) return { ok: false, reason: "the description must hold what the person said (at least 20 characters)" };
	if (body.length > 20_000) return { ok: false, reason: "the description is longer than 20000 characters" };
	const environment = draft.environment ? wikiEscape(oneLine(draft.environment, 255)) : undefined;
	const checked = checkDraft({ ...draft, type, summary, description: body, ...(environment ? { environment } : {}) });
	if (!checked.complete && draft.createAnyway !== true) {
		return { ok: false, reason: `the ticket is missing ${checked.missing.map((item) => item.label).join("; ")}: ask the person for exactly that, then check and create again (or create it as it is if they say so)`, missing: checked.missing.map((item) => item.id), questions: numbered(settings.language, checked.missing.map((item) => item.id)) };
	}
	const recent = await deps.jira.search(`project = ${project} AND labels = "${settings.botCreatedLabel}" AND created >= -15m ORDER BY created DESC`, 20);
	const same = recent.issues.find((hit) => oneLine(hit.fields.summary ?? "", 200) === summary);
	if (same) return { ok: true, key: same.key, url: deps.jira.browseUrl(same.key), existing: true, advice: [] };

	const name = (await deps.displayName?.(requester[1]!).catch(() => undefined)) ?? requester[1]!;
	const notes = [
		`_Created from Slack by the Jira triage assistant at the request of ${wikiEscape(oneLine(name, 60))} (${requester[1]}), ${new Date(now()).toISOString().slice(0, 10)}._`,
		...(!checked.complete ? [`_Created as it was, although it still lacked: ${checked.missing.map((item) => wikiEscape(item.label)).join("; ")}._`] : []),
		...checked.advice.map((item) => `_Still wanted: ${wikiEscape(item.label)}. Attach it to this ticket._`),
	];
	const description = `${wikiEscape(body)}\n\n----\n${notes.join("\n")}`;
	const labels = [...new Set([settings.markerLabel, settings.botCreatedLabel, ...(draft.labels ?? []).filter((label) => LABEL.test(label) && label !== settings.needsInfoLabel)])];
	const created = await deps.jira.createIssue({ project, type, summary, description, ...(environment ? { environment } : {}), labels, ...(draft.components && draft.components.length > 0 ? { components: draft.components.filter((component) => PROJECT_OR_TYPE.test(component)).slice(0, 5) } : {}) });
	log("info", "jira_ticket_created", { ticket: created.key, project, type, requestedBy: draft.requestedBy, complete: checked.complete });
	const stamp = now();
	deps.store.put({ ...newRecord(created.key, "slack", stamp), phase: "done", doneAt: stamp, nextAttemptAt: undefined, createdFor: draft.requestedBy, summary: `created from Slack for ${draft.requestedBy}`, baseline: fingerprintOf({ type, summary, description, environment: environment ?? "", attachmentIds: [] }) }, stamp);
	return { ok: true, key: created.key, url: deps.jira.browseUrl(created.key), advice: checked.advice.map((item) => item.label) };
}

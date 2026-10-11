import { createHash } from "node:crypto";
import type { Subject } from "./checklist.ts";
import type { Issue, JiraUser } from "./jira/client.ts";
import { stripNotes } from "./wiki.ts";

/** A ticket as the triage sees it: what the checklist judges, who reported it and which labels it carries. */
export interface Snapshot extends Subject {
	key: string;
	project: string;
	labels: string[];
	reporter?: { name: string; displayName?: string; email?: string; active: boolean };
	attachmentIds: string[];
	/** The description exactly as Jira holds it, including the bot's own section. */
	rawDescription: string;
}

export const projectOf = (key: string): string => key.split("-")[0] ?? "";

const reporterOf = (user: JiraUser | null | undefined): Snapshot["reporter"] =>
	user?.name ? { name: user.name, ...(user.displayName ? { displayName: user.displayName } : {}), ...(user.emailAddress ? { email: user.emailAddress } : {}), active: user.active !== false } : undefined;

export function snapshotOf(issue: Issue): Snapshot {
	const raw = typeof issue.fields.description === "string" ? issue.fields.description : "";
	const attachments = issue.fields.attachment ?? [];
	const reporter = reporterOf(issue.fields.reporter);
	return {
		key: issue.key,
		project: issue.fields.project?.key ?? projectOf(issue.key),
		type: issue.fields.issuetype?.name ?? "",
		summary: issue.fields.summary ?? "",
		description: stripNotes(raw),
		rawDescription: raw,
		environment: typeof issue.fields.environment === "string" ? issue.fields.environment : "",
		components: (issue.fields.components ?? []).map((component) => component.name),
		labels: issue.fields.labels ?? [],
		attachments: attachments.map((file) => ({ filename: file.filename, ...(file.mimeType ? { mimeType: file.mimeType } : {}) })),
		attachmentIds: attachments.map((file) => file.id),
		...(reporter ? { reporter } : {}),
	};
}

/**
 * What a person may change that makes a triage worth doing again: the type, the summary, the description (without the bot's own section), the
 * environment and the attachments. Labels and comments are not in it, so the bot's own writes and a person's label edits never count.
 */
export interface Fingerprint {
	type: string;
	summary: string;
	description: string;
	environment: string;
	attachments: string;
}

const digest = (value: string): string => createHash("sha256").update(value.trim().replace(/\s+/g, " ")).digest("hex").slice(0, 16);

export function fingerprintOf(snapshot: Pick<Snapshot, "type" | "summary" | "description" | "environment" | "attachmentIds">): Fingerprint {
	return { type: snapshot.type, summary: digest(snapshot.summary), description: digest(snapshot.description), environment: digest(snapshot.environment), attachments: digest([...snapshot.attachmentIds].sort().join(",")) };
}

/** The checklist fields that differ between what the bot last saw (including what it wrote itself) and the ticket now. */
export function changedSince(before: Fingerprint, now: Fingerprint): (keyof Fingerprint)[] {
	return (Object.keys(now) as (keyof Fingerprint)[]).filter((field) => before[field] !== now[field]);
}

/** The field names the hub's `jira.issue.updated` event carries (Jira's own display names) that a checklist reads. */
const COVERED_BY_EVENT = /^(summary|description|environment|attachment|issuetype|issue type|type)$/i;

export const coversChecklist = (changed: readonly string[]): boolean => changed.some((field) => COVERED_BY_EVENT.test(field.trim()));

/**
 * Which revision holds the fix. A ticket in Test often has its change in a pull request that is not merged yet: the ticket's comments then
 * name it (the preview environment's address, a pull request link or "PR #123"). Testing the default branch finds the old behaviour and would
 * wrongly hand the ticket back.
 */
const PULL_REQUEST_MENTIONS: RegExp[] = [/preview-pr-(\d+)\b/gi, /\/pull\/(\d+)\b/gi, /\bPR\s*#?\s*(\d+)\b/gi, /\bpull request\s*#\s*(\d+)\b/gi];
const NOT_MERGED = /\b(inte|ej)\s+merge[a-z:]*|not\s+(yet\s+)?merged|unmerged|not in (stage|test)/i;

/** The pull request the text names last (the text is in the order of the ticket: description first, then the comments oldest to newest). */
export function pullRequestInText(text: string): number | undefined {
	let latest: { at: number; number: number } | undefined;
	for (const pattern of PULL_REQUEST_MENTIONS) {
		for (const match of text.matchAll(pattern)) {
			const at = match.index ?? 0;
			if (!latest || at >= latest.at) latest = { at, number: Number(match[1]) };
		}
	}
	return latest && latest.number > 0 ? latest.number : undefined;
}

/** True when the ticket says its fix has not been merged. */
export const saysNotMerged = (text: string): boolean => NOT_MERGED.test(text);

/** Every pull request the text names, once each, in the order they are first named. */
export function pullRequestsInText(text: string): number[] {
	const seen: { at: number; number: number }[] = [];
	for (const pattern of PULL_REQUEST_MENTIONS) {
		for (const match of text.matchAll(pattern)) {
			const number = Number(match[1]);
			if (number > 0) seen.push({ at: match.index ?? 0, number });
		}
	}
	seen.sort((a, b) => a.at - b.at);
	return [...new Set(seen.map((entry) => entry.number))];
}

export interface RevisionPull {
	number: number;
	title: string;
	body: string;
	state: "open" | "closed";
	merged: boolean;
	headRef: string;
	baseRef: string;
	updatedAt: string;
	mergedAt?: string;
}

export type RevisionChoice =
	/** The checkout moves to `ref`; `note` says why in words and goes to the brief and the result. */
	| { ref: string; pullRequest?: number; source: "linked" | "mentioned" | "merged"; note: string }
	/** Every pull request the ticket names belongs to another ticket, so there is nothing to verify this ticket against. */
	| { none: string };

const KEYS = /\b[A-Z][A-Z0-9]+-\d+\b/g;
const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** How a pull request relates to a ticket: it names the ticket (linked), only other tickets (foreign), or no ticket at all (neutral). */
export function relation(pull: Pick<RevisionPull, "title" | "body" | "headRef">, ticket: string): "linked" | "foreign" | "neutral" {
	const text = `${pull.title}\n${pull.body}\n${pull.headRef}`;
	if (new RegExp(`(^|[^A-Za-z0-9])${escape(ticket)}(?![0-9])`, "i").test(text)) return "linked";
	return (text.match(KEYS) ?? []).some((key) => key.toUpperCase() !== ticket.toUpperCase()) ? "foreign" : "neutral";
}

const newest = (pulls: RevisionPull[]): RevisionPull | undefined => [...pulls].sort((a, b) => (b.mergedAt ?? b.updatedAt).localeCompare(a.mergedAt ?? a.updatedAt))[0];

/**
 * The revision that holds the fix for `ticket`. A pull request that names the ticket wins over one the text merely mentions, and a pull
 * request written for another ticket is never taken (the backend change a front-end ticket depends on is named in its text, and testing it
 * proves nothing about the front end). A merged pull request's head is a stale snapshot: its target branch holds the merged result.
 * `found` are the pull requests that name the ticket, `mentioned` the ones the ticket text names, in the order of the text.
 */
export function chooseRevision(ticket: string, found: readonly RevisionPull[], mentioned: readonly RevisionPull[]): RevisionChoice | undefined {
	const all = new Map<number, RevisionPull>();
	for (const pull of [...found, ...mentioned]) all.set(pull.number, pull);
	const withRelation = [...all.values()].map((pull) => ({ pull, relation: relation(pull, ticket) }));
	const of = (kind: "linked" | "neutral") => withRelation.filter((entry) => entry.relation === kind).map((entry) => entry.pull);

	const open = (pulls: RevisionPull[]) => pulls.filter((pull) => pull.state === "open" && !pull.merged);
	const merged = (pulls: RevisionPull[]) => pulls.filter((pull) => pull.merged && pull.baseRef !== "");
	const linkedOpen = newest(open(of("linked")));
	if (linkedOpen) return { ref: `refs/pull/${linkedOpen.number}/head`, pullRequest: linkedOpen.number, source: "linked", note: `pull request #${linkedOpen.number} (it names ${ticket})` };
	const linkedMerged = newest(merged(of("linked")));
	if (linkedMerged) return { ref: linkedMerged.baseRef, pullRequest: linkedMerged.number, source: "merged", note: `${linkedMerged.baseRef} (pull request #${linkedMerged.number}, which names ${ticket}, is merged)` };

	const neutral = of("neutral");
	const order = new Map(mentioned.map((pull, index) => [pull.number, index]));
	const lastMentioned = (pulls: RevisionPull[]) => [...pulls].sort((a, b) => (order.get(b.number) ?? -1) - (order.get(a.number) ?? -1))[0];
	const neutralOpen = lastMentioned(open(neutral));
	if (neutralOpen) return { ref: `refs/pull/${neutralOpen.number}/head`, pullRequest: neutralOpen.number, source: "mentioned", note: `pull request #${neutralOpen.number} (named in the ticket; it names no ticket itself)` };
	const neutralMerged = lastMentioned(merged(neutral));
	if (neutralMerged) return { ref: neutralMerged.baseRef, pullRequest: neutralMerged.number, source: "mentioned", note: `${neutralMerged.baseRef} (pull request #${neutralMerged.number}, named in the ticket, is merged)` };

	const foreign = withRelation.filter((entry) => entry.relation === "foreign" && mentioned.some((pull) => pull.number === entry.pull.number)).map((entry) => entry.pull);
	if (foreign.length > 0) {
		const others = [...new Set(foreign.flatMap((pull) => (`${pull.title}\n${pull.body}\n${pull.headRef}`.match(KEYS) ?? []).filter((key) => key.toUpperCase() !== ticket.toUpperCase())))].slice(0, 4);
		return { none: `the pull request${foreign.length > 1 ? "s" : ""} this ticket names (${foreign.map((pull) => `#${pull.number}`).join(", ")}) belong${foreign.length > 1 ? "" : "s"} to ${others.join(", ") || "other tickets"}, not to ${ticket}, and no pull request names ${ticket}: there is no revision of its own change to verify` };
	}
	return undefined;
}

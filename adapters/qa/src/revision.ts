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

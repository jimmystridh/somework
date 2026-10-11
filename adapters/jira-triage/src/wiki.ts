import { createHash } from "node:crypto";

export const NOTES_BEGIN = "{anchor:triage-notes-begin}";
export const NOTES_END = "{anchor:triage-notes-end}";
export const NOTES_TITLE = "h4. Triage notes (added by the triage bot, not by the reporter)";
export const MAX_NOTES_CHARS = 6000;

const NOTES_BLOCK = /\{anchor:triage-notes-begin\}[\s\S]*?\{anchor:triage-notes-end\}/;
const NOTES_WITH_SEPARATOR = /(?:\n\n)?\{anchor:triage-notes-begin\}[\s\S]*?\{anchor:triage-notes-end\}\n?/;

/** Jira renders what it reads as wiki markup: text from a person or an agent must not be able to open a macro, a link or a mention in the bot's own text. */
export function wikiEscape(text: string): string {
	return text.replace(/\r\n?/g, "\n").replace(/[{}[\]|]/g, (character) => `\\${character}`);
}

const shortHash = (value: string): string => createHash("sha256").update(value).digest("hex").slice(0, 10);

export interface NotesEntry {
	title: string;
	text: string;
}

/** The anchor that makes an entry recognisable, so that writing the same entry twice (a retry) adds nothing. */
export const entryToken = (entry: NotesEntry): string => `tn-${shortHash(`${entry.title}\u0000${entry.text}`)}`;

/** The description as the reporter wrote it: the bot's section, with the blank line before it, is taken out and nothing else is touched. */
export function stripNotes(description: string): string {
	return description.replace(NOTES_WITH_SEPARATOR, "");
}

export function readNotes(description: string): string | undefined {
	const block = NOTES_BLOCK.exec(description)?.[0];
	if (!block) return undefined;
	return block.slice(NOTES_BEGIN.length, block.length - NOTES_END.length).replace(NOTES_TITLE, "").trim();
}

export const hasEntry = (description: string, entry: NotesEntry): boolean => description.includes(`{anchor:${entryToken(entry)}}`);

/** The reporter's text, then the bot's marked section with the new entry appended; older entries are dropped from the front when the section grows too long. */
export function withNotes(description: string, entry: NotesEntry, now: Date, limit = MAX_NOTES_CHARS): string {
	if (hasEntry(description, entry)) return description;
	const base = stripNotes(description);
	const existing = readNotes(description);
	const stamp = now.toISOString().slice(0, 16).replace("T", " ");
	const added = `{anchor:${entryToken(entry)}}*${wikiEscape(entry.title)}* (${stamp} UTC)\n${wikiEscape(entry.text).trim()}`;
	let entries = [...(existing ? existing.split(/\n{2,}(?=\{anchor:tn-)/) : []), added];
	while (entries.length > 1 && entries.join("\n\n").length > limit) entries = entries.slice(1);
	const body = entries.join("\n\n");
	const block = [NOTES_BEGIN, NOTES_TITLE, body.length > limit ? `${body.slice(0, limit)}\n[shortened]` : body, NOTES_END].join("\n");
	return base.trim() === "" ? block : `${base}\n\n${block}`;
}

/** The bot's comments start with an anchor: the hub's event carries the start of the text, so a comment of the bot is recognised in the event itself. */
export const COMMENT_ANCHOR = /^\s*\{anchor:tb-([a-z0-9-]{4,60})\}/;

export const commentToken = (ticket: string, kind: string, round: number): string => `${ticket.toLowerCase()}-${kind}-${round}`;

export const botComment = (token: string, body: string): string => `{anchor:tb-${token}}\n${body}`;

export const isBotComment = (body: string): boolean => COMMENT_ANCHOR.test(body);

export const tokenOfComment = (body: string): string | undefined => COMMENT_ANCHOR.exec(body)?.[1];

/** A Jira user name as a mention that is safe to put into markup. */
export const mention = (name: string): string => (/^[A-Za-z0-9._@-]{1,100}$/.test(name) ? `[~${name}]` : "");

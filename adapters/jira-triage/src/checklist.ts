export type IssueKind = "bug" | "story" | "other";

export type ItemId = "reproduction-steps" | "expected-actual" | "environment-version" | "affected-customer" | "attachment" | "goal" | "acceptance-criteria" | "summary" | "description";

/** What a ticket is judged on, in the words of the questions asked of the reporter. */
export interface Subject {
	type: string;
	summary: string;
	/** The reporter's own description, without the section the bot keeps itself. */
	description: string;
	environment: string;
	components: string[];
	attachments: { filename: string; mimeType?: string }[];
}

/** What came in after the ticket was written: the reporter's answers and what the developer agent determined. */
export interface Evidence {
	replies: string[];
	findings: Record<string, string>;
}

export interface ItemDefinition {
	id: ItemId;
	label: string;
	/** A developer can often say something useful about it from the code, so a missing one starts an investigation. */
	technical: boolean;
	/** The developer agent may close the item with an explicit finding; the reporter's own facts (version, customer) can only come from the reporter. */
	resolvableByDeveloper: boolean;
	applies(subject: Subject, text: string): boolean;
	satisfied(subject: Subject, text: string): boolean;
}

export type ItemStatus = "ok" | "missing" | "not_applicable";

export interface ItemResult {
	id: ItemId;
	label: string;
	technical: boolean;
	status: ItemStatus;
	resolvedBy?: "developer";
}

export interface Evaluation {
	kind: IssueKind;
	items: ItemResult[];
	missing: ItemResult[];
	complete: boolean;
}

const BUG_TYPES = /^(bug|bugg|defect|fel|incident|problem|regression)$/i;
const STORY_TYPES = /^(story|user story|task|sub-task|subtask|improvement|new feature|feature|förbättring|uppgift|deluppgift|berättelse|ny funktion)$/i;

/** Which checklist a ticket gets from its issue type. Anything not recognised gets the minimal one. */
export function issueKind(type: string): IssueKind {
	const name = type.trim();
	if (BUG_TYPES.test(name)) return "bug";
	if (STORY_TYPES.test(name)) return "story";
	return "other";
}

const has = (text: string, pattern: RegExp): boolean => pattern.test(text);
const count = (text: string, pattern: RegExp): number => (text.match(pattern) ?? []).length;

const LIST_LINE = /^[ \t]*(?:\d+[.)]|[-*#]+)[ \t]+\S/gm;
const STEP_KEYWORD = /(steps? to reproduce|how to reproduce|reproduc|repro steps|steps:|återskap|så här gör|gör så här|stegen|steg \d)/i;
const ACTION_VERB = /\b(?:open|click|select|choose|press|enter|type|navigate|create|add|save|run|start|export|import)(?:s|es|ed|ing)?\b|\b(?:go(?:es)?|log(?:s)?) (?:to|in)\b|\b(?:öppna|klicka|välj|tryck|ange|skriv|skapa|spara|kör|starta|bokför|fakturera|exportera|importera)(?:r|de|t)?\b|\bgå till\b|\bgår till\b|\blogga in\b|\bloggar in\b|\blägg(?:er)? till\b/gi;

const EXPECTED = /\b(expected|expect|should|supposed to|ought to|must)\b|förväntad|förväntat|förvänta|borde|\bska\b|skulle/i;
const ACTUAL = /\b(actual|actually|instead|happens|but|however|results? in|error|fail(?:s|ed|ing)?|wrong|incorrect|crash(?:es|ed)?|nothing|missing|does ?n[o']t|doesn't|won't|cannot|can't)\b|faktiskt|istället|\bmen\b|fungerar inte|fel\b|kraschar|felaktig|händer|saknas|\binte\b/i;

const VERSION = /\b(?:v|ver\.?|version|build|release|versioner?)\s*[:#]?\s*\d|\b\d{4}\.\d{1,2}(?:\.\d+)*\b|\b\d+\.\d+\.\d+\b/i;
const ENVIRONMENT_WORD = /\b(environment|miljö|staging|stage|prod|production|produktion|testmiljö|test environment|browser|webbläsare|chrome|edge|firefox|safari|windows|macos|linux|ios|android|desktop|web ?app)\b/i;

const CUSTOMER_WORD = /\b(customers?|clients?|compan(?:y|ies)|tenant|organi[sz]ation|kund(?:er)?|bolag(?:et)?|företag(?:et)?|organisationsnummer|org\.? ?(?:nr|no|number))\b|\b\d{6}-?\d{4}\b/i;

const UI_WORD = /\b(screens?|screenshots?|buttons?|dialog(?:ue)?s?|windows?|pages?|ui|gui|forms?|dropdowns?|menus?|layouts?|icons?|modal|checkbox|tooltip|grid)\b|fönster|knapp|skärm|dialogruta|ikon|\bvy\b|meny|flik|visas|syns/i;
const UI_COMPONENT = /(^|[\s_-])(ui|gui|frontend|front-end|web|client|klient)($|[\s_-])/i;
const MEDIA_LINK = /!\S+\.(?:png|jpe?g|gif|webp|bmp|mp4|webm|mov)(?:\|[^!]*)?!|\[\^[^\]]+\]|https?:\/\/\S+\.(?:png|jpe?g|gif|webp|bmp|mp4|webm|mov)\b/i;
const MEDIA_FILE = /\.(png|jpe?g|gif|webp|bmp|mp4|webm|mov|pdf)$/i;

const GOAL = /\b(so that|in order to|because|goal|purpose|why|reason|benefit|motivation|as an? [^.\n]{1,60}\bi (?:want|need|would like))\b|syfte|\bmål\b|eftersom|för att|anledning|behov|nytta|som [^.\n]{1,60}vill (?:jag|vi)/i;
const ACCEPTANCE = /(acceptance criteria|acceptance|\bAC\b\s*[:\-]|definition of done|done when|\bdone\b\s*[:\-]|must be able to|should be able to|acceptanskriterier|acceptans|klart när|ska kunna|krav\s*:)/i;
const GIVEN_WHEN_THEN = /\bgiven\b[\s\S]*\bwhen\b[\s\S]*\bthen\b/i;

function hasSteps(text: string): boolean {
	if (count(text, LIST_LINE) >= 2) return true;
	if (STEP_KEYWORD.test(text)) {
		const after = text.slice(text.search(STEP_KEYWORD));
		const content = after.split("\n").slice(0, 4).join(" ").replace(STEP_KEYWORD, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
		if (content.length >= 25) return true;
	}
	return count(text, ACTION_VERB) >= 2;
}

const plainText = (subject: Subject, evidence: readonly string[]): string => [subject.summary, subject.description, subject.environment, ...evidence].join("\n");
const longEnough = (value: string, min: number): boolean => value.replace(/\s+/g, " ").trim().length >= min;

function isUserInterface(subject: Subject, text: string): boolean {
	return UI_WORD.test(text) || subject.components.some((name) => UI_COMPONENT.test(name));
}

function hasMedia(subject: Subject, text: string): boolean {
	return subject.attachments.some((file) => MEDIA_FILE.test(file.filename) || /^(image|video)\//i.test(file.mimeType ?? "")) || MEDIA_LINK.test(text);
}

const always = (): boolean => true;

const REPRODUCTION: ItemDefinition = { id: "reproduction-steps", label: "steps to reproduce", technical: true, resolvableByDeveloper: true, applies: always, satisfied: (_subject, text) => hasSteps(text) };
const EXPECTED_ACTUAL: ItemDefinition = { id: "expected-actual", label: "expected versus actual result", technical: false, resolvableByDeveloper: false, applies: always, satisfied: (_subject, text) => has(text, EXPECTED) && has(text, ACTUAL) };
const ENVIRONMENT: ItemDefinition = {
	id: "environment-version",
	label: "environment and version",
	technical: true,
	resolvableByDeveloper: false,
	applies: always,
	satisfied: (subject, text) => longEnough(subject.environment, 3) || has(text, VERSION) || has(text, ENVIRONMENT_WORD),
};
const CUSTOMER: ItemDefinition = { id: "affected-customer", label: "affected company or customer", technical: false, resolvableByDeveloper: false, applies: always, satisfied: (_subject, text) => has(text, CUSTOMER_WORD) };
const ATTACHMENT: ItemDefinition = { id: "attachment", label: "screenshot or attachment", technical: false, resolvableByDeveloper: false, applies: (subject, text) => isUserInterface(subject, text), satisfied: (subject, text) => hasMedia(subject, text) };
const GOAL_ITEM: ItemDefinition = { id: "goal", label: "why this is wanted (the goal)", technical: false, resolvableByDeveloper: false, applies: always, satisfied: (_subject, text) => has(text, GOAL) };
const CRITERIA: ItemDefinition = { id: "acceptance-criteria", label: "acceptance criteria", technical: false, resolvableByDeveloper: false, applies: always, satisfied: (subject, text) => has(text, ACCEPTANCE) || has(text, GIVEN_WHEN_THEN) || count(subject.description, LIST_LINE) >= 3 };
const SUMMARY: ItemDefinition = { id: "summary", label: "a summary that says what it is about", technical: false, resolvableByDeveloper: false, applies: always, satisfied: (subject) => longEnough(subject.summary, 10) && subject.summary.trim().split(/\s+/).length >= 2 };
const DESCRIPTION: ItemDefinition = { id: "description", label: "a description", technical: false, resolvableByDeveloper: false, applies: always, satisfied: (subject) => longEnough(subject.description, 20) };

/** The hard-coded checklists. The model never edits them: the verdict of a triage comes from here. */
export const CHECKLISTS: Record<IssueKind, readonly ItemDefinition[]> = {
	bug: [REPRODUCTION, EXPECTED_ACTUAL, ENVIRONMENT, CUSTOMER, ATTACHMENT],
	story: [GOAL_ITEM, CRITERIA],
	other: [SUMMARY, DESCRIPTION],
};

export const ITEM_IDS: readonly ItemId[] = [...new Set(Object.values(CHECKLISTS).flatMap((items) => items.map((item) => item.id)))];

/** The verdict: which items of the checklist for the ticket's type are met, missing or beside the point. */
export function evaluate(subject: Subject, evidence: Evidence = { replies: [], findings: {} }): Evaluation {
	const kind = issueKind(subject.type);
	const text = plainText(subject, evidence.replies);
	const items: ItemResult[] = CHECKLISTS[kind].map((item) => {
		const base = { id: item.id, label: item.label, technical: item.technical };
		if (!item.applies(subject, text)) return { ...base, status: "not_applicable" as const };
		if (item.satisfied(subject, text)) return { ...base, status: "ok" as const };
		const finding = evidence.findings[item.id];
		if (item.resolvableByDeveloper && typeof finding === "string" && finding.trim().length >= 10) return { ...base, status: "ok" as const, resolvedBy: "developer" as const };
		return { ...base, status: "missing" as const };
	});
	const missing = items.filter((item) => item.status === "missing");
	return { kind, items, missing, complete: missing.length === 0 };
}

export function definitionOf(id: string): ItemDefinition | undefined {
	return Object.values(CHECKLISTS).flat().find((item) => item.id === id);
}

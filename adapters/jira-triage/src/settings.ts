import { existsSync, readFileSync } from "node:fs";
import { LANGUAGES, type Language } from "./questions.ts";

export type TriageMode = "labels" | "checklist";

export interface JiraSettings {
	url: string;
	/** The personal access token and the client certificate (PKCS#12) the host demands, with its password: files, never values in the environment. */
	tokenFile: string;
	pfxFile?: string;
	pfxPasswordFile?: string;
	/** A private CA that signed the host's certificate, when the platform trust store does not know it. */
	caFile?: string;
}

export interface TriageSettings {
	jira: JiraSettings;
	/** Project keys this agent triages and creates tickets in; events of other projects are ignored. */
	projects: string[];
	/** Set on every ticket the bot triaged or created: the loop protection. A ticket that carries it is not triaged again. */
	markerLabel: string;
	/** Set while the reporter is being asked, taken away when the triage ends. */
	needsInfoLabel: string;
	/** Set, with the marker, on a ticket created from a Slack conversation, so that its creator can see it was made by the bot. */
	botCreatedLabel: string;
	language: Language;
	/** `labels`: the one thing the agent does is check the ticket's area labels with the developer agent. `checklist`: the checklist triage that asks the reporter. */
	mode: TriageMode;
	/** How long a new ticket is left alone after its last edit before it is looked at, and the most a run of edits can postpone it (counted from creation). */
	quietMs: number;
	quietMaxMs: number;
	/** The area labels a ticket may carry, in any combination, spelled as Jira holds them. */
	areaLabels: string[];
	enrichment: boolean;
	developerAgent: string;
	developerWaitMs: number;
	developerPollMs: number;
	reporterWaitMs: number;
	reporterPollMs: number;
	maxRounds: number;
	retrySchedule: number[];
	maxAttempts: number;
	dryRun: boolean;
	/** The Jira user name of the token's owner when it is a service account: an update made by it is the bot's own echo and the handler drops it. Empty when the token is a person's. */
	botUser?: string;
	/** Issue types a ticket may be created as from a conversation. */
	createTypes: string[];
	/** Tickets per day the shipped handler starts a job for; a flood guard (the work is cheap, there is no model run in it). */
	dailyCap: number;
	/** Who tickets from Slack are created for: the member ids the Slack channel serves. */
	slackMembers: string[];
	notifyTo: string;
	/** How often the queue is looked at for retries, answers and deadlines. */
	tickMs: number;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const list = (value: string | undefined): string[] => (value ?? "").split(/[\s,;]+/).map((item) => item.trim()).filter(Boolean);

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
	const raw = env[name];
	if (raw === undefined || raw === "") return fallback;
	const value = Number(raw);
	if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
	if (value > max) throw new Error(`${name} must be at most ${max}`);
	return value;
}

/** Like `integer`, but 0 is allowed (no quiet time). */
function minutes(env: NodeJS.ProcessEnv, name: string, fallback: number, max: number): number {
	const raw = env[name];
	if (raw === undefined || raw === "") return fallback;
	const value = Number(raw);
	if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a whole number of minutes, 0 or more`);
	if (value > max) throw new Error(`${name} must be at most ${max}`);
	return value;
}

const flag = (env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean => (env[name] === undefined || env[name] === "" ? fallback : env[name] === "1" || env[name]?.toLowerCase() === "true");

const PROJECT = /^[A-Z][A-Z0-9_]{1,9}$/;
const LABEL = /^[A-Za-z0-9_.-]{1,50}$/;

function label(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
	const value = (env[name] || fallback).trim();
	if (!LABEL.test(value)) throw new Error(`${name} must be a Jira label: letters, digits, dot, dash and underscore, no spaces`);
	return value;
}

/** The pauses between failed passes, in minutes, as the deployment wrote them (`2,5,15`). */
function schedule(raw: string | undefined): number[] {
	const minutes = list(raw ?? "2,5,15,30,60,120,240,480").map(Number);
	if (minutes.length === 0 || minutes.some((value) => !Number.isFinite(value) || value <= 0 || value > 24 * 60)) throw new Error("TRIAGE_RETRY_MINUTES must be positive numbers of minutes separated by commas, none above 1440");
	return minutes.map((value) => Math.round(value * MINUTE));
}

/**
 * The role's settings from the environment, checked at startup:
 *   JIRA_URL, JIRA_TOKEN_FILE, JIRA_PFX_FILE, JIRA_PFX_PASSWORD_FILE, JIRA_CA_FILE   the ticket system (the same names the QA role uses)
 *   JIRA_PROJECTS                                       project keys, comma separated (default SAD); events of any other project are ignored
 *   JIRA_TRIAGE_LABEL, JIRA_NEEDS_INFO_LABEL, JIRA_BOT_CREATED_LABEL    labels (defaults triaged-by-bot, needs-info, created-by-bot)
 *   JIRA_BOT_USER                                       the user name of the token's owner when that is a service account: its updates are the bot's own echo and are dropped by the handler
 *   TRIAGE_MODE (labels | checklist, default labels), TRIAGE_QUIET_MINUTES (10), TRIAGE_QUIET_MAX_MINUTES (60), TRIAGE_AREA_LABELS (Backend,Frontend,Infrastructure,Security)
 *   TRIAGE_LANGUAGE (en | sv), TRIAGE_ENRICH (default 1), TRIAGE_DEVELOPER_AGENT (default agent/pi-agent), TRIAGE_DEVELOPER_WAIT_MINUTES (10)
 *   TRIAGE_REPORTER_WAIT_HOURS (48), TRIAGE_REPORTER_POLL_MINUTES (5), TRIAGE_MAX_ROUNDS (2), TRIAGE_RETRY_MINUTES, TRIAGE_MAX_ATTEMPTS (12)
 *   TRIAGE_TICK_SECONDS (15), TRIAGE_DEVELOPER_POLL_SECONDS (20)   how often the queue is looked at, and the developer agent's answer is looked for
 *   TRIAGE_DRY_RUN=1                                    decide and record only: nothing is written to Jira, nobody is messaged or asked
 *   TRIAGE_CREATE_TYPES, TRIAGE_DAILY_CAP, SLACK_ALLOWED_USER_IDS, EVENTS_NOTIFY_TO
 */
export function loadSettings(env: NodeJS.ProcessEnv = process.env, exists: (path: string) => boolean = existsSync): TriageSettings {
	const url = env.JIRA_URL?.trim().replace(/\/+$/, "");
	if (!url) throw new Error("JIRA_URL is required");
	if (!/^https:\/\/[^\s/]+(?:\/[^\s]*)?$/.test(url)) throw new Error("JIRA_URL must be an https URL");
	if (!env.JIRA_TOKEN_FILE) throw new Error("JIRA_URL needs JIRA_TOKEN_FILE");
	for (const [name, file] of [["JIRA_TOKEN_FILE", env.JIRA_TOKEN_FILE], ["JIRA_PFX_FILE", env.JIRA_PFX_FILE], ["JIRA_PFX_PASSWORD_FILE", env.JIRA_PFX_PASSWORD_FILE], ["JIRA_CA_FILE", env.JIRA_CA_FILE]] as const) {
		if (file && !exists(file)) throw new Error(`${name} does not exist: ${file}`);
	}
	if (env.JIRA_PFX_FILE && !env.JIRA_PFX_PASSWORD_FILE) throw new Error("JIRA_PFX_FILE needs JIRA_PFX_PASSWORD_FILE (an empty file for a certificate without a password)");
	const projects = list(env.JIRA_PROJECTS ?? "SAD").map((key) => key.toUpperCase());
	if (projects.length === 0) throw new Error("JIRA_PROJECTS must name at least one project key");
	for (const key of projects) if (!PROJECT.test(key)) throw new Error(`JIRA_PROJECTS holds something that is not a project key: ${key.slice(0, 20)}`);
	const language = (env.TRIAGE_LANGUAGE || "en").toLowerCase();
	if (!(LANGUAGES as readonly string[]).includes(language)) throw new Error(`TRIAGE_LANGUAGE must be one of ${LANGUAGES.join(", ")}`);
	const markerLabel = label(env, "JIRA_TRIAGE_LABEL", "triaged-by-bot");
	const needsInfoLabel = label(env, "JIRA_NEEDS_INFO_LABEL", "needs-info");
	const botCreatedLabel = label(env, "JIRA_BOT_CREATED_LABEL", "created-by-bot");
	if (new Set([markerLabel, needsInfoLabel, botCreatedLabel]).size !== 3) throw new Error("the three labels (JIRA_TRIAGE_LABEL, JIRA_NEEDS_INFO_LABEL, JIRA_BOT_CREATED_LABEL) must differ");
	const developerAgent = (env.TRIAGE_DEVELOPER_AGENT || "agent/pi-agent").trim();
	if (!/^agent\/[a-z0-9][a-z0-9._-]*$/.test(developerAgent)) throw new Error("TRIAGE_DEVELOPER_AGENT must be an agent id like agent/pi-agent");
	const mode = (env.TRIAGE_MODE || "labels").trim().toLowerCase();
	if (mode !== "labels" && mode !== "checklist") throw new Error("TRIAGE_MODE must be labels or checklist");
	const areaLabels = list(env.TRIAGE_AREA_LABELS ?? "Backend,Frontend,Infrastructure,Security");
	if (areaLabels.length === 0) throw new Error("TRIAGE_AREA_LABELS must name at least one label");
	for (const name of areaLabels) if (!LABEL.test(name)) throw new Error(`TRIAGE_AREA_LABELS holds something that is not a Jira label: ${name.slice(0, 20)}`);
	if (new Set(areaLabels.map((name) => name.toLowerCase())).size !== areaLabels.length) throw new Error("TRIAGE_AREA_LABELS must not repeat a label");
	if (areaLabels.some((name) => [markerLabel, needsInfoLabel, botCreatedLabel].some((other) => other.toLowerCase() === name.toLowerCase()))) throw new Error("TRIAGE_AREA_LABELS must not hold one of the bot's own labels");
	const quietMinutes = minutes(env, "TRIAGE_QUIET_MINUTES", 10, 24 * 60);
	const quietMaxMinutes = Math.max(quietMinutes, minutes(env, "TRIAGE_QUIET_MAX_MINUTES", 60, 24 * 60));
	const botUser = env.JIRA_BOT_USER?.trim();
	if (botUser && !/^[A-Za-z0-9._@-]{1,100}$/.test(botUser)) throw new Error("JIRA_BOT_USER must be a Jira user name");
	const createTypes = list(env.TRIAGE_CREATE_TYPES ?? "Bug,Story,Task,Improvement");
	if (createTypes.length === 0) throw new Error("TRIAGE_CREATE_TYPES must name at least one issue type");
	return {
		jira: { url, tokenFile: env.JIRA_TOKEN_FILE, ...(env.JIRA_PFX_FILE ? { pfxFile: env.JIRA_PFX_FILE } : {}), ...(env.JIRA_PFX_PASSWORD_FILE ? { pfxPasswordFile: env.JIRA_PFX_PASSWORD_FILE } : {}), ...(env.JIRA_CA_FILE ? { caFile: env.JIRA_CA_FILE } : {}) },
		projects,
		markerLabel,
		needsInfoLabel,
		botCreatedLabel,
		language: language as Language,
		mode,
		quietMs: quietMinutes * MINUTE,
		quietMaxMs: quietMaxMinutes * MINUTE,
		areaLabels,
		enrichment: flag(env, "TRIAGE_ENRICH", true),
		developerAgent,
		developerWaitMs: integer(env, "TRIAGE_DEVELOPER_WAIT_MINUTES", 10, 240) * MINUTE,
		developerPollMs: integer(env, "TRIAGE_DEVELOPER_POLL_SECONDS", 20, 600) * 1000,
		reporterWaitMs: integer(env, "TRIAGE_REPORTER_WAIT_HOURS", 48, 24 * 30) * HOUR,
		reporterPollMs: integer(env, "TRIAGE_REPORTER_POLL_MINUTES", 5, 24 * 60) * MINUTE,
		maxRounds: integer(env, "TRIAGE_MAX_ROUNDS", 2, 5),
		retrySchedule: schedule(env.TRIAGE_RETRY_MINUTES),
		maxAttempts: integer(env, "TRIAGE_MAX_ATTEMPTS", 12, 100),
		dryRun: flag(env, "TRIAGE_DRY_RUN", false),
		...(botUser ? { botUser } : {}),
		createTypes,
		dailyCap: integer(env, "TRIAGE_DAILY_CAP", 200),
		slackMembers: list(env.SLACK_ALLOWED_USER_IDS),
		notifyTo: env.EVENTS_NOTIFY_TO || "agent/manager",
		tickMs: integer(env, "TRIAGE_TICK_SECONDS", 15, 3600) * 1000,
	};
}

/** The files behind `JiraSettings`, read once at startup. The values never leave the harness. An empty file (a /dev/null mount) counts as no file. */
export function readJiraSecrets(settings: JiraSettings, read: (path: string) => Buffer = (path) => readFileSync(path)): { token: string; pfx?: Buffer; passphrase?: string; ca?: string } {
	const token = read(settings.tokenFile).toString("utf8").trim();
	if (!token) throw new Error("JIRA_TOKEN_FILE is empty");
	const pfx = settings.pfxFile ? read(settings.pfxFile) : undefined;
	const ca = settings.caFile ? read(settings.caFile).toString("utf8").trim() : "";
	return {
		token,
		...(pfx && pfx.length > 0 ? { pfx } : {}),
		...(settings.pfxPasswordFile ? { passphrase: read(settings.pfxPasswordFile).toString("utf8").replace(/[\r\n]+$/, "") } : {}),
		...(ca ? { ca } : {}),
	};
}

/** Environment for `runAgentService`: the kit's own settings filled in from this role's, without overriding what the deployment set. */
export function roleEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	return {
		...env,
		EVENTS_ENABLED: env.EVENTS_ENABLED ?? "1",
		GIT_AUTHOR_NAME: env.GIT_AUTHOR_NAME ?? "SomeWork Jira triage",
		GIT_AUTHOR_EMAIL: env.GIT_AUTHOR_EMAIL ?? "jira-triage@somework.invalid",
	};
}

import { readFileSync } from "node:fs";
import { HandlerStore, handlersDir, type Log } from "@somework/agent-kit";
import { DEFAULT_TICKET_PATTERN, loadQaLabels } from "./settings.ts";

export const HANDLER = "qa-ticket";
export const TOPICS = ["jira.issue.transitioned", "jira.issue.updated"];
const TEMPLATE = new URL("./handlers/qa-ticket.mjs", import.meta.url);

export interface QaEventSettings {
	/** The status a ticket waits in for verification (`JIRA_TEST_STATUS`). */
	testStatus: string;
	/** A label added to a ticket starts a verification (`JIRA_QA_REQUEST_LABEL`); a ticket that carries the skip label never does (`JIRA_QA_SKIP_LABEL`). */
	requestLabel: string;
	skipLabel: string;
	/** Source of the ticket key pattern (`QA_TICKET_PATTERN`). */
	ticketPattern: string;
	/** The application profile a verification started by an event uses. */
	app: string;
	/** Used when the event names no repository (`CHAT_REPOSITORY_URL`). */
	repositoryUrl?: string;
	/** Verifications the handler starts per day: a flood guard, the service keeps the authoritative counters. */
	submitCapPerDay: number;
	budget: { maxTokens: number; maxMinutes: number };
}

export const EVENT_BUDGET = { maxTokens: 4_000_000, maxMinutes: 180 };

const positive = (env: NodeJS.ProcessEnv, name: string, fallback: number): number => {
	const raw = env[name];
	if (raw === undefined || raw === "") return fallback;
	const value = Number(raw);
	if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive whole number`);
	return value;
};

export function loadQaEventSettings(env: NodeJS.ProcessEnv = process.env): QaEventSettings {
	return {
		testStatus: env.JIRA_TEST_STATUS || "Test",
		...loadQaLabels(env),
		ticketPattern: env.QA_TICKET_PATTERN || DEFAULT_TICKET_PATTERN,
		app: env.QA_EVENT_APP || "local",
		...(env.CHAT_REPOSITORY_URL ? { repositoryUrl: env.CHAT_REPOSITORY_URL } : {}),
		submitCapPerDay: positive(env, "QA_EVENT_CAP_PER_DAY", 40),
		budget: { maxTokens: positive(env, "QA_EVENT_BUDGET_TOKENS", EVENT_BUDGET.maxTokens), maxMinutes: positive(env, "QA_EVENT_BUDGET_MINUTES", EVENT_BUDGET.maxMinutes) },
	};
}

/** The shipped handler with the role's settings written in. */
export function renderHandler(settings: QaEventSettings, template: string = readFileSync(TEMPLATE, "utf8")): string {
	if (!template.includes("__CONFIG__")) throw new Error("the handler template has no __CONFIG__ placeholder");
	return template.replace("__CONFIG__", () => JSON.stringify(settings, null, 1));
}

/**
 * Installs the handler into the agent's handler directory on its first start. A handler that is already there (the live copy, which the
 * operator may have edited) is left alone; `reseed` saves the rendered one as a new version instead (the earlier versions stay).
 */
export function seedHandler(options: { stateDir: string; settings: QaEventSettings; log: Log; reseed?: boolean; template?: string }): { seeded: boolean; version?: number } {
	const store = new HandlerStore(handlersDir(options.stateDir));
	const existing = store.current(HANDLER);
	if (existing && !options.reseed) return { seeded: false, version: existing.version };
	const saved = store.save(HANDLER, renderHandler(options.settings, options.template), TOPICS);
	options.log("info", "qa_handler_seeded", { version: saved.version, hash: saved.hash.slice(0, 12), reseed: options.reseed === true });
	return { seeded: true, version: saved.version };
}

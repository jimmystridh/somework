import { readFileSync } from "node:fs";
import { HandlerStore, handlersDir, type Log } from "@somework/agent-kit";
import type { TriageSettings } from "./settings.ts";

export const HANDLER = "jira";
export const TOPICS = ["jira.issue.created", "jira.issue.updated", "jira.comment.created"];
const TEMPLATE = new URL("../handlers/jira.mjs", import.meta.url);
/** How long after a ticket was created its updates and comments still start a triage job. */
const WATCH_DAYS = 30;

/** The settings the handler needs, as the object written into its source. */
export const handlerConfig = (settings: TriageSettings) => ({ projects: settings.projects, submitCapPerDay: settings.dailyCap, watchDays: WATCH_DAYS, botUser: settings.botUser ?? "", labelsMode: settings.mode === "labels", quietWindowMinutes: Math.ceil(settings.quietMaxMs / 60_000) });

/** The shipped handler with the role's settings written in. */
export function renderHandler(settings: TriageSettings, template: string = readFileSync(TEMPLATE, "utf8")): string {
	if (!template.includes("__CONFIG__")) throw new Error("the handler template has no __CONFIG__ placeholder");
	return template.replace("__CONFIG__", () => JSON.stringify(handlerConfig(settings), null, 1));
}

/**
 * Installs the handler into the agent's handler directory on its first start. A handler that is already there (the live copy, which the
 * operator may have edited) is left alone; `reseed` saves the rendered one as a new version instead (the earlier versions stay).
 */
export function seedHandler(options: { stateDir: string; settings: TriageSettings; log: Log; reseed?: boolean; template?: string }): { seeded: boolean; version?: number } {
	const store = new HandlerStore(handlersDir(options.stateDir));
	const existing = store.current(HANDLER);
	if (existing && !options.reseed) return { seeded: false, version: existing.version };
	const saved = store.save(HANDLER, renderHandler(options.settings, options.template), TOPICS);
	options.log("info", "jira_handler_seeded", { version: saved.version, hash: saved.hash.slice(0, 12), reseed: options.reseed === true });
	return { seeded: true, version: saved.version };
}

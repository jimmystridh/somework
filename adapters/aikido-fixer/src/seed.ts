import { readFileSync } from "node:fs";
import { HandlerStore, handlersDir, type Log } from "@somework/agent-kit";
import { repositoryFullName, type FixerSettings } from "./settings.ts";

export const HANDLER = "aikido";
export const FOLLOWUP_HANDLER = "aikido-followup";
/** The topic of the timers this agent asks the event hub for (its id with the hyphen as an underscore). */
export const FOLLOWUP_TOPIC = "clock.timer.aikido_fixer.due";
/** Tasks the handler submits per day, as a multiple of the daily fix cap: a task that turns out to be skipped (a pull request is already open, the issue is closed) never counts against the cap on the host, so the handler's own count is only a flood guard. */
export const SUBMIT_FACTOR = 5;
const TEMPLATE = new URL("../handlers/aikido.mjs", import.meta.url);
const FOLLOWUP_TEMPLATE = new URL("../handlers/aikido-followup.mjs", import.meta.url);

/** The settings the handler needs, as the object written into its source. */
export const handlerConfig = (settings: FixerSettings) => ({
	repositoryUrl: settings.repositories[0],
	repositoryNames: settings.repositoryNames,
	minSeverity: settings.minSeverity,
	maxAttempts: settings.maxAttemptsPerIssue,
	cooldownMinutes: settings.cooldownMinutes,
	submitCapPerDay: settings.dailyCap * SUBMIT_FACTOR,
	budget: settings.budget,
});

/** The follow-up handler's settings: the checks stop at the end of the configured list. */
export const followUpConfig = (settings: FixerSettings) => ({
	repositoryUrl: settings.repositories[0],
	repositoryName: repositoryFullName(settings.repositories[0]!),
	maxRounds: settings.followUpMinutes.length,
	submitCapPerDay: settings.followUpCapPerDay,
	budget: settings.budget,
});

/** The shipped handler with the role's settings written in. */
export function renderHandler(settings: FixerSettings, template: string = readFileSync(TEMPLATE, "utf8")): string {
	if (!template.includes("__CONFIG__")) throw new Error("the handler template has no __CONFIG__ placeholder");
	return template.replace("__CONFIG__", () => JSON.stringify(handlerConfig(settings), null, 1));
}

export function renderFollowUpHandler(settings: FixerSettings, template: string = readFileSync(FOLLOWUP_TEMPLATE, "utf8")): string {
	if (!template.includes("__CONFIG__")) throw new Error("the follow-up handler template has no __CONFIG__ placeholder");
	return template.replace("__CONFIG__", () => JSON.stringify(followUpConfig(settings), null, 1));
}

/**
 * Installs the handlers into the agent's handler directory on its first start. A handler that is already there (the live copy, which the
 * operator may have edited) is left alone; `reseed` saves the rendered one as a new version instead (the earlier versions stay).
 */
export function seedHandler(options: { stateDir: string; settings: FixerSettings; log: Log; reseed?: boolean; template?: string }): { seeded: boolean; version?: number } {
	const store = new HandlerStore(handlersDir(options.stateDir));
	// the follow-up handler is only useful while follow-ups are on, and installing it costs a handler slot that wakes on timers: leave it out when they are off
	if (options.settings.followUpMinutes.length > 0) {
		const followUp = store.current(FOLLOWUP_HANDLER);
		if (!followUp || options.reseed) {
			const saved = store.save(FOLLOWUP_HANDLER, renderFollowUpHandler(options.settings), [FOLLOWUP_TOPIC]);
			options.log("info", "aikido_handler_seeded", { handler: FOLLOWUP_HANDLER, version: saved.version, hash: saved.hash.slice(0, 12), reseed: options.reseed === true });
		}
	}
	const existing = store.current(HANDLER);
	if (existing && !options.reseed) return { seeded: false, version: existing.version };
	const saved = store.save(HANDLER, renderHandler(options.settings, options.template), ["aikido.*"]);
	options.log("info", "aikido_handler_seeded", { handler: HANDLER, version: saved.version, hash: saved.hash.slice(0, 12), reseed: options.reseed === true });
	return { seeded: true, version: saved.version };
}

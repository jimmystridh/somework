import { readFileSync } from "node:fs";
import { HandlerStore, handlersDir, type Log } from "@somework/agent-kit";
import type { FixerSettings } from "./settings.ts";

export const HANDLER = "aikido";
/** Tasks the handler submits per day, as a multiple of the daily fix cap: a task that turns out to be skipped (a pull request is already open, the issue is closed) never counts against the cap on the host, so the handler's own count is only a flood guard. */
const SUBMIT_FACTOR = 5;
const TEMPLATE = new URL("../handlers/aikido.mjs", import.meta.url);

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

/** The shipped handler with the role's settings written in. */
export function renderHandler(settings: FixerSettings, template: string = readFileSync(TEMPLATE, "utf8")): string {
	if (!template.includes("__CONFIG__")) throw new Error("the handler template has no __CONFIG__ placeholder");
	return template.replace("__CONFIG__", () => JSON.stringify(handlerConfig(settings), null, 1));
}

/**
 * Installs the handler into the agent's handler directory on its first start. A handler that is already there (the live copy, which the
 * operator may have edited) is left alone; `reseed` saves the rendered one as a new version instead (the earlier versions stay).
 */
export function seedHandler(options: { stateDir: string; settings: FixerSettings; log: Log; reseed?: boolean; template?: string }): { seeded: boolean; version?: number } {
	const store = new HandlerStore(handlersDir(options.stateDir));
	const existing = store.current(HANDLER);
	if (existing && !options.reseed) return { seeded: false, version: existing.version };
	const saved = store.save(HANDLER, renderHandler(options.settings, options.template), ["aikido.*"]);
	options.log("info", "aikido_handler_seeded", { version: saved.version, hash: saved.hash.slice(0, 12), reseed: options.reseed === true });
	return { seeded: true, version: saved.version };
}

import { readFileSync } from "node:fs";
import { HandlerStore, handlersDir, type Log } from "@somework/agent-kit";
import type { TriageSettings } from "./settings.ts";

export const HANDLER = "datadog";
const TEMPLATE = new URL("../handlers/datadog.mjs", import.meta.url);

/** The settings the handler needs, as the object written into its source. */
export const handlerConfig = (settings: TriageSettings) => ({
	minPriority: settings.minPriority,
	monitorIds: settings.monitorIds,
	ignoreMonitorIds: settings.ignoreMonitorIds,
	ignoreNames: settings.ignoreNames,
	requirePriority: settings.requirePriority,
	tagFilter: settings.tagFilter,
	ignoreWarn: settings.ignoreWarn,
	cooldownMinutes: settings.cooldownMinutes,
	dailyCap: settings.dailyCap,
	windowMinutes: settings.windowMinutes,
	budget: settings.budget,
});

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
	const saved = store.save(HANDLER, renderHandler(options.settings, options.template), ["datadog.monitor.*"]);
	options.log("info", "datadog_handler_seeded", { version: saved.version, hash: saved.hash.slice(0, 12), reseed: options.reseed === true });
	return { seeded: true, version: saved.version };
}

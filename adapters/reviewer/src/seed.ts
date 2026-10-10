import { readFileSync } from "node:fs";
import { HandlerStore, handlersDir, type Log } from "@somework/agent-kit";

export const HANDLER = "pr-review";
export const TOPICS = ["github.pull_request.opened", "github.pull_request.ready_for_review"];
const TEMPLATE = new URL("./handlers/pr-review.mjs", import.meta.url);

export interface ReviewEventSettings {
	/** Repositories (`owner/name`, lower case) whose pull requests are reviewed; empty means every repository the events come from. */
	repositories: string[];
	/** Reviews the handler starts per day: a flood guard, the service keeps the authoritative counters. */
	submitCapPerDay: number;
	budget: { maxTokens: number; maxMinutes: number };
}

const positive = (env: NodeJS.ProcessEnv, name: string, fallback: number): number => {
	const raw = env[name];
	if (raw === undefined || raw === "") return fallback;
	const value = Number(raw);
	if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive whole number`);
	return value;
};

export function loadReviewEventSettings(env: NodeJS.ProcessEnv = process.env): ReviewEventSettings {
	return {
		repositories: (env.REVIEW_REPOSITORIES ?? "").split(/[\s,]+/).map((name) => name.trim().toLowerCase()).filter(Boolean),
		submitCapPerDay: positive(env, "REVIEW_CAP_PER_DAY", 100),
		budget: { maxTokens: positive(env, "REVIEW_BUDGET_TOKENS", 200_000), maxMinutes: positive(env, "REVIEW_BUDGET_MINUTES", 20) },
	};
}

/** The shipped handler with the role's settings written in. */
export function renderHandler(settings: ReviewEventSettings, template: string = readFileSync(TEMPLATE, "utf8")): string {
	if (!template.includes("__CONFIG__")) throw new Error("the handler template has no __CONFIG__ placeholder");
	return template.replace("__CONFIG__", () => JSON.stringify(settings, null, 1));
}

/**
 * Installs the handler into the agent's handler directory on its first start. A handler that is already there (the live copy, which the
 * operator may have edited) is left alone; `reseed` saves the rendered one as a new version instead (the earlier versions stay).
 */
export function seedHandler(options: { stateDir: string; settings: ReviewEventSettings; log: Log; reseed?: boolean; template?: string }): { seeded: boolean; version?: number } {
	const store = new HandlerStore(handlersDir(options.stateDir));
	const existing = store.current(HANDLER);
	if (existing && !options.reseed) return { seeded: false, version: existing.version };
	const saved = store.save(HANDLER, renderHandler(options.settings, options.template), TOPICS);
	options.log("info", "reviewer_handler_seeded", { version: saved.version, hash: saved.hash.slice(0, 12), reseed: options.reseed === true });
	return { seeded: true, version: saved.version };
}

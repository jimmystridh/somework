import type { Budget } from "../runtime.ts";
import type { Decision, DecisionAction, HandlerEvent } from "./types.ts";

export const TOPIC_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+){2,}$/;
const ACTIONS: readonly DecisionAction[] = ["drop", "deliver", "wake", "submit", "notify", "rewrite"];
const KEYS_BY_ACTION: Record<DecisionAction, readonly string[]> = {
	drop: ["action", "reason"],
	deliver: ["action", "reason"],
	wake: ["action", "reason", "tier", "prompt"],
	submit: ["action", "reason", "task"],
	notify: ["action", "reason", "message"],
	rewrite: ["action", "reason", "event"],
};
const MAX_REASON = 500;
const MAX_PROMPT = 4000;
const MAX_MESSAGE = 2000;
const MAX_EVENT_DATA_BYTES = 64 * 1024;

export interface DecisionRules {
	submitBudgetCap: Budget;
	/** Lowest to highest. A rewrite may keep the classification or move to a lower level on this list. */
	classificationLevels: readonly string[];
}

export type Parsed = { ok: true; decision: Decision } | { ok: false; error: string };

const bad = (error: string): Parsed => ({ ok: false, error });
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Strict: unknown keys, wrong types and out-of-range values are all rejected rather than repaired. */
export function parseDecision(raw: unknown, event: HandlerEvent, rules: DecisionRules): Parsed {
	if (!isRecord(raw)) return bad("the decision must be a JSON object");
	const action = raw.action;
	if (typeof action !== "string" || !ACTIONS.includes(action as DecisionAction)) return bad(`action must be one of ${ACTIONS.join(", ")}`);
	const allowed = KEYS_BY_ACTION[action as DecisionAction];
	const stray = Object.keys(raw).filter((key) => !allowed.includes(key));
	if (stray.length > 0) return bad(`${action} does not take: ${stray.join(", ")}`);
	if (raw.reason !== undefined && (typeof raw.reason !== "string" || raw.reason.length > MAX_REASON)) return bad(`reason must be a string of at most ${MAX_REASON} characters`);
	const decision: Decision = { action: action as DecisionAction, ...(raw.reason === undefined ? {} : { reason: raw.reason as string }) };

	switch (decision.action) {
		case "drop":
		case "deliver":
			return { ok: true, decision };
		case "wake": {
			if (raw.tier !== undefined && raw.tier !== "default" && raw.tier !== "small") return bad('tier must be "default" or "small"');
			if (raw.prompt !== undefined && (typeof raw.prompt !== "string" || raw.prompt.length > MAX_PROMPT)) return bad(`prompt must be a string of at most ${MAX_PROMPT} characters`);
			return { ok: true, decision: { ...decision, ...(raw.tier === undefined ? {} : { tier: raw.tier as "default" | "small" }), ...(raw.prompt === undefined ? {} : { prompt: raw.prompt as string }) } };
		}
		case "notify":
			if (typeof raw.message !== "string" || raw.message.trim() === "" || raw.message.length > MAX_MESSAGE) return bad(`message must be a non-empty string of at most ${MAX_MESSAGE} characters`);
			return { ok: true, decision: { ...decision, message: raw.message } };
		case "submit": {
			const task = raw.task;
			if (!isRecord(task)) return bad("task must be an object");
			const unknown = Object.keys(task).filter((key) => !["capability", "input", "budget"].includes(key));
			if (unknown.length > 0) return bad(`task does not take: ${unknown.join(", ")}`);
			const capability = task.capability;
			if (!isRecord(capability) || typeof capability.id !== "string" || capability.id === "" || (typeof capability.version !== "string" && typeof capability.version !== "number")) return bad("task.capability must be {id, version}");
			if (!isRecord(task.input)) return bad("task.input must be an object");
			let budget: Budget | undefined;
			if (task.budget !== undefined) {
				const b = task.budget;
				if (!isRecord(b) || !(Number(b.maxTokens) > 0) || !(Number(b.maxMinutes) > 0)) return bad("task.budget must be {maxTokens, maxMinutes} with positive numbers");
				budget = { maxTokens: Math.min(Number(b.maxTokens), rules.submitBudgetCap.maxTokens), maxMinutes: Math.min(Number(b.maxMinutes), rules.submitBudgetCap.maxMinutes) };
			}
			return { ok: true, decision: { ...decision, task: { capability: { id: capability.id, version: String(capability.version) }, input: task.input, ...(budget ? { budget } : {}) } } };
		}
		case "rewrite": {
			const patch = raw.event;
			if (!isRecord(patch)) return bad("event must be an object");
			const unknown = Object.keys(patch).filter((key) => !["topic", "data", "classification"].includes(key));
			if (unknown.length > 0) return bad(`a rewrite may only change topic, data and classification, not: ${unknown.join(", ")}`);
			if (patch.topic !== undefined) {
				if (typeof patch.topic !== "string" || !TOPIC_PATTERN.test(patch.topic) || patch.topic.length > 200) return bad("event.topic is not a valid topic");
				if (patch.topic.split(".")[0] !== event.topic.split(".")[0]) return bad("a rewrite cannot change the topic prefix (the source)");
			}
			if (patch.classification !== undefined) {
				const levels = rules.classificationLevels;
				const from = levels.indexOf(event.classification);
				const to = typeof patch.classification === "string" ? levels.indexOf(patch.classification) : -1;
				if (to < 0 || from < 0) return bad("event.classification must be a known level and the event's own level must be known");
				if (to > from) return bad("a rewrite cannot raise the classification");
			}
			if (patch.data !== undefined && Buffer.byteLength(JSON.stringify(patch.data) ?? "null") > MAX_EVENT_DATA_BYTES) return bad("event.data is larger than 64 KiB");
			return { ok: true, decision: { ...decision, event: patch as Decision["event"] } };
		}
	}
}

/** The event as it continues through the chain after a rewrite. Identity, source, key, trust and lineage never change. */
export function applyRewrite(event: HandlerEvent, patch: NonNullable<Decision["event"]>): HandlerEvent {
	return { ...event, ...(patch.topic === undefined ? {} : { topic: patch.topic }), ...(patch.data === undefined ? {} : { data: patch.data }), ...(patch.classification === undefined ? {} : { classification: patch.classification }) };
}
